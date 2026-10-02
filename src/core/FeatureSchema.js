// Valeurs relatives extraites des détections, à partir desquelles la KeyPose
// est reconstruite (le reste du squelette est interpolé). Affichées en temps
// réel dans le panneau droit.
//
// Unités : 'pct' = pourcentage de l'écran, 'deg' = degrés (affichage ; les
// calculs internes restent en radians), 'len' = longueurs de bras (position
// d'une main relative à son épaule, normalisée par la longueur du bras).

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

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

// Groupes de valeurs : { title, features: [{ key, label, unit }] }.
export const FEATURE_GROUPS = [
  {
    title: 'Tronc',
    features: [
      { key: 'pelvisX', label: 'Bassin, latéral', unit: 'pct' },
      { key: 'shouldersY', label: 'Épaules, vertical', unit: 'pct' },
      { key: 'spineAngle', label: 'Colonne, inclinaison', unit: 'deg' },
      { key: 'spineTwist', label: 'Colonne, rotation', unit: 'deg' },
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
    features: SIDES.flatMap(([side, s]) =>
      ['X', 'Y', 'Z'].map((axis) => ({ key: `${side}Hand${axis}`, label: `Main ${s}, ${axis}`, unit: 'len' })),
    ),
  },
  ...SIDES.map(([side, s]) => ({
    title: `Doigts ${s}`,
    features: FINGERS.flatMap((finger) => [
      { key: `${side}_${finger}_baseFlex`, label: `${FINGER_LABELS[finger]}, flexion base`, unit: 'deg' },
      { key: `${side}_${finger}_baseSpread`, label: `${FINGER_LABELS[finger]}, écart base`, unit: 'deg' },
      { key: `${side}_${finger}_tipFlex`, label: `${FINGER_LABELS[finger]}, bout`, unit: 'deg' },
    ]),
  })),
];

export const ALL_FEATURES = FEATURE_GROUPS.flatMap((group) => group.features);
