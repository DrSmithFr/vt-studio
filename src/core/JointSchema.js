// Schéma des articulations du squelette global.
//
// Chaque articulation possède une rotation (x, y, z, en radians) exprimée dans
// le référentiel de son parent. Les articulations marquées "mirrorOf" forment
// une paire gauche/droite : les réglages d'inversion et d'amplification sont
// fusionnés pour la paire (un seul jeu de curseurs contrôle les deux côtés),
// conformément à la demande. Le signe appliqué à chaque membre de la paire
// est géré par RetargetConfig.js.

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

// Doigts : os humanoïdes VRM 1.0 (three-vrm convertit les noms VRM 0.x,
// dont thumbProximal → thumbMetacarpal). Trois phalanges par doigt.
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
export const FINGER_SEGMENTS = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal'],
  Index: ['Proximal', 'Intermediate', 'Distal'],
  Middle: ['Proximal', 'Intermediate', 'Distal'],
  Ring: ['Proximal', 'Intermediate', 'Distal'],
  Little: ['Proximal', 'Intermediate', 'Distal'],
};

export function fingerBone(side, finger, segmentIndex) {
  return `${side}${finger}${FINGER_SEGMENTS[finger][segmentIndex]}`;
}

export const FINGER_JOINTS = ['left', 'right'].flatMap((side) =>
  FINGERS.flatMap((finger) => FINGER_SEGMENTS[finger].map((_, i) => fingerBone(side, finger, i))),
);

// Toutes les articulations en rotation (corps + doigts).
export const ROTATION_JOINTS = [...BODY_JOINTS, ...FINGER_JOINTS];

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

export const ALL_CHANNELS = [...ROTATION_JOINTS, ...FACE_CHANNELS];

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
  ...FINGER_JOINTS.filter((name) => name.startsWith('left')).map((name) => [name, name.replace(/^left/, 'right')]),
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

// Libellés affichés dans l'interface (panneaux, menu des articulations).
export const JOINT_LABELS = {
  hips: 'Bassin',
  spine: 'Colonne',
  chest: 'Poitrine',
  neck: 'Cou',
  head: 'Tête',
  leftShoulder: 'Clavicule G',
  rightShoulder: 'Clavicule D',
  leftUpperArm: 'Bras G',
  rightUpperArm: 'Bras D',
  leftLowerArm: 'Avant-bras G',
  rightLowerArm: 'Avant-bras D',
  leftHand: 'Main G',
  rightHand: 'Main D',
  leftUpperLeg: 'Cuisse G',
  rightUpperLeg: 'Cuisse D',
  leftLowerLeg: 'Jambe G',
  rightLowerLeg: 'Jambe D',
  leftFoot: 'Pied G',
  rightFoot: 'Pied D',
  leftEyeBlink: 'Clignement G',
  rightEyeBlink: 'Clignement D',
  leftEyebrowRaise: 'Sourcil G',
  rightEyebrowRaise: 'Sourcil D',
  mouthOpen: 'Bouche ouverte',
  mouthWide: 'Bouche étirée',
};

const FINGER_LABELS = { Thumb: 'Pouce', Index: 'Index', Middle: 'Majeur', Ring: 'Annulaire', Little: 'Auriculaire' };
const SEGMENT_LABELS = { Metacarpal: 'métacarpe', Proximal: '1', Intermediate: '2', Distal: '3' };
for (const side of ['left', 'right']) {
  for (const finger of FINGERS) {
    FINGER_SEGMENTS[finger].forEach((segment, i) => {
      JOINT_LABELS[fingerBone(side, finger, i)] =
        `${FINGER_LABELS[finger]} ${SEGMENT_LABELS[segment]} ${side === 'left' ? 'G' : 'D'}`;
    });
  }
}

// Libellé d'un groupe de réglage (voir mirrorGroupKey) : une paire miroir
// est affichée sous un nom commun, sans le suffixe de côté.
export function mirrorGroupLabel(groupKey) {
  const [first, second] = groupKey.split('/');
  if (!second) return JOINT_LABELS[first] ?? first;
  return `${(JOINT_LABELS[first] ?? first).replace(/ [GD]$/, '')} (G/D)`;
}
