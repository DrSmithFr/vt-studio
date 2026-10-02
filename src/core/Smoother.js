// Lisse une valeur scalaire dans le temps par moyenne mobile exponentielle.
// Le paramètre `delayMs` est la constante de temps : plus il est élevé, plus
// la valeur lissée met de temps à rejoindre la valeur brute.
class ExponentialSmoother {
  constructor(delayMs = 100) {
    this.delayMs = delayMs;
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
    this.current += (rawValue - this.current) * alpha;
    return this.current;
  }
}

// Applique un ExponentialSmoother indépendant à chaque (articulation, axe).
// Permet de régler un délai différent par articulation, comme demandé.
export class SkeletonSmoother {
  constructor(channelNames, defaultDelayMs = 80) {
    this.delaysMs = new Map(channelNames.map((name) => [name, defaultDelayMs]));
    this.smoothers = new Map(
      channelNames.map((name) => [
        name,
        { x: new ExponentialSmoother(defaultDelayMs), y: new ExponentialSmoother(defaultDelayMs), z: new ExponentialSmoother(defaultDelayMs) },
      ]),
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

  // `rawPose` est un objet { [channelName]: { x, y, z } }. Les canaux absents
  // (articulation non détectée cette frame) sont ignorés : la dernière valeur
  // lissée est conservée telle quelle.
  update(rawPose, dtMs) {
    const smoothed = {};
    for (const [name, axes] of this.smoothers) {
      const raw = rawPose[name];
      if (!raw) {
        smoothed[name] = axes.x.current !== null
          ? { x: axes.x.current, y: axes.y.current, z: axes.z.current }
          : null;
        continue;
      }
      smoothed[name] = {
        x: axes.x.update(raw.x, dtMs),
        y: axes.y.update(raw.y, dtMs),
        z: axes.z.update(raw.z, dtMs),
      };
    }
    return smoothed;
  }
}
