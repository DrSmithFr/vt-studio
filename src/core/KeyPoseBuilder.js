import * as THREE from 'three';
import { quaternionToEuler, swingRotation } from '../utils/MathUtils.js';
import { FINGERS, fingerBone } from './JointSchema.js';
import { FINGER_KEYS, fingerFeatureKey } from './FeatureSchema.js';
import { torsoQuaternions } from './FeatureExtractor.js';

// Reconstruction de la KeyPose (rotations locales des os normalisés VRM +
// déplacement du bassin) à partir des seules valeurs relatives
// (FeatureExtractor). Les parties non détectées prennent la pose de repos
// choisie dans le panneau gauche (corps et mains séparément).
//
// Repère : T-pose VRM 1.0 normalisée, avatar tourné vers +Z, côté gauche
// vers +X (la conversion éventuelle pour un modèle VRM 0.x est faite par
// VrmController).

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const REST_ARM = { left: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(-1, 0, 0) };
const PALM_SIDE = new THREE.Vector3(0, -1, 0);
const THUMB_SIDE = new THREE.Vector3(0, 0, 1);
const SIDES = ['left', 'right'];
const sideSign = (side) => (side === 'left' ? 1 : -1);
const ZERO = () => ({ x: 0, y: 0, z: 0 });

// Répartition de la flexion du bout d'un doigt entre les deux dernières
// phalanges (la dernière plie moins, couplage anatomique approximatif).
const TIP_SHARE = [0.55, 0.45];

// Part de la rotation de la tête portée par le cou.
const NECK_SHARE = 0.4;

// Poses de repos du corps : angles du bras et direction de l'avant-bras
// (repère de la poitrine ; `null` = bras tendu).
const BODY_REST_POSES = {
  armsDown: { elevation: -1.3, azimuth: 0.1, forearm: null },
  handsOnLap: { elevation: -1.15, azimuth: 0.35, forearm: [0.15, -0.3, 0.94] },
  tPose: { elevation: 0, azimuth: 0, forearm: null },
};

// Poses de repos des mains : { baseFlex, baseSpread, tipFlex } par doigt.
const finger = (baseFlex, baseSpread, tipFlex) => ({ baseFlex, baseSpread, tipFlex });
const HAND_REST_POSES = {
  open: Object.fromEntries(FINGER_KEYS.map((f) => [f, finger(0, 0, 0)])),
  relaxed: {
    thumb: finger(0.2, 0, 0.3),
    ...Object.fromEntries(['index', 'middle', 'ring', 'little'].map((f) => [f, finger(0.3, 0, 0.7)])),
  },
  fist: {
    thumb: finger(0.6, -0.3, 1.0),
    ...Object.fromEntries(['index', 'middle', 'ring', 'little'].map((f) => [f, finger(1.45, 0, 2.6)])),
  },
};

const FINGER_NAMES = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', little: 'Little' };

function axisAngle(axis, angle) {
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

export class KeyPoseBuilder {
  constructor() {
    // Données du modèle (setModelRest) : direction de repos de chaque
    // phalange et proportion bras / avant-bras. Valeurs par défaut pour un
    // modèle standard en attendant le chargement.
    this.fingerDirections = {};
    for (const side of SIDES) {
      for (const name of FINGERS) {
        const direction = name === 'Thumb'
          ? new THREE.Vector3(sideSign(side), 0, 1).normalize()
          : REST_ARM[side].clone();
        for (let i = 0; i < 3; i++) this.fingerDirections[fingerBone(side, name, i)] = direction.clone();
      }
    }
    this.upperArmRatio = { left: 0.53, right: 0.53 };
  }

  // `rest` : VrmController.getRestInfo() — { fingerDirections, upperArmRatio }.
  setModelRest(rest) {
    Object.assign(this.fingerDirections, rest.fingerDirections);
    Object.assign(this.upperArmRatio, rest.upperArmRatio);
  }

  // `extraction` : sortie de FeatureExtractor.extract() ({ values, has,
  // expressions }). `settings` : { restPose, motion, bodyCalibrated }.
  // Renvoie { pose: { [os ou canal]: {x,y,z} }, hipsOffset: {x,y,z} }.
  build({ values, has, expressions }, { restPose, motion, bodyCalibrated }) {
    const pose = {};
    const v = has.body ? values : {};

    // --- Tronc.
    const torso = torsoQuaternions(v);
    pose.hips = quaternionToEuler(torso.hips);
    pose.spine = quaternionToEuler(torso.spine);
    pose.chest = quaternionToEuler(torso.chest);
    pose.leftShoulder = ZERO();
    pose.rightShoulder = ZERO();

    // --- Tête : rotation totale relative à la poitrine, répartie cou / tête.
    if (has.face) {
      const total = new THREE.Quaternion().setFromEuler(new THREE.Euler(values.headPitch, values.headYaw, values.headRoll, 'YXZ'));
      const neck = new THREE.Quaternion().slerp(total, NECK_SHARE);
      pose.neck = quaternionToEuler(neck);
      pose.head = quaternionToEuler(neck.clone().invert().multiply(total));
    } else {
      pose.neck = ZERO();
      pose.head = ZERO();
    }

    // --- Bras et poignets (repère de la poitrine, clavicules à zéro).
    const bodyRest = BODY_REST_POSES[restPose.body] ?? BODY_REST_POSES.armsDown;
    for (const side of SIDES) {
      const s = sideSign(side);
      const elevation = has.body ? values[`${side}ArmElevation`] : bodyRest.elevation;
      const azimuth = has.body ? values[`${side}ArmAzimuth`] : bodyRest.azimuth;
      const upperDirection = new THREE.Vector3(
        s * Math.cos(elevation) * Math.cos(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.sin(azimuth),
      );

      // Avant-bras : du coude (fin du bras, à la proportion du modèle) vers
      // la position de la main.
      const ratio = this.upperArmRatio[side];
      const elbow = upperDirection.clone().multiplyScalar(ratio);
      let hand;
      if (has.body) {
        hand = new THREE.Vector3(values[`${side}HandX`], values[`${side}HandY`], values[`${side}HandZ`]);
      } else if (bodyRest.forearm) {
        const [fx, fy, fz] = bodyRest.forearm;
        hand = elbow.clone().addScaledVector(new THREE.Vector3(s * fx, fy, fz).normalize(), 1 - ratio);
      } else {
        hand = upperDirection.clone();
      }
      const lowerDirection = hand.clone().sub(elbow);
      if (lowerDirection.lengthSq() < 1e-6) lowerDirection.copy(upperDirection);

      const upperArm = swingRotation(REST_ARM[side], upperDirection);
      const lowerArm = swingRotation(REST_ARM[side], lowerDirection, upperArm.world);
      pose[`${side}UpperArm`] = quaternionToEuler(upperArm.local);
      pose[`${side}LowerArm`] = quaternionToEuler(lowerArm.local);
      pose[`${side}Hand`] = has.body
        ? { x: values[`${side}HandTwist`], y: values[`${side}HandDeviation`], z: values[`${side}HandFlex`] }
        : ZERO();
    }

    // --- Jambes (repère du bassin) : direction de la cuisse, genou plié
    // autour de son axe latéral (vers l'arrière).
    for (const side of SIDES) {
      if (has.body && has.legs) {
        const pitch = values[`${side}LegPitch`];
        const roll = values[`${side}LegRoll`];
        const thigh = new THREE.Vector3(
          sideSign(side) * Math.sin(roll) * Math.cos(pitch),
          -Math.cos(roll) * Math.cos(pitch),
          Math.sin(pitch),
        );
        pose[`${side}UpperLeg`] = quaternionToEuler(swingRotation(DOWN, thigh).local);
        pose[`${side}LowerLeg`] = quaternionToEuler(axisAngle(X_AXIS, values[`${side}KneeBend`]));
      } else {
        pose[`${side}UpperLeg`] = ZERO();
        pose[`${side}LowerLeg`] = ZERO();
      }
      pose[`${side}Foot`] = ZERO();
    }

    // --- Doigts.
    const handRest = HAND_REST_POSES[restPose.hands] ?? HAND_REST_POSES.relaxed;
    for (const side of SIDES) {
      for (const key of FINGER_KEYS) {
        const angles = has[side]
          ? {
              baseFlex: values[fingerFeatureKey(side, key, 'baseFlex')],
              baseSpread: values[fingerFeatureKey(side, key, 'baseSpread')],
              tipFlex: values[fingerFeatureKey(side, key, 'tipFlex')],
            }
          : handRest[key];
        this.#applyFinger(pose, side, FINGER_NAMES[key], angles);
      }
    }

    // --- Expressions.
    if (expressions) Object.assign(pose, expressions);

    // --- Déplacement du bassin : latéral (position à l'écran) et vertical
    // (hauteur des épaules, seulement une fois le corps calibré : sans
    // référence, la hauteur absolue ferait flotter ou s'enfoncer l'avatar).
    const hipsOffset = { x: 0, y: 0, z: 0 };
    if (has.body) {
      hipsOffset.x = (values.pelvisX ?? 0) * motion.lateralRange;
      if (bodyCalibrated) hipsOffset.y = -(values.shouldersY ?? 0) * motion.verticalRange;
    }

    return { pose, hipsOffset };
  }

  // Une phalange plie autour de l'axe (direction × côté paume) et s'écarte
  // autour de l'axe (direction × côté pouce), calculés à partir de sa
  // direction de repos dans le modèle : valable pour les quatre doigts comme
  // pour le pouce, quelle que soit son orientation de repos.
  #applyFinger(pose, side, name, { baseFlex, baseSpread, tipFlex }) {
    const bones = [0, 1, 2].map((i) => fingerBone(side, name, i));
    const flexAxis = (bone) => new THREE.Vector3().crossVectors(this.fingerDirections[bone], PALM_SIDE).normalize();
    const spreadAxis = new THREE.Vector3().crossVectors(this.fingerDirections[bones[0]], THUMB_SIDE).normalize();

    const base = axisAngle(spreadAxis, baseSpread).multiply(axisAngle(flexAxis(bones[0]), baseFlex));
    pose[bones[0]] = quaternionToEuler(base);
    pose[bones[1]] = quaternionToEuler(axisAngle(flexAxis(bones[1]), tipFlex * TIP_SHARE[0]));
    pose[bones[2]] = quaternionToEuler(axisAngle(flexAxis(bones[2]), tipFlex * TIP_SHARE[1]));
  }
}
