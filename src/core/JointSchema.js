// Schéma des articulations du squelette global.
//
// Chaque articulation possède une rotation (x, y, z, en radians) exprimée dans
// le référentiel de son parent. Les articulations marquées "mirrorOf" forment
// une paire gauche/droite : les réglages d'inversion et d'amplification sont
// fusionnés pour la paire (un seul jeu de curseurs contrôle les deux côtés),
// conformément à la demande. Le signe appliqué à chaque membre de la paire
// est géré par MirrorGroups.js.

export const AXES = ['x', 'y', 'z'];

// Articulations de corps (issues de la pose et, si détectées, des mains).
export const BODY_JOINTS = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftFoot',
  'rightFoot',
];

// Canaux d'expression faciale. Ce ne sont pas des rotations d'articulation
// mais des valeurs 0-1 (ou -1..1 pour les sourcils), lissées et amplifiées
// de la même façon que les articulations.
export const FACE_CHANNELS = [
  'leftEyeBlink',
  'rightEyeBlink',
  'leftEyebrowRaise',
  'rightEyebrowRaise',
  'mouthOpen',
  'mouthWide',
];

export const ALL_CHANNELS = [...BODY_JOINTS, ...FACE_CHANNELS];

// Paires miroir : la clé et la valeur partagent le même réglage d'inversion
// et d'amplification par axe.
export const MIRROR_PAIRS = [
  ['leftShoulder', 'rightShoulder'],
  ['leftUpperArm', 'rightUpperArm'],
  ['leftLowerArm', 'rightLowerArm'],
  ['leftHand', 'rightHand'],
  ['leftUpperLeg', 'rightUpperLeg'],
  ['leftLowerLeg', 'rightLowerLeg'],
  ['leftFoot', 'rightFoot'],
  ['leftEyeBlink', 'rightEyeBlink'],
  ['leftEyebrowRaise', 'rightEyebrowRaise'],
];

// Articulations sans paire (axe central, ou traitées individuellement).
export const UNPAIRED_CHANNELS = ALL_CHANNELS.filter(
  (name) => !MIRROR_PAIRS.some((pair) => pair.includes(name)),
);

// Renvoie, pour une articulation donnée, le nom du groupe de réglage partagé
// (identique pour les deux membres d'une paire miroir, sinon le nom lui-même).
export function mirrorGroupKey(jointName) {
  const pair = MIRROR_PAIRS.find((p) => p.includes(jointName));
  return pair ? pair.slice().sort().join('/') : jointName;
}

export function isLeftJoint(jointName) {
  return jointName.startsWith('left');
}

export function isRightJoint(jointName) {
  return jointName.startsWith('right');
}
