import * as THREE from 'three';

// IK à deux os, résolue analytiquement (loi des cosinus), dans l'esprit du
// "TwoBoneIKConstraint" d'Unity ou du solveur FABRIK simplifié à 2 segments.
//
// Contrairement à une chaîne de rotations indépendantes par segment (chacune
// dérivée directement d'un landmark), cette approche fixe la racine et la
// cible comme sources de vérité, et n'utilise le landmark intermédiaire
// (`hint`, ex. le coude) que pour déterminer le plan de flexion - pas
// l'angle de flexion lui-même. C'est ce qui élimine le tremblement dû au
// bruit de profondeur (z) du landmark intermédiaire.
//
// Repère l'usage prévu : bras (épaule → coude-indice → poignet-cible) et
// jambes (hanche → genou-indice → cheville-cible).

const _rootToTarget = new THREE.Vector3();
const _rootToHint = new THREE.Vector3();
const _bendAxis = new THREE.Vector3();
const _bendPlaneNormal = new THREE.Vector3();
const _elbowOffset = new THREE.Vector3();

function vec3(p) {
  return new THREE.Vector3(p.x, p.y, p.z);
}

export function solveTwoBoneIK({ root, hint, target, upperLength, lowerLength }) {
  const rootV = vec3(root);
  const targetV = vec3(target);
  const hintV = vec3(hint);

  _rootToTarget.subVectors(targetV, rootV);
  let distance = _rootToTarget.length();

  // La cible peut être hors de portée (bras tendu au-delà de sa longueur
  // réelle, à cause du bruit de détection) : on la ramène à la limite
  // atteignable pour garder le triangle résoluble.
  const maxReach = upperLength + lowerLength - 1e-4;
  const minReach = Math.abs(upperLength - lowerLength) + 1e-4;
  distance = THREE.MathUtils.clamp(distance, minReach, maxReach);

  // Angle, à la racine, entre la direction vers la cible et la direction
  // vers l'articulation intermédiaire (loi des cosinus).
  const cosRootAngle = THREE.MathUtils.clamp(
    (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * upperLength * distance),
    -1,
    1,
  );
  const rootAngle = Math.acos(cosRootAngle);

  // Plan de flexion : défini par la direction racine→cible et la position
  // du hint (coude/genou observé), utilisé uniquement comme indication de
  // côté, pas comme source de distance.
  const forward = _rootToTarget.clone().normalize();
  _rootToHint.subVectors(hintV, rootV);
  _bendPlaneNormal.crossVectors(forward, _rootToHint);
  if (_bendPlaneNormal.lengthSq() < 1e-8) {
    // Hint quasi aligné avec la cible : plan de flexion indéterminé, on en
    // choisit un arbitraire mais stable (évite une division par ~0).
    _bendPlaneNormal.set(0, 0, 1).cross(forward);
  }
  _bendPlaneNormal.normalize();
  _bendAxis.crossVectors(_bendPlaneNormal, forward).normalize();

  // Position du coude/genou : on part de la direction racine→cible, on la
  // fait pivoter de `rootAngle` dans le plan de flexion, et on la met à
  // l'échelle de la longueur du premier segment.
  _elbowOffset.copy(forward).applyAxisAngle(_bendPlaneNormal, rootAngle).multiplyScalar(upperLength);
  const midV = rootV.clone().add(_elbowOffset);

  return {
    mid: { x: midV.x, y: midV.y, z: midV.z },
    upperDirection: { x: _elbowOffset.x, y: _elbowOffset.y, z: _elbowOffset.z },
    lowerDirection: {
      x: targetV.x - midV.x,
      y: targetV.y - midV.y,
      z: targetV.z - midV.z,
    },
  };
}
