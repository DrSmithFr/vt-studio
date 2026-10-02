import * as THREE from 'three';

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();

// Calcule la rotation (Euler XYZ, en radians) qui amène le vecteur de repos
// `restDirection` sur le vecteur observé allant de `parentPoint` à
// `childPoint`. Sert à convertir une paire de landmarks 3D en rotation
// d'articulation exploitable par le squelette global.
//
// Limite connue : ceci ne capture que le "swing" (l'orientation du segment),
// pas le "twist" autour de son propre axe. C'est suffisant pour un premier
// jet de VTubing ; un futur raffinement pourrait dériver le twist à partir
// d'un troisième point de référence (ex. la normale de l'épaule).
export function directionToEuler(parentPoint, childPoint, restDirection) {
  _from.set(restDirection.x, restDirection.y, restDirection.z).normalize();
  _to
    .set(childPoint.x - parentPoint.x, childPoint.y - parentPoint.y, childPoint.z - parentPoint.z)
    .normalize();

  if (_to.lengthSq() === 0) return { x: 0, y: 0, z: 0 };

  _quat.setFromUnitVectors(_from, _to);
  _euler.setFromQuaternion(_quat, 'XYZ');
  return { x: _euler.x, y: _euler.y, z: _euler.z };
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function distance3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
