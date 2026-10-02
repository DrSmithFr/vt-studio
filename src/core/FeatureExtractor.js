import * as THREE from 'three';
import { clamp01, distance3D, swingRotation } from '../utils/MathUtils.js';
import { solveTwoBoneIK } from './TwoBoneIK.js';
import { pushOutOfTorso, DEFAULT_TORSO_RADIUS } from './CollisionAvoidance.js';
import { CALIBRATED_KEYS, FINGER_KEYS, fingerFeatureKey } from './FeatureSchema.js';

// Extraction des valeurs relatives (voir FeatureSchema) à partir d'une
// détection lissée. Toute la géométrie liée aux landmarks est ici ; la
// reconstruction du squelette (KeyPoseBuilder) ne voit que ces valeurs.
//
// Repère de l'avatar : y vers le haut, avatar tourné vers +Z (vers la
// caméra), son côté gauche vers +X (T-pose VRM 1.0 normalisée).

// Landmarks de pose (schéma BlazePose à 33 points), côtés anatomiques.
const POSE = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

// Landmarks de main (21 points) : chaîne base → bout pour chaque doigt.
const HAND_WRIST = 0;
const FINGER_CHAINS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  little: [17, 18, 19, 20],
};

// Landmarks du maillage de visage utilisés pour l'orientation de la tête :
// coins externes des yeux (droit anatomique, gauche anatomique), haut du
// front, menton.
const FACE = { rightEyeOuter: 33, leftEyeOuter: 263, forehead: 10, chin: 152 };

const REST_ARM = { left: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(-1, 0, 0) };
const PALM_SIDE = new THREE.Vector3(0, -1, 0);
const THUMB_SIDE = new THREE.Vector3(0, 0, 1);

// Sous ce seuil de visibilité (genoux, chevilles), les jambes sont
// considérées hors champ en cadrage automatique.
const LEG_VISIBILITY_THRESHOLD = 0.5;

const SIDES = ['left', 'right'];
const sideSign = (side) => (side === 'left' ? 1 : -1);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Convertit un point ou un vecteur MediaPipe (x vers la droite de l'image,
// y vers le bas, z s'éloignant de la caméra) dans le repère de l'avatar.
// Inverser y et z est une rotation de 180° autour de X (repère direct). La
// personne faisant face à la caméra, son côté gauche est à droite de l'image
// (+x) comme le côté gauche de l'avatar (+X). En miroir, x est inversé et
// l'appelant échange les côtés.
function toAvatar(p, mirror) {
  return new THREE.Vector3(mirror ? -p.x : p.x, -p.y, -p.z);
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const vec = (p) => new THREE.Vector3(p.x, p.y, p.z);

// Lacet d'un vecteur gauche→droite autour de +Y (0 quand il pointe vers +X).
const yawOf = (v) => Math.atan2(-v.z, v.x);

// Rotations du tronc à partir des valeurs relatives, partagées avec
// KeyPoseBuilder pour que les bras soient mesurés et reconstruits dans le
// même repère. Inclinaison, avant/arrière et rotation de la colonne sont
// répartis à parts égales entre spine et chest.
export function torsoQuaternions(values) {
  const half = (angle) => (angle ?? 0) / 2;
  const segment = () =>
    new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), half(values.spineLean))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), half(values.spineAngle)))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), half(values.spineTwist)));
  const hips = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), values.pelvisYaw ?? 0);
  const spine = segment();
  const chest = segment();
  return { hips, spine, chest, chestWorld: hips.clone().multiply(spine).multiply(chest) };
}

// Repère de la paume dans l'espace où sont exprimés les points (MediaPipe :
// x droite de l'image, y bas, z s'éloignant) : f = vers les doigts, s = vers
// le pouce, n = côté paume. Le produit vectoriel f × s pointe côté paume
// pour une main gauche anatomique et côté dos pour une main droite.
// Vérification : main droite levée, paume face caméra, doigts vers le haut
// → f = (0,-1,0) ; le pouce est côté médial, vers la gauche de la personne,
// donc à droite de l'image : s = (1,0,0) ; f × s = (0,0,1) s'éloigne de la
// caméra, c'est le dos de la main.
function palmFrame(wrist, indexBase, littleBase, anatomicalSide) {
  const f = vec(sub(mid(indexBase, littleBase), wrist)).normalize();
  const s = vec(sub(indexBase, littleBase));
  s.addScaledVector(f, -s.dot(f)).normalize();
  const n = new THREE.Vector3().crossVectors(f, s).multiplyScalar(anatomicalSide === 'left' ? 1 : -1);
  return { f, s, n };
}

// Rotation monde (repère avatar) d'une main dont la paume a le repère
// { f, n } (déjà converti), pour le côté `avatarSide`. Repos : doigts vers
// ±X, paume vers -Y, pouce vers +Z.
function handWorldRotation(f, n, avatarSide) {
  const a = REST_ARM[avatarSide];
  const b = PALM_SIDE;
  const c = THUMB_SIDE;
  const fo = f.clone().normalize();
  const no = n.clone().addScaledVector(fo, -n.dot(fo)).normalize();
  // Même relation entre les trois axes qu'au repos, pour obtenir une
  // rotation propre (c = ∓ a × b selon le côté).
  const co = new THREE.Vector3().crossVectors(fo, no).multiplyScalar(avatarSide === 'left' ? -1 : 1);
  const observed = new THREE.Matrix4().makeBasis(fo, no, co);
  const rest = new THREE.Matrix4().makeBasis(a, b, c);
  return new THREE.Quaternion().setFromRotationMatrix(observed.multiply(rest.transpose()));
}

const angleBetween = (a, b) => vec(a).angleTo(vec(b));

export class FeatureExtractor {
  constructor() {
    this.torsoRadius = DEFAULT_TORSO_RADIUS;
    // Longueurs de segment de la personne, calibrées progressivement
    // (moyenne mobile lente) : longueurs fixes de l'IK, insensibles au bruit
    // d'une frame donnée.
    this.boneLengths = {};
  }

  #calibrateLength(key, measured) {
    const ALPHA = 0.05;
    const current = this.boneLengths[key];
    this.boneLengths[key] = current === undefined ? measured : current + (measured - current) * ALPHA;
    return this.boneLengths[key];
  }

  // `detection` : détection lissée (format commun, côtés anatomiques).
  // `options` : { mirror, aspect (largeur / hauteur de la vidéo), framing,
  //               calibration: { body, hands } (valeurs de référence) }.
  // Renvoie { raw, values, has, expressions } : `raw` avant calibration
  // (sert à capturer une calibration), `values` après.
  extract(detection, { mirror = true, aspect = 16 / 9, framing = 'auto', calibration = {} } = {}) {
    const raw = {};
    const has = { body: false, face: false, left: false, right: false, legs: false };
    // Côté anatomique qui pilote un côté de l'avatar.
    const source = (avatarSide) => (mirror ? (avatarSide === 'left' ? 'right' : 'left') : avatarSide);

    let chestWorld = null;
    if (detection.pose) {
      chestWorld = this.#extractBody(detection.pose, detection.hands ?? {}, raw, has, { mirror, framing, source });
    }
    if (detection.face?.screen) {
      this.#extractHead(detection.face.screen, raw, has, { mirror, aspect, chestWorld });
    }
    for (const side of SIDES) {
      const hand = detection.hands?.[source(side)];
      if (hand) {
        this.#extractFingers(hand.world, source(side), side, raw);
        has[side] = true;
      }
    }

    const values = { ...raw };
    for (const group of ['body', 'hands']) {
      const reference = calibration[group];
      if (!reference) continue;
      for (const key of CALIBRATED_KEYS[group]) {
        if (values[key] !== undefined && reference[key] !== undefined) {
          values[key] = key.endsWith('X') || key.endsWith('Y') ? values[key] - reference[key] : wrapAngle(values[key] - reference[key]);
        }
      }
    }

    const expressions = detection.face?.blendshapes ? this.#expressions(detection.face.blendshapes, mirror) : null;
    return { raw, values, has, expressions };
  }

  #extractBody(pose, hands, raw, has, { mirror, framing, source }) {
    const world = pose.world;
    const screen = pose.screen;
    const at = (name, avatarSide) => toAvatar(world[POSE[`${source(avatarSide)}${name}`]], mirror);
    const visibility = (name, avatarSide) => world[POSE[`${source(avatarSide)}${name}`]].visibility ?? 1;
    has.body = true;

    // --- Position à l'écran : bassin (latéral, centré), épaules (vertical).
    raw.pelvisX = ((screen[POSE.leftHip].x + screen[POSE.rightHip].x) / 2 - 0.5) * (mirror ? -1 : 1);
    raw.shouldersY = (screen[POSE.leftShoulder].y + screen[POSE.rightShoulder].y) / 2;

    // --- Tronc.
    const hipL = at('Hip', 'left');
    const hipR = at('Hip', 'right');
    const shL = at('Shoulder', 'left');
    const shR = at('Shoulder', 'right');
    const hipMid = hipL.clone().add(hipR).multiplyScalar(0.5);
    const shoulderMid = shL.clone().add(shR).multiplyScalar(0.5);

    raw.pelvisYaw = yawOf(hipL.clone().sub(hipR));
    const unyaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -raw.pelvisYaw);
    const spineDir = shoulderMid.clone().sub(hipMid).applyQuaternion(unyaw).normalize();
    raw.spineAngle = Math.atan2(-spineDir.x, spineDir.y);
    raw.spineLean = Math.atan2(spineDir.z, spineDir.y);
    raw.spineTwist = wrapAngle(yawOf(shL.clone().sub(shR)) - raw.pelvisYaw);

    // Repère réel de la poitrine (valeurs non calibrées) : les bras y sont
    // mesurés, ils sont donc relatifs au corps et non à la caméra.
    const { chestWorld, hips } = torsoQuaternions(raw);
    const chestInverse = chestWorld.clone().invert();

    // --- Bras : IK à deux os (racine + cible), puis angles du bras dans le
    // repère de la poitrine, position de la main en longueurs de bras, et
    // orientation complète du poignet relative à l'avant-bras.
    for (const side of SIDES) {
      const shoulder = at('Shoulder', side);
      const elbow = at('Elbow', side);
      const wrist = at('Wrist', side);
      const target = vec(pushOutOfTorso(wrist, shoulderMid, hipMid, this.torsoRadius));
      const upperLength = this.#calibrateLength(`${side}UpperArm`, distance3D(shoulder, elbow));
      const lowerLength = this.#calibrateLength(`${side}LowerArm`, distance3D(elbow, target));
      const ik = solveTwoBoneIK({ root: shoulder, hint: elbow, target, upperLength, lowerLength });

      const upper = vec(ik.upperDirection).applyQuaternion(chestInverse).normalize();
      raw[`${side}ArmElevation`] = Math.asin(THREE.MathUtils.clamp(upper.y, -1, 1));
      raw[`${side}ArmAzimuth`] = Math.atan2(upper.z, sideSign(side) * upper.x);

      const hand = target.clone().sub(shoulder).applyQuaternion(chestInverse).divideScalar(upperLength + lowerLength);
      raw[`${side}HandX`] = hand.x;
      raw[`${side}HandY`] = hand.y;
      raw[`${side}HandZ`] = hand.z;

      // Avant-bras reconstruit comme le fera KeyPoseBuilder, pour que
      // l'orientation du poignet soit exprimée dans le même repère.
      const upperArm = swingRotation(REST_ARM[side], ik.upperDirection, chestWorld);
      const lowerArm = swingRotation(REST_ARM[side], ik.lowerDirection, upperArm.world);

      // Paume : HandLandmarker si la main est détectée (plus précis), sinon
      // repère approximatif tiré de la pose (poignet, index, auriculaire).
      const detectedHand = hands[source(side)];
      const frame = detectedHand
        ? palmFrame(detectedHand.world[HAND_WRIST], detectedHand.world[FINGER_CHAINS.index[0]], detectedHand.world[FINGER_CHAINS.little[0]], source(side))
        : palmFrame(
            world[POSE[`${source(side)}Wrist`]],
            world[POSE[`${source(side)}Index`]],
            world[POSE[`${source(side)}Pinky`]],
            source(side),
          );
      const handWorld = handWorldRotation(toAvatar(frame.f, mirror), toAvatar(frame.n, mirror), side);
      const handLocal = lowerArm.world.clone().invert().multiply(handWorld);
      const euler = new THREE.Euler().setFromQuaternion(handLocal, 'XYZ');
      raw[`${side}HandTwist`] = euler.x;
      raw[`${side}HandDeviation`] = euler.y;
      raw[`${side}HandFlex`] = euler.z;
    }

    // --- Jambes, dans le repère du bassin : tangage et roulis de la cuisse,
    // flexion du genou. Seulement si elles sont suivies (cadrage).
    has.legs =
      framing === 'standing' ||
      (framing === 'auto' &&
        ['Knee', 'Ankle'].every((name) => SIDES.every((side) => visibility(name, side) >= LEG_VISIBILITY_THRESHOLD)));
    if (has.legs) {
      const hipsInverse = hips.clone().invert();
      for (const side of SIDES) {
        const hip = at('Hip', side);
        const knee = at('Knee', side);
        const ankle = at('Ankle', side);
        const upperLength = this.#calibrateLength(`${side}UpperLeg`, distance3D(hip, knee));
        const lowerLength = this.#calibrateLength(`${side}LowerLeg`, distance3D(knee, ankle));
        const ik = solveTwoBoneIK({ root: hip, hint: knee, target: ankle, upperLength, lowerLength });
        const thigh = vec(ik.upperDirection).applyQuaternion(hipsInverse).normalize();
        // Tangage = élévation vers l'avant ; roulis = écart dans le plan
        // frontal. Paramétrage exactement inversible (KeyPoseBuilder), même
        // cuisse à l'horizontale (assis, genou levé).
        raw[`${side}LegPitch`] = Math.atan2(thigh.z, Math.hypot(thigh.x, thigh.y));
        raw[`${side}LegRoll`] = Math.atan2(sideSign(side) * thigh.x, -thigh.y);
        raw[`${side}KneeBend`] = vec(ik.upperDirection).angleTo(vec(ik.lowerDirection));
      }
    }

    return chestWorld;
  }

  // Orientation de la tête à partir du maillage du visage (coordonnées
  // écran, z à l'échelle de x) : axe gauche = entre les coins externes des
  // yeux, axe haut = du menton au front. Exprimée relativement à la poitrine
  // si le corps est détecté.
  #extractHead(face, raw, has, { mirror, aspect, chestWorld }) {
    const point = (i) => ({ x: face[i].x * aspect, y: face[i].y, z: face[i].z * aspect });
    // En miroir, l'œil droit de la personne est du côté gauche de l'avatar.
    const left = mirror
      ? sub(point(FACE.rightEyeOuter), point(FACE.leftEyeOuter))
      : sub(point(FACE.leftEyeOuter), point(FACE.rightEyeOuter));
    const x = toAvatar(left, mirror).normalize();
    const up = toAvatar(sub(point(FACE.forehead), point(FACE.chin)), mirror);
    const z = new THREE.Vector3().crossVectors(x, up).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    let head = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    if (chestWorld) head = chestWorld.clone().invert().multiply(head);
    const euler = new THREE.Euler().setFromQuaternion(head, 'YXZ');
    raw.headYaw = euler.y;
    raw.headPitch = euler.x;
    raw.headRoll = euler.z;
    has.face = true;
  }

  // Doigts, dans le repère de la paume (angles indépendants de l'orientation
  // de la main et du miroir) : flexion de la 1re phalange hors du plan de la
  // paume, écart dans le plan (vers le pouce = positif, relatif à la
  // direction du métacarpien), flexion cumulée des phalanges suivantes.
  #extractFingers(hand, anatomicalSide, avatarSide, raw) {
    const { f, s, n } = palmFrame(hand[HAND_WRIST], hand[FINGER_CHAINS.index[0]], hand[FINGER_CHAINS.little[0]], anatomicalSide);
    for (const finger of FINGER_KEYS) {
      const [a, b, c, d] = FINGER_CHAINS[finger].map((i) => hand[i]);
      const d1 = vec(sub(b, a));
      const inPlane = Math.hypot(d1.dot(f), d1.dot(s));
      let spread = Math.atan2(d1.dot(s), d1.dot(f));
      if (finger !== 'thumb') {
        // Écart relatif au métacarpien : un doigt tendu dans son axe naturel
        // a un écart nul, quelle que soit sa position dans la paume.
        const metacarpal = vec(sub(a, hand[HAND_WRIST]));
        spread -= Math.atan2(metacarpal.dot(s), metacarpal.dot(f));
      }
      raw[fingerFeatureKey(avatarSide, finger, 'baseFlex')] = Math.atan2(d1.dot(n), inPlane);
      raw[fingerFeatureKey(avatarSide, finger, 'baseSpread')] = spread;
      raw[fingerFeatureKey(avatarSide, finger, 'tipFlex')] = angleBetween(sub(b, a), sub(c, b)) + angleBetween(sub(c, b), sub(d, c));
    }
  }

  // Canaux d'expression (0-1) à partir des blendshapes. En miroir, l'œil
  // gauche de la personne anime l'œil droit de l'avatar.
  #expressions(blendshapes, mirror) {
    const score = (name) => blendshapes[name] ?? 0;
    const [eyeA, eyeB] = mirror ? ['Right', 'Left'] : ['Left', 'Right'];
    return {
      leftEyeBlink: { x: clamp01(score(`eyeBlink${eyeA}`)) },
      rightEyeBlink: { x: clamp01(score(`eyeBlink${eyeB}`)) },
      leftEyebrowRaise: { x: clamp01((score(`browOuterUp${eyeA}`) + score('browInnerUp')) / 2) },
      rightEyebrowRaise: { x: clamp01((score(`browOuterUp${eyeB}`) + score('browInnerUp')) / 2) },
      mouthOpen: { x: clamp01(score('jawOpen')) },
      mouthWide: { x: clamp01((score('mouthStretchLeft') + score('mouthStretchRight')) / 2) },
    };
  }
}
