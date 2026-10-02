// Limites anatomiques approximatives, en radians, appliquées après le
// retargeting. Servent à filtrer les valeurs aberrantes issues du bruit de
// détection (ex. un coude qui semble s'hyperétendre) plutôt qu'à représenter
// une biomécanique exacte - les plages sont volontairement généreuses.
//
// Absent d'une entrée pour un canal : aucune limite n'est appliquée.
//
// Rotations locales des os normalisés VRM (T-pose). Pas de limites par défaut
// pour les coudes et genoux : la rotation de swing calculée peut porter la
// flexion sur Y ou Z selon l'orientation du segment parent, une butée par
// axe y bloquerait des flexions légitimes. À affiner avec la KeyPose.
const DEFAULT_LIMITS = {
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
