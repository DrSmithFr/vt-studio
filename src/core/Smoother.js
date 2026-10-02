// Lisse une valeur scalaire dans le temps par moyenne mobile exponentielle.
// Le paramètre `delayMs` est la constante de temps : plus il est élevé, plus
// la valeur lissée met de temps à rejoindre la valeur brute.
//
// `angular` : la valeur est un angle (radians). L'écart à la cible est alors
// ramené dans [-π, π] avant d'être appliqué, pour qu'un passage de +179° à
// -179° soit un pas de 2° et non un tour complet (source de soubresauts).
class ExponentialSmoother {
  constructor(delayMs = 100, angular = false) {
    this.delayMs = delayMs;
    this.angular = angular;
    this.current = null;
  }

  reset(value = null) {
    this.current = value;
  }

  // `dtMs` est le temps écoulé depuis le dernier appel, en millisecondes.
  update(rawValue, dtMs) {
    if (this.current === null || Number.isNaN(this.current)) {
      this.current = rawValue;
      return this.current;
    }
    if (this.delayMs <= 0) {
      this.current = rawValue;
      return this.current;
    }
    const alpha = 1 - Math.exp(-dtMs / this.delayMs);
    let delta = rawValue - this.current;
    if (this.angular) {
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.current += delta * alpha;
      this.current = Math.atan2(Math.sin(this.current), Math.cos(this.current));
    } else {
      this.current += delta * alpha;
    }
    return this.current;
  }
}

// Applique un ExponentialSmoother indépendant à chaque (articulation, axe).
// Permet de régler un délai différent par articulation, comme demandé.
export class SkeletonSmoother {
  // `angularChannels` : canaux dont les valeurs sont des angles (rotations
  // d'articulation), par opposition aux canaux de visage (0-1).
  constructor(channelNames, defaultDelayMs = 80, angularChannels = channelNames) {
    const angular = new Set(angularChannels);
    this.delaysMs = new Map(channelNames.map((name) => [name, defaultDelayMs]));
    this.smoothers = new Map(
      channelNames.map((name) => {
        const make = () => new ExponentialSmoother(defaultDelayMs, angular.has(name));
        return [name, { x: make(), y: make(), z: make() }];
      }),
    );
  }

  setDelay(channelName, delayMs) {
    this.delaysMs.set(channelName, delayMs);
    const axes = this.smoothers.get(channelName);
    if (!axes) return;
    for (const axis of Object.values(axes)) axis.delayMs = delayMs;
  }

  getDelay(channelName) {
    return this.delaysMs.get(channelName) ?? 80;
  }

  #current(axes) {
    const out = {};
    for (const axis of ['x', 'y', 'z']) {
      if (axes[axis].current !== null) out[axis] = axes[axis].current;
    }
    return out;
  }

  // Oublie l'état lissé (ex. à la désactivation de la détection).
  reset() {
    for (const axes of this.smoothers.values()) {
      for (const smoother of Object.values(axes)) smoother.reset();
    }
  }

  // `rawPose` est un objet { [channelName]: { x, y, z } }. Les canaux absents
  // (articulation non détectée cette frame) sont ignorés : la dernière valeur
  // lissée est conservée telle quelle.
  update(rawPose, dtMs) {
    const smoothed = {};
    for (const [name, axes] of this.smoothers) {
      const raw = rawPose[name];
      if (!raw) {
        smoothed[name] = axes.x.current !== null ? this.#current(axes) : null;
        continue;
      }
      // Seuls les axes présents sont lissés : un canal de visage n'a que x.
      const out = {};
      for (const axis of ['x', 'y', 'z']) {
        if (raw[axis] !== undefined) out[axis] = axes[axis].update(raw[axis], dtMs);
      }
      smoothed[name] = out;
    }
    return smoothed;
  }
}
