import { directionToEuler, clamp01, distance3D } from '../utils/MathUtils.js';
import { solveTwoBoneIK } from './TwoBoneIK.js';
import { pushOutOfTorso } from './CollisionAvoidance.js';

// Indices des landmarks de pose utilisés (schéma à 33 points de
// PoseLandmarker / BlazePose). Voir la documentation MediaPipe Tasks Vision
// pour le schéma complet.
const POSE = {
  nose: 0,
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
  indexMcp: 5,
  middleMcp: 9,
};

// Direction de repos (bras le long du corps, jambes vers le bas) utilisée
// comme référence pour dériver chaque rotation. Voir MathUtils.directionToEuler.
const REST_DOWN = { x: 0, y: -1, z: 0 };
const REST_FORWARD = { x: 0, y: 0, z: -1 };

// Construit, à partir des résultats bruts d'un cycle de détection, un objet
// pose unique { [nomArticulation]: {x,y,z} } ∪ { [canalVisage]: {x} }.
// C'est cette pose brute qui alimente ensuite le lissage (Smoother) puis le
// retargeting (RetargetConfig).
export class GlobalSkeletonBuilder {
  constructor() {
    // Longueurs de segment calibrées progressivement (moyenne mobile lente)
    // à partir des worldLandmarks, en mètres. Servent de longueurs fixes à
    // l'IK à deux os : ça évite qu'une distance de segment bruitée une
    // frame donnée ne fausse l'angle de flexion calculé.
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

  // `detection` a la forme :
  // {
  //   pose: worldLandmarks[] | null,       // PoseLandmarker
  //   face: { blendshapes } | null,        // FaceLandmarker
  //   hands: { left: {world, screen}|null, right: {world, screen}|null }, // HandLandmarker
  // }
  build(detection) {
    const pose = {};

    if (detection.pose) {
      this.#buildBodyFromPose(detection.pose, pose);
    }

    // Les mains, si détectées, remplacent la rotation de poignet dérivée de
    // la pose : HandLandmarker est bien plus précis sur cette zone.
    if (detection.hands?.left) {
      pose.leftHand = this.#handRotation(detection.hands.left.world);
    }
    if (detection.hands?.right) {
      pose.rightHand = this.#handRotation(detection.hands.right.world);
    }

    if (detection.face?.blendshapes) {
      this.#buildFaceChannels(detection.face.blendshapes, pose);
    }

    return pose;
  }

  #buildBodyFromPose(landmarks, pose) {
    const p = POSE;
    const at = (i) => landmarks[i];

    // La clavicule (leftShoulder/rightShoulder) n'est pas retargetée par IK :
    // son amplitude est faible en pratique et la dériver du même landmark de
    // coude bruité réintroduirait le tremblement que l'IK élimine par
    // ailleurs. Laissée à zéro pour l'instant - extension possible avec un
    // signal plus stable (ex. inclinaison de la ligne des épaules).
    pose.leftShoulder = { x: 0, y: 0, z: 0 };
    pose.rightShoulder = { x: 0, y: 0, z: 0 };

    const hipMid = midpoint(at(p.leftHip), at(p.rightHip));
    const shoulderMid = midpoint(at(p.leftShoulder), at(p.rightShoulder));

    this.#solveLimb({
      pose,
      side: 'left',
      upperJoint: 'leftUpperArm',
      lowerJoint: 'leftLowerArm',
      root: at(p.leftShoulder),
      hint: at(p.leftElbow),
      target: at(p.leftWrist),
      restDirection: REST_DOWN,
      avoidTorso: { shoulderMid, hipMid },
    });
    this.#solveLimb({
      pose,
      side: 'right',
      upperJoint: 'rightUpperArm',
      lowerJoint: 'rightLowerArm',
      root: at(p.rightShoulder),
      hint: at(p.rightElbow),
      target: at(p.rightWrist),
      restDirection: REST_DOWN,
      avoidTorso: { shoulderMid, hipMid },
    });

    // Rotation de repli pour les mains, utilisée si HandLandmarker n'a rien
    // détecté cette frame (voir la substitution dans build()).
    pose.leftHand = directionToEuler(at(p.leftWrist), at(p.leftIndex), REST_DOWN);
    pose.rightHand = directionToEuler(at(p.rightWrist), at(p.rightIndex), REST_DOWN);

    this.#solveLimb({
      pose,
      side: 'left',
      upperJoint: 'leftUpperLeg',
      lowerJoint: 'leftLowerLeg',
      root: at(p.leftHip),
      hint: at(p.leftKnee),
      target: at(p.leftAnkle),
      restDirection: REST_DOWN,
    });
    this.#solveLimb({
      pose,
      side: 'right',
      upperJoint: 'rightUpperLeg',
      lowerJoint: 'rightLowerLeg',
      root: at(p.rightHip),
      hint: at(p.rightKnee),
      target: at(p.rightAnkle),
      restDirection: REST_DOWN,
    });

    // Pas de landmark de pied fiable dans ce sous-ensemble : le pied suit le
    // tibia (rotation nulle relative). Extension possible avec les landmarks
    // 29-32 (talon, orteils).
    pose.leftFoot = { x: 0, y: 0, z: 0 };
    pose.rightFoot = { x: 0, y: 0, z: 0 };

    pose.hips = { x: 0, y: 0, z: 0 };
    pose.spine = directionToEuler(hipMid, shoulderMid, REST_FORWARD);
    pose.chest = pose.spine;
    pose.neck = directionToEuler(shoulderMid, at(p.nose), REST_FORWARD);
    pose.head = pose.neck;
  }

  // Résout un membre à deux os (bras ou jambe) par IK analytique plutôt que
  // par deux rotations de segment indépendantes : la racine et la cible
  // (main/pied) pilotent l'angle de flexion, le landmark intermédiaire
  // (coude/genou) ne sert qu'à choisir le côté de flexion. `avoidTorso`,
  // quand fourni, repousse d'abord la cible hors du buste (bras uniquement).
  #solveLimb({ pose, upperJoint, lowerJoint, root, hint, target, restDirection, avoidTorso }) {
    const resolvedTarget = avoidTorso
      ? pushOutOfTorso(target, avoidTorso.shoulderMid, avoidTorso.hipMid)
      : target;

    const upperLength = this.#calibrateLength(upperJoint, distance3D(root, hint));
    const lowerLength = this.#calibrateLength(lowerJoint, distance3D(hint, resolvedTarget));

    const { upperDirection, lowerDirection } = solveTwoBoneIK({
      root,
      hint,
      target: resolvedTarget,
      upperLength,
      lowerLength,
    });

    pose[upperJoint] = directionToEuler({ x: 0, y: 0, z: 0 }, upperDirection, restDirection);
    pose[lowerJoint] = directionToEuler({ x: 0, y: 0, z: 0 }, lowerDirection, restDirection);
  }

  #handRotation(handLandmarks) {
    const h = HAND;
    return directionToEuler(handLandmarks[h.wrist], handLandmarks[h.middleMcp], REST_DOWN);
  }

  #buildFaceChannels(blendshapes, pose) {
    const score = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;

    pose.leftEyeBlink = { x: clamp01(score('eyeBlinkLeft')) };
    pose.rightEyeBlink = { x: clamp01(score('eyeBlinkRight')) };
    pose.leftEyebrowRaise = { x: clamp01((score('browOuterUpLeft') + score('browInnerUp')) / 2) };
    pose.rightEyebrowRaise = { x: clamp01((score('browOuterUpRight') + score('browInnerUp')) / 2) };
    pose.mouthOpen = { x: clamp01(score('jawOpen')) };
    pose.mouthWide = { x: clamp01((score('mouthStretchLeft') + score('mouthStretchRight')) / 2) };
  }
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
