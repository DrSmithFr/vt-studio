// Lissage des landmarks bruts (« détection lissée »), en amont de tout le
// reste du pipeline.
//
// Moyenne mobile exponentielle sur chaque coordonnée de chaque landmark,
// appliquée une fois par nouveau résultat de détecteur (et non par frame de
// rendu) : le pas de temps est l'écart entre deux résultats successifs.
// Constante de temps réglable par détecteur (corps, visage, mains).

// Lisse une liste de landmarks de taille fixe. Réinitialisé dès que la liste
// disparaît (partie non détectée), pour ne pas « glisser » depuis une
// position périmée quand elle réapparaît.
class LandmarkStream {
  constructor() {
    this.values = null; // Float64Array [x, y, z, ...]
    this.timestamp = null;
  }

  update(landmarks, timestamp, delayMs) {
    if (!landmarks) {
      this.values = null;
      return null;
    }
    const n = landmarks.length;
    if (!this.values || this.values.length !== n * 3) {
      this.values = new Float64Array(n * 3);
      landmarks.forEach((p, i) => this.values.set([p.x, p.y, p.z], i * 3));
    } else {
      const dt = timestamp - this.timestamp;
      const alpha = delayMs <= 0 ? 1 : 1 - Math.exp(-dt / delayMs);
      landmarks.forEach((p, i) => {
        const k = i * 3;
        this.values[k] += (p.x - this.values[k]) * alpha;
        this.values[k + 1] += (p.y - this.values[k + 1]) * alpha;
        this.values[k + 2] += (p.z - this.values[k + 2]) * alpha;
      });
    }
    this.timestamp = timestamp;
    // La visibilité n'est pas lissée : elle sert à décider de l'affichage et
    // de la fiabilité, pas à positionner.
    return landmarks.map((p, i) => {
      const k = i * 3;
      const out = { x: this.values[k], y: this.values[k + 1], z: this.values[k + 2] };
      if (p.visibility !== undefined) out.visibility = p.visibility;
      return out;
    });
  }
}

// Même principe pour des scores nommés (blendshapes du visage).
class ScoreStream {
  constructor() {
    this.values = null;
    this.timestamp = null;
  }

  update(scores, timestamp, delayMs) {
    if (!scores) {
      this.values = null;
      return null;
    }
    if (!this.values) {
      this.values = { ...scores };
    } else {
      const alpha = delayMs <= 0 ? 1 : 1 - Math.exp(-(timestamp - this.timestamp) / delayMs);
      for (const [name, score] of Object.entries(scores)) {
        const current = this.values[name] ?? score;
        this.values[name] = current + (score - current) * alpha;
      }
    }
    this.timestamp = timestamp;
    return { ...this.values };
  }
}

export class DetectionSmoother {
  constructor() {
    this.reset();
  }

  reset() {
    this.streams = {
      poseScreen: new LandmarkStream(),
      poseWorld: new LandmarkStream(),
      faceScreen: new LandmarkStream(),
      faceBlendshapes: new ScoreStream(),
      leftHandScreen: new LandmarkStream(),
      leftHandWorld: new LandmarkStream(),
      rightHandScreen: new LandmarkStream(),
      rightHandWorld: new LandmarkStream(),
    };
    // Résultat lissé courant, recalculé partie par partie quand un nouveau
    // résultat (nouveau timestamp) arrive.
    this.output = { pose: null, face: null, hands: { left: null, right: null }, timestamps: {} };
    this.lastTimestamps = { pose: null, face: null, hands: null };
  }

  // `detection` : sortie de TrackerManager.getLatest(). `delays` : réglages
  // de lissage { pose, face, hand } en ms.
  update(detection, delays) {
    const { timestamps } = detection;
    const s = this.streams;

    if (timestamps.pose !== this.lastTimestamps.pose) {
      const pose = detection.pose;
      const t = timestamps.pose;
      const screen = s.poseScreen.update(pose?.screen, t, delays.pose);
      const world = s.poseWorld.update(pose?.world, t, delays.pose);
      this.output.pose = screen && world ? { screen, world } : null;
    }

    if (timestamps.face !== this.lastTimestamps.face) {
      const face = detection.face;
      const t = timestamps.face;
      const screen = s.faceScreen.update(face?.screen, t, delays.face);
      const blendshapes = s.faceBlendshapes.update(face?.blendshapes, t, delays.face);
      this.output.face = screen ? { screen, blendshapes } : null;
    }

    if (timestamps.hands !== this.lastTimestamps.hands) {
      const t = timestamps.hands;
      for (const side of ['left', 'right']) {
        const hand = detection.hands[side];
        const screen = s[`${side}HandScreen`].update(hand?.screen, t, delays.hand);
        const world = s[`${side}HandWorld`].update(hand?.world, t, delays.hand);
        this.output.hands[side] = screen && world ? { screen, world } : null;
      }
    }

    this.lastTimestamps = { ...timestamps };
    this.output.timestamps = { ...timestamps };
    return this.output;
  }
}
