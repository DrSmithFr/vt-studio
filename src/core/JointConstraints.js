// Limites anatomiques approximatives, en radians, appliquées après le
// retargeting. Servent à filtrer les valeurs aberrantes issues du bruit de
// détection (ex. un coude qui semble s'hyperétendre) plutôt qu'à représenter
// une biomécanique exacte - les plages sont volontairement généreuses.
//
// Absent d'une entrée pour un canal : aucune limite n'est appliquée.
const DEFAULT_LIMITS = {
  leftLowerArm: { x: [0, 2.6], y: [-0.3, 0.3], z: [-0.3, 0.3] },
  rightLowerArm: { x: [0, 2.6], y: [-0.3, 0.3], z: [-0.3, 0.3] },
  leftLowerLeg: { x: [-2.6, 0], y: [-0.2, 0.2], z: [-0.2, 0.2] },
  rightLowerLeg: { x: [-2.6, 0], y: [-0.2, 0.2], z: [-0.2, 0.2] },
  neck: { x: [-0.6, 0.6], y: [-0.9, 0.9], z: [-0.5, 0.5] },
  head: { x: [-0.6, 0.6], y: [-0.9, 0.9], z: [-0.5, 0.5] },
};

export class JointConstraints {
  constructor(limits = DEFAULT_LIMITS) {
    // Copie profonde pour permettre un réglage individuel depuis le panneau
    // de débogage sans muter les valeurs par défaut partagées.
    this.limits = Object.fromEntries(
      Object.entries(limits).map(([joint, axes]) => [
        joint,
        Object.fromEntries(Object.entries(axes).map(([axis, range]) => [axis, [...range]])),
      ]),
    );
  }

  setLimit(jointName, axis, min, max) {
    this.limits[jointName] ??= {};
    this.limits[jointName][axis] = [min, max];
  }

  apply(pose) {
    const output = {};
    for (const [name, value] of Object.entries(pose)) {
      const jointLimits = this.limits[name];
      if (!value || !jointLimits) {
        output[name] = value;
        continue;
      }
      const clamped = { ...value };
      for (const [axis, [min, max]] of Object.entries(jointLimits)) {
        if (clamped[axis] === undefined) continue;
        clamped[axis] = Math.min(max, Math.max(min, clamped[axis]));
      }
      output[name] = clamped;
    }
    return output;
  }
}
