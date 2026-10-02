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

// Rotation minimale (« swing », sans twist) amenant la direction de repos
// `restDirection` sur `direction`, exprimée dans le repère du parent dont la
// rotation monde est `parentWorld` (THREE.Quaternion, identité par défaut).
// Renvoie { local, world } : `local` est la rotation à appliquer à l'os
// normalisé VRM, `world` sert de parent aux os suivants de la chaîne.
const _localDirection = new THREE.Vector3();
const _parentInverse = new THREE.Quaternion();

export function swingRotation(restDirection, direction, parentWorld = null) {
  _localDirection.set(direction.x, direction.y, direction.z);
  if (_localDirection.lengthSq() === 0) {
    const identity = new THREE.Quaternion();
    return { local: identity, world: parentWorld ? parentWorld.clone() : identity.clone() };
  }
  _localDirection.normalize();
  if (parentWorld) _localDirection.applyQuaternion(_parentInverse.copy(parentWorld).invert());
  const local = new THREE.Quaternion().setFromUnitVectors(restDirection, _localDirection);
  const world = parentWorld ? parentWorld.clone().multiply(local) : local.clone();
  return { local, world };
}

export function quaternionToEuler(quaternion) {
  _euler.setFromQuaternion(quaternion, 'XYZ');
  return { x: _euler.x, y: _euler.y, z: _euler.z };
}
