// Valeurs relatives extraites des détections (FeatureExtractor), à partir
// desquelles la KeyPose est reconstruite (KeyPoseBuilder). Affichées en temps
// réel dans le panneau droit.
//
// Les côtés (left/right) sont ceux de l'avatar : en miroir, la main gauche
// de la personne pilote les valeurs « droite ».
//
// Unités : 'pct' = fraction de l'écran (affichée en %), 'deg' = angle en
// radians (affiché en degrés), 'len' = position d'une main relative à son
// épaule, en longueurs de bras, dans le repère de la poitrine.
//
// `calibration` : 'body' ou 'hands' si la valeur est remise à zéro par la
// calibration correspondante (la valeur observée pendant la calibration
// devient le zéro de référence).

export const FINGER_KEYS = ['thumb', 'index', 'middle', 'ring', 'little'];

const FINGER_LABELS = {
  thumb: 'Pouce',
  index: 'Index',
  middle: 'Majeur',
  ring: 'Annulaire',
  little: 'Auriculaire',
};

const SIDES = [
  ['left', 'G'],
  ['right', 'D'],
];

const AXIS_LABELS = { X: 'latéral', Y: 'vertical', Z: 'profondeur' };

export const fingerFeatureKey = (side, finger, part) => `${side}_${finger}_${part}`;

// Groupes de valeurs : { title, features: [{ key, label, unit, calibration? }] }.
export const FEATURE_GROUPS = [
  {
    title: 'Tronc',
    features: [
      { key: 'pelvisX', label: 'Bassin, latéral', unit: 'pct', calibration: 'body' },
      { key: 'shouldersY', label: 'Épaules, vertical', unit: 'pct', calibration: 'body' },
      { key: 'pelvisYaw', label: 'Bassin, rotation', unit: 'deg', calibration: 'body' },
      { key: 'spineAngle', label: 'Colonne, inclinaison', unit: 'deg', calibration: 'body' },
      { key: 'spineLean', label: 'Colonne, avant/arrière', unit: 'deg', calibration: 'body' },
      { key: 'spineTwist', label: 'Colonne, rotation', unit: 'deg', calibration: 'body' },
    ],
  },
  {
    title: 'Tête',
    features: [
      { key: 'headYaw', label: 'Tête, lacet', unit: 'deg', calibration: 'body' },
      { key: 'headPitch', label: 'Tête, tangage', unit: 'deg', calibration: 'body' },
      { key: 'headRoll', label: 'Tête, roulis', unit: 'deg', calibration: 'body' },
    ],
  },
  {
    title: 'Bras',
    features: SIDES.flatMap(([side, s]) => [
      { key: `${side}ArmElevation`, label: `Bras ${s}, élévation`, unit: 'deg' },
      { key: `${side}ArmAzimuth`, label: `Bras ${s}, azimut`, unit: 'deg' },
    ]),
  },
  {
    title: 'Mains',
    features: SIDES.flatMap(([side, s]) => [
      ...['X', 'Y', 'Z'].map((axis) => ({
        key: `${side}Hand${axis}`,
        label: `Main ${s}, ${AXIS_LABELS[axis]}`,
        unit: 'len',
      })),
      { key: `${side}HandFlex`, label: `Poignet ${s}, flexion`, unit: 'deg' },
      { key: `${side}HandDeviation`, label: `Poignet ${s}, déviation`, unit: 'deg' },
      { key: `${side}HandTwist`, label: `Poignet ${s}, rotation`, unit: 'deg' },
    ]),
  },
  {
    title: 'Jambes',
    features: SIDES.flatMap(([side, s]) => [
      { key: `${side}LegPitch`, label: `Cuisse ${s}, avant/arrière`, unit: 'deg' },
      { key: `${side}LegRoll`, label: `Cuisse ${s}, écart`, unit: 'deg' },
      { key: `${side}KneeBend`, label: `Genou ${s}, flexion`, unit: 'deg' },
    ]),
  },
  ...SIDES.map(([side, s]) => ({
    title: `Doigts ${s}`,
    features: FINGER_KEYS.flatMap((finger) => [
      { key: fingerFeatureKey(side, finger, 'baseFlex'), label: `${FINGER_LABELS[finger]}, flexion base`, unit: 'deg', calibration: 'hands' },
      { key: fingerFeatureKey(side, finger, 'baseSpread'), label: `${FINGER_LABELS[finger]}, écart base`, unit: 'deg', calibration: 'hands' },
      { key: fingerFeatureKey(side, finger, 'tipFlex'), label: `${FINGER_LABELS[finger]}, bout`, unit: 'deg', calibration: 'hands' },
    ]),
  })),
];

export const ALL_FEATURES = FEATURE_GROUPS.flatMap((group) => group.features);

export const CALIBRATED_KEYS = {
  body: ALL_FEATURES.filter((f) => f.calibration === 'body').map((f) => f.key),
  hands: ALL_FEATURES.filter((f) => f.calibration === 'hands').map((f) => f.key),
};
