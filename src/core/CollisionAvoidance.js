import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _pushDir = new THREE.Vector3();

// Le torse est modélisé comme une capsule simple entre le milieu des
// épaules et le milieu des hanches. Rayon en mètres (échelle des
// worldLandmarks de PoseLandmarker, centrés sur le buste).
const DEFAULT_TORSO_RADIUS = 0.14;

// Si `target` (ex. la cible d'IK d'une main) tombe à l'intérieur de la
// capsule torse, la repousse radialement à la surface. Sinon la renvoie
// inchangée. Appelée avant `solveTwoBoneIK` pour éviter que le bras retargeté
// traverse le buste.
export function pushOutOfTorso(target, shoulderMid, hipMid, radius = DEFAULT_TORSO_RADIUS) {
  _a.set(shoulderMid.x, shoulderMid.y, shoulderMid.z);
  _b.set(hipMid.x, hipMid.y, hipMid.z);
  _p.set(target.x, target.y, target.z);

  _ab.subVectors(_b, _a);
  const abLengthSq = _ab.lengthSq();
  const t = abLengthSq > 1e-8 ? THREE.MathUtils.clamp(_p.clone().sub(_a).dot(_ab) / abLengthSq, 0, 1) : 0;
  _closest.copy(_a).addScaledVector(_ab, t);

  const distance = _p.distanceTo(_closest);
  if (distance >= radius || distance < 1e-6) {
    return { x: target.x, y: target.y, z: target.z };
  }

  _pushDir.subVectors(_p, _closest).normalize();
  const pushed = _closest.clone().addScaledVector(_pushDir, radius);
  return { x: pushed.x, y: pushed.y, z: pushed.z };
}
