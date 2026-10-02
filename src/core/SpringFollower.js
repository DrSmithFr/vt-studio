import * as THREE from 'three';

// Suivi de la KeyPose par le modèle : un ressort amorti par articulation.
//
// Pour chaque os, l'écart de rotation entre l'état courant et la cible
// (axe × angle, par le plus court chemin) produit une accélération angulaire
// a = raideur · écart − amortissement · vitesse. Intégration d'Euler
// semi-implicite par sous-pas courts, stable même pour des raideurs élevées.
// Avec raideur k et amortissement c, la pulsation propre vaut √k et le taux
// d'amortissement c / (2√k) : 1 = critique (pas de dépassement), < 1 = léger
// rebond, plus vivant.
//
// Le déplacement du bassin suit le même principe (ressort vectoriel, réglages
// de l'articulation « hips ») ; les canaux de visage passent tels quels (déjà
// lissés au niveau des blendshapes).

const MAX_SUBSTEP_S = 1 / 240;
const MAX_DT_S = 0.1;

const _target = new THREE.Quaternion();
const _error = new THREE.Quaternion();
const _inverse = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _step = new THREE.Quaternion();
const _euler = new THREE.Euler();

class RotationSpring {
  constructor() {
    this.rotation = null; // THREE.Quaternion
    this.velocity = new THREE.Vector3(); // rad/s, repère du parent
  }

  update(target, stiffness, damping, dt) {
    if (!this.rotation) {
      this.rotation = target.clone();
      return this.rotation;
    }
    // Écart cible / courant, en vecteur rotation (axe × angle).
    _error.copy(target).multiply(_inverse.copy(this.rotation).invert());
    if (_error.w < 0) _error.set(-_error.x, -_error.y, -_error.z, -_error.w);
    const angle = 2 * Math.acos(Math.min(1, _error.w));
    const sinHalf = Math.sqrt(Math.max(0, 1 - _error.w * _error.w));
    const errorVector = sinHalf > 1e-6
      ? new THREE.Vector3(_error.x, _error.y, _error.z).multiplyScalar(angle / sinHalf)
      : new THREE.Vector3();

    // L'écart est considéré constant sur le pas : on intègre la vitesse,
    // puis la rotation (semi-implicite).
    this.velocity.addScaledVector(errorVector, stiffness * dt).multiplyScalar(1 / (1 + damping * dt));
    const speed = this.velocity.length();
    if (speed > 1e-9) {
      _step.setFromAxisAngle(_axis.copy(this.velocity).divideScalar(speed), speed * dt);
      this.rotation.premultiply(_step).normalize();
    }
    return this.rotation;
  }
}

class VectorSpring {
  constructor() {
    this.position = null;
    this.velocity = new THREE.Vector3();
  }

  update(target, stiffness, damping, dt) {
    if (!this.position) {
      this.position = target.clone();
      return this.position;
    }
    const error = target.clone().sub(this.position);
    this.velocity.addScaledVector(error, stiffness * dt).multiplyScalar(1 / (1 + damping * dt));
    this.position.addScaledVector(this.velocity, dt);
    return this.position;
  }
}

export class SpringFollower {
  // `joints` : noms des articulations en rotation suivies par ressort.
  constructor(joints) {
    this.joints = joints;
    this.reset();
  }

  reset() {
    this.springs = new Map(this.joints.map((name) => [name, new RotationSpring()]));
    this.hips = new VectorSpring();
  }

  // `target` : pose cible { [os]: {x,y,z} Euler XYZ, …canaux de visage,
  // hipsOffset }. `params` : réglages par articulation { stiffness, damping }.
  update(target, params, dtMs) {
    const dt = Math.min(dtMs / 1000, MAX_DT_S);
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP_S));
    const h = dt / steps;
    const output = { ...target };

    for (const [name, spring] of this.springs) {
      const rotation = target[name];
      if (!rotation) continue;
      const { stiffness, damping } = params[name];
      _target.setFromEuler(_euler.set(rotation.x, rotation.y, rotation.z, 'XYZ'));
      let current = spring.rotation;
      if (stiffness <= 0 || !current) {
        // Raideur nulle : pas de ressort, la cible est appliquée directement.
        spring.rotation = _target.clone();
        spring.velocity.set(0, 0, 0);
        current = spring.rotation;
      } else {
        for (let i = 0; i < steps; i++) current = spring.update(_target, stiffness, damping, h);
      }
      _euler.setFromQuaternion(current, 'XYZ');
      output[name] = { x: _euler.x, y: _euler.y, z: _euler.z };
    }

    if (target.hipsOffset) {
      const { stiffness, damping } = params.hips;
      const goal = new THREE.Vector3(target.hipsOffset.x, target.hipsOffset.y, target.hipsOffset.z);
      let position = goal;
      if (stiffness > 0) {
        for (let i = 0; i < steps; i++) position = this.hips.update(goal, stiffness, damping, h);
      } else {
        this.hips.position = goal.clone();
        this.hips.velocity.set(0, 0, 0);
      }
      output.hipsOffset = { x: position.x, y: position.y, z: position.z };
    }
    return output;
  }
}
