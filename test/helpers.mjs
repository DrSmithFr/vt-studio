// Données synthétiques et utilitaires partagés par les tests.
//
// Les détections sont exprimées comme MediaPipe les fournit : repère
// « world » en mètres, x vers la droite de l'image (donc vers la gauche de la
// personne, qui fait face à la caméra), y vers le bas, z s'éloignant de la
// caméra ; coordonnées « screen » normalisées 0-1.

import * as THREE from 'three';

export const DEG = Math.PI / 180;

// --- Squelette de pose (33 points) -------------------------------------------

const DEFAULT_BODY = {
  11: [0.18, -0.5, 0], // épaule gauche
  12: [-0.18, -0.5, 0], // épaule droite
  13: [0.45, -0.5, 0], // coude gauche (T-pose)
  14: [-0.45, -0.5, 0],
  15: [0.7, -0.5, 0], // poignet gauche
  16: [-0.7, -0.5, 0],
  17: [0.78, -0.5, 0.03], // auriculaire gauche
  18: [-0.78, -0.5, 0.03],
  19: [0.78, -0.5, -0.03], // index gauche
  20: [-0.78, -0.5, -0.03],
  23: [0.1, 0, 0], // hanche gauche
  24: [-0.1, 0, 0],
  25: [0.1, 0.45, 0], // genou gauche
  26: [-0.1, 0.45, 0],
  27: [0.1, 0.9, 0], // cheville gauche
  28: [-0.1, 0.9, 0],
};

// Bras gauche de la personne le long du corps, paume vers l'avant (vers la
// caméra), pouce vers l'extérieur.
export const LEFT_ARM_DOWN = {
  13: [0.2, -0.23, 0],
  15: [0.2, 0.02, 0],
  19: [0.22, 0.1, 0],
  17: [0.17, 0.1, 0],
};

// Bras gauche tendu vers la caméra.
export const LEFT_ARM_FORWARD = {
  13: [0.18, -0.5, -0.27],
  15: [0.18, -0.5, -0.52],
  19: [0.18, -0.5, -0.6],
  17: [0.18, -0.5, -0.6],
};

// Coude gauche plié, avant-bras vers le haut.
export const LEFT_ELBOW_UP = {
  13: [0.45, -0.5, 0],
  15: [0.45, -0.75, 0],
  19: [0.42, -0.83, 0],
  17: [0.48, -0.83, 0],
};

// Construit une pose { screen, world } ; `overrides` remplace des points
// (index → [x, y, z]), `visibility` des visibilités (index → valeur).
export function makePose(overrides = {}, { visibility = {}, screenOffset = [0, 0] } = {}) {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
  for (const [index, [x, y, z]] of Object.entries({ ...DEFAULT_BODY, ...overrides })) {
    world[index] = { x, y, z, visibility: visibility[index] ?? 1 };
  }
  const screen = world.map((p) => ({
    x: 0.5 + p.x / 2 + screenOffset[0],
    y: 0.5 + p.y / 2 + screenOffset[1],
    z: 0,
    visibility: p.visibility,
  }));
  return { screen, world };
}

// --- Main (21 points) ---------------------------------------------------------

// Main gauche anatomique, doigts vers le bas (+y), paume face caméra : le
// pouce est côté extérieur (+x). `curl` plie l'index vers la paume (vers la
// caméra, -z), en radians par phalange.
export function makeLeftHandDown({ curl = 0 } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const bases = { 1: [0.03, 0.03], 5: [0.02, 0.09], 9: [0, 0.09], 13: [-0.02, 0.09], 17: [-0.04, 0.09] };
  for (const [base, [x, y]] of Object.entries(bases)) {
    const i = Number(base);
    points[i] = { x, y, z: 0 };
    for (let k = 1; k <= 3; k++) {
      const bend = i === 5 ? curl * k : 0;
      const previous = points[i + k - 1];
      points[i + k] = {
        x: previous.x + (i === 1 ? 0.02 : 0),
        y: previous.y + 0.025 * Math.cos(bend),
        z: previous.z - 0.025 * Math.sin(bend),
      };
    }
  }
  return { screen: points, world: points };
}

// --- Visage (478 points) -------------------------------------------------------

// Seuls les points utilisés pour l'orientation de la tête sont placés. `yaw`
// > 0 : la personne tourne la tête vers SA gauche ; `pitch` > 0 : elle penche
// la tête vers l'avant (regarde vers le bas).
export function makeFace({ yaw = 0, pitch = 0, blendshapes = {} } = {}) {
  const key = { 33: [-0.05, -0.05, 0], 263: [0.05, -0.05, 0], 10: [0, -0.12, 0], 152: [0, 0.1, 0] };
  const screen = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const rotation = new THREE.Euler(pitch, -yaw, 0, 'YXZ');
  for (const [index, [x, y, z]] of Object.entries(key)) {
    const v = new THREE.Vector3(x, y, z).applyEuler(rotation);
    screen[index] = { x: 0.5 + v.x, y: 0.5 + v.y, z: v.z };
  }
  return { screen, blendshapes };
}

export function makeDetection({ pose = makePose(), face = null, hands = {} } = {}) {
  return { pose, face, hands: { left: hands.left ?? null, right: hands.right ?? null } };
}

// --- Squelette reconstruit --------------------------------------------------------

const toQuaternion = (e) => new THREE.Quaternion().setFromEuler(new THREE.Euler(e.x, e.y, e.z, 'XYZ'));

// Direction monde d'un os : rotations locales cumulées le long de la chaîne,
// appliquées à la direction de repos de l'os.
export function boneDirection(pose, chain, rest) {
  const q = new THREE.Quaternion();
  for (const bone of chain) q.multiply(toQuaternion(pose[bone] ?? { x: 0, y: 0, z: 0 }));
  return new THREE.Vector3(...rest).applyQuaternion(q);
}

export const armChain = (side, ...extra) => ['hips', 'spine', 'chest', `${side}Shoulder`, `${side}UpperArm`, ...extra];

// Vérifie qu'un vecteur pointe dans la direction attendue (à `toleranceDeg`
// près).
export function assertDirection(assert, actual, expected, toleranceDeg = 8, message = '') {
  const angle = actual.angleTo(new THREE.Vector3(...expected).normalize()) / DEG;
  assert.ok(
    angle <= toleranceDeg,
    `${message} : direction ${actual.toArray().map((v) => v.toFixed(2))} à ${angle.toFixed(1)}° de ${expected}`,
  );
}
