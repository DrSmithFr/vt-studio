import { AXES, ALL_CHANNELS, MIRROR_PAIRS, mirrorGroupKey } from './JointSchema.js';

// Regroupe tous les réglages exposés dans le panneau de débogage :
//
// - sideInversion : échange gauche/droite pour un groupe de membres entier
//   (utile pour corriger l'effet miroir de la webcam, indépendamment pour
//   les bras, les mains et les jambes).
// - axisInvert : pour un groupe d'articulations miroir donné, inverse le
//   signe d'un axe. Le réglage est unique par paire (les deux articulations
//   miroir sont fusionnées), comme demandé.
// - amplification : ratio multiplicatif par axe, également fusionné par
//   paire miroir.
export class RetargetConfig {
  constructor() {
    this.sideInversion = {
      arms: false,
      hands: false,
      legs: false,
    };

    this.axisInvert = {};
    this.amplification = {};

    const groupKeys = new Set(ALL_CHANNELS.map(mirrorGroupKey));
    for (const key of groupKeys) {
      this.axisInvert[key] = { x: false, y: false, z: false };
      this.amplification[key] = { x: 1, y: 1, z: 1 };
    }
  }

  setAxisInvert(channelName, axis, value) {
    this.axisInvert[mirrorGroupKey(channelName)][axis] = value;
  }

  getAxisInvert(channelName, axis) {
    return this.axisInvert[mirrorGroupKey(channelName)][axis];
  }

  setAmplification(channelName, axis, ratio) {
    this.amplification[mirrorGroupKey(channelName)][axis] = ratio;
  }

  getAmplification(channelName, axis) {
    return this.amplification[mirrorGroupKey(channelName)][axis];
  }
}

const SIDE_GROUPS = {
  arms: ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'],
  hands: ['leftHand', 'rightHand'],
  legs: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'],
};

// Échange les valeurs gauche/droite pour les groupes dont l'inversion de
// côté est activée. Retourne un nouvel objet, la source n'est pas modifiée.
function applySideInversion(pose, sideInversion) {
  const result = { ...pose };
  for (const [groupName, channelNames] of Object.entries(SIDE_GROUPS)) {
    if (!sideInversion[groupName]) continue;
    for (const [left, right] of MIRROR_PAIRS) {
      if (!channelNames.includes(left)) continue;
      const leftValue = result[left];
      result[left] = result[right];
      result[right] = leftValue;
    }
  }
  return result;
}

// Applique l'inversion par axe et l'amplification à chaque canal.
// `pose` est un objet { [channelName]: { x, y, z } } (rotations) ou, pour les
// canaux de visage à valeur unique, { [channelName]: { x: valeur } }.
export function applyRetargeting(pose, config) {
  const sided = applySideInversion(pose, config.sideInversion);
  const output = {};
  for (const [name, value] of Object.entries(sided)) {
    if (!value) {
      output[name] = value;
      continue;
    }
    const groupKey = mirrorGroupKey(name);
    const invert = config.axisInvert[groupKey] ?? { x: false, y: false, z: false };
    const amp = config.amplification[groupKey] ?? { x: 1, y: 1, z: 1 };
    const out = {};
    for (const axis of AXES) {
      if (value[axis] === undefined) continue;
      const sign = invert[axis] ? -1 : 1;
      out[axis] = value[axis] * amp[axis] * sign;
    }
    output[name] = out;
  }
  return output;
}
