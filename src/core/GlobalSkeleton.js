import * as THREE from 'three';
import { clamp01, distance3D, quaternionToEuler, swingRotation } from '../utils/MathUtils.js';
import { solveTwoBoneIK } from './TwoBoneIK.js';
import { pushOutOfTorso, DEFAULT_TORSO_RADIUS } from './CollisionAvoidance.js';

// Indices des landmarks de pose utilisés (schéma à 33 points de
// PoseLandmarker / BlazePose). Côtés anatomiques.
const POSE = {
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

// Indices des landmarks de main (schéma à 21 points de HandLandmarker).
const HAND = {
  wrist: 0,
  middleMcp: 9,
};

// Directions de repos des os normalisés VRM. Le squelette normalisé de
// three-vrm est en T-pose, avatar tourné vers +Z, axes alignés sur le monde :
// bras gauche de l'avatar vers +X, bras droit vers -X, colonne et cou vers
// +Y, jambes vers -Y. Chaque rotation est calculée comme la rotation
// minimale amenant cette direction sur la direction observée.
const REST = {
  up: new THREE.Vector3(0, 1, 0),
  down: new THREE.Vector3(0, -1, 0),
  left: new THREE.Vector3(1, 0, 0),
  right: new THREE.Vector3(-1, 0, 0),
};

// Sous ce seuil de visibilité (genoux, chevilles), les jambes sont
// considérées hors champ en cadrage automatique.
const LEG_VISIBILITY_THRESHOLD = 0.5;

const ZERO = () => ({ x: 0, y: 0, z: 0 });

// Convertit un landmark « world » MediaPipe (m, origine au centre des
// hanches ; x vers la droite de l'image, y vers le bas, z s'éloignant de la
// caméra) dans le repère de l'avatar (y vers le haut, avatar tourné vers +Z,
// c'est-à-dire vers la caméra). Inverser y et z revient à une rotation de
// 180° autour de X : le repère reste direct. La personne faisant face à la
// caméra, son côté gauche est à droite de l'image (+x), comme le bras gauche
// de l'avatar (+X). En miroir, x est inversé (et les côtés échangés par
// l'appelant).
function toAvatarSpace(p, mirror) {
  return { x: mirror ? -p.x : p.x, y: -p.y, z: -p.z, visibility: p.visibility };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function direction(from, to) {
  return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

// Construit, à partir d'une détection (lissée), la pose { [os]: {x,y,z} }
// (rotations locales Euler XYZ des os normalisés VRM) ∪ { [canalVisage]: {x} }.
export class GlobalSkeletonBuilder {
  constructor() {
    // Rayon de la capsule du torse (m), réglable dans le panneau droit.
    this.torsoRadius = DEFAULT_TORSO_RADIUS;

    // Longueurs de segment calibrées progressivement (moyenne mobile lente),
    // en mètres. Servent de longueurs fixes à l'IK à deux os : ça évite
    // qu'une distance de segment bruitée une frame donnée ne fausse l'angle
    // de flexion calculé. Indexées par côté de l'avatar.
    this.boneLengths = {
      leftUpperArm: null,
      leftLowerArm: null,
      rightUpperArm: null,
      rightLowerArm: null,
      leftUpperLeg: null,
      leftLowerLeg: null,
      rightUpperLeg: null,
      rightLowerLeg: null,
    };
  }

  #calibrateLength(key, measured) {
    const CALIBRATION_ALPHA = 0.05;
    const current = this.boneLengths[key];
    this.boneLengths[key] = current === null ? measured : current + (measured - current) * CALIBRATION_ALPHA;
    return this.boneLengths[key];
  }

  // `detection` : détection lissée (DetectionSmoother), au format commun
  // décrit dans tracking/detectors.js (côtés anatomiques).
  // `options` : { mirror: bool, framing: 'auto' | 'seated' | 'standing' }.
  build(detection, { mirror = true, framing = 'auto' } = {}) {
    const pose = {};
    if (detection.pose) {
      this.#buildBody(detection.pose.world, detection.hands ?? {}, pose, mirror, framing);
    }
    if (detection.face?.blendshapes) {
      this.#buildFaceChannels(detection.face.blendshapes, pose, mirror);
    }
    return pose;
  }

  #buildBody(world, hands, pose, mirror, framing) {
    // Côté anatomique de la personne qui pilote un côté donné de l'avatar :
    // en miroir, la main gauche de la personne anime la main droite de
    // l'avatar (même côté de l'écran que dans un miroir).
    const source = (avatarSide) => (mirror ? (avatarSide === 'left' ? 'right' : 'left') : avatarSide);
    const at = (name, avatarSide) => toAvatarSpace(world[POSE[`${source(avatarSide)}${name}`]], mirror);

    const hipMid = midpoint(at('Hip', 'left'), at('Hip', 'right'));
    const shoulderMid = midpoint(at('Shoulder', 'left'), at('Shoulder', 'right'));
    const earMid = midpoint(at('Ear', 'left'), at('Ear', 'right'));

    // --- Tronc : bassin fixe, colonne vers le milieu des épaules, cou vers
    // le milieu des oreilles. Poitrine, clavicules et tête en rotation
    // locale nulle pour l'instant (la tête suivra le visage).
    const hipsWorld = new THREE.Quaternion();
    const spine = swingRotation(REST.up, direction(hipMid, shoulderMid), hipsWorld);
    const neck = swingRotation(REST.up, direction(shoulderMid, earMid), spine.world);
    pose.hips = ZERO();
    pose.spine = quaternionToEuler(spine.local);
    pose.chest = ZERO();
    pose.neck = quaternionToEuler(neck.local);
    pose.head = ZERO();
    pose.leftShoulder = ZERO();
    pose.rightShoulder = ZERO();

    // --- Bras (parent : colonne, la poitrine et la clavicule étant à zéro).
    for (const side of ['left', 'right']) {
      const shoulder = at('Shoulder', side);
      const elbow = at('Elbow', side);
      const wrist = at('Wrist', side);
      const target = pushOutOfTorso(wrist, shoulderMid, hipMid, this.torsoRadius);
      const arm = this.#solveLimb(`${side}UpperArm`, `${side}LowerArm`, shoulder, elbow, target, REST[side], spine.world);
      pose[`${side}UpperArm`] = quaternionToEuler(arm.upper.local);
      pose[`${side}LowerArm`] = quaternionToEuler(arm.lower.local);

      // Main : HandLandmarker (poignet → base du majeur) si la main est
      // détectée, sinon repli sur la pose (poignet → index).
      const hand = hands[source(side)];
      const handDirection = hand
        ? direction(toAvatarSpace(hand.world[HAND.wrist], mirror), toAvatarSpace(hand.world[HAND.middleMcp], mirror))
        : direction(wrist, at('Index', side));
      pose[`${side}Hand`] = quaternionToEuler(swingRotation(REST[side], handDirection, arm.lower.world).local);
    }

    // --- Jambes (parent : bassin), figées en pose de repos si hors champ.
    const legsTracked =
      framing === 'standing' ||
      (framing === 'auto' &&
        ['Knee', 'Ankle'].every((name) =>
          ['left', 'right'].every((side) => (at(name, side).visibility ?? 1) >= LEG_VISIBILITY_THRESHOLD),
        ));
    for (const side of ['left', 'right']) {
      if (!legsTracked) {
        pose[`${side}UpperLeg`] = ZERO();
        pose[`${side}LowerLeg`] = ZERO();
      } else {
        const leg = this.#solveLimb(
          `${side}UpperLeg`,
          `${side}LowerLeg`,
          at('Hip', side),
          at('Knee', side),
          at('Ankle', side),
          REST.down,
          hipsWorld,
        );
        pose[`${side}UpperLeg`] = quaternionToEuler(leg.upper.local);
        pose[`${side}LowerLeg`] = quaternionToEuler(leg.lower.local);
      }
      // Pas de landmark de pied exploité : rotation nulle relative au tibia.
      pose[`${side}Foot`] = ZERO();
    }
  }

  // Membre à deux os (bras ou jambe) par IK analytique : la racine et la
  // cible pilotent l'angle de flexion, le landmark intermédiaire ne sert
  // qu'à choisir le plan de flexion. Chaque segment est ensuite converti en
  // rotation locale dans le repère de son parent.
  #solveLimb(upperKey, lowerKey, root, hint, target, restDirection, parentWorld) {
    const upperLength = this.#calibrateLength(upperKey, distance3D(root, hint));
    const lowerLength = this.#calibrateLength(lowerKey, distance3D(hint, target));
    const { upperDirection, lowerDirection } = solveTwoBoneIK({ root, hint, target, upperLength, lowerLength });
    const upper = swingRotation(restDirection, upperDirection, parentWorld);
    const lower = swingRotation(restDirection, lowerDirection, upper.world);
    return { upper, lower };
  }

  #buildFaceChannels(blendshapes, pose, mirror) {
    const score = (name) => blendshapes[name] ?? 0;
    // Les blendshapes sont anatomiques ; en miroir, l'œil gauche de la
    // personne anime l'œil droit de l'avatar, comme pour les membres.
    const [eyeA, eyeB] = mirror ? ['Right', 'Left'] : ['Left', 'Right'];

    pose.leftEyeBlink = { x: clamp01(score(`eyeBlink${eyeA}`)) };
    pose.rightEyeBlink = { x: clamp01(score(`eyeBlink${eyeB}`)) };
    pose.leftEyebrowRaise = { x: clamp01((score(`browOuterUp${eyeA}`) + score('browInnerUp')) / 2) };
    pose.rightEyebrowRaise = { x: clamp01((score(`browOuterUp${eyeB}`) + score('browInnerUp')) / 2) };
    pose.mouthOpen = { x: clamp01(score('jawOpen')) };
    pose.mouthWide = { x: clamp01((score('mouthStretchLeft') + score('mouthStretchRight')) / 2) };
  }
}
