import { CALIBRATED_KEYS } from './FeatureSchema.js';

// Position de repos naturelle des doigts, apprise en continu : moyenne
// glissante sur ~60 s des valeurs brutes des doigts (FeatureExtractor), qui
// sert de zéro de référence en mode « Auto ». Les doigts de chacun sont
// naturellement un peu courbés au repos : sans ça, cette courbure serait lue
// comme une flexion et donnerait une animation étrange.
//
// La moyenne n'est mise à jour que quand la main est au repos :
//  - les doigts bougent peu (vitesse moyenne sous un seuil) ;
//  - et, passé une courte phase d'apprentissage, la main est proche du repos
//    déjà appris : un geste tenu immobile (poing serré) ne dérive pas vers
//    le neutre.

const WINDOW_S = 60;
const WARMUP_S = 10;
const MAX_SPEED = 0.5; // rad/s, vitesse moyenne des doigts
const MAX_DEVIATION = 0.6; // rad, écart moyen au repos appris
const SPEED_SMOOTHING_S = 0.2;

const SIDES = ['left', 'right'];
const KEYS = Object.fromEntries(SIDES.map((side) => [side, CALIBRATED_KEYS.hands.filter((k) => k.startsWith(`${side}_`))]));

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class HandRestTracker {
  // `initial` : référence de départ { [clé]: valeur } (réglages).
  constructor(initial) {
    this.initial = { ...initial };
    this.reset();
  }

  reset() {
    this.reference = { ...this.initial };
    // Moyenne pondérée à oubli exponentiel, par côté : somme des valeurs
    // pondérées et somme des poids (en secondes de repos observées).
    this.state = Object.fromEntries(
      SIDES.map((side) => [side, { sums: {}, weight: 0, previous: null, speed: 0 }]),
    );
  }

  // Reprend un apprentissage sauvegardé : `reference` et le nombre de
  // secondes déjà apprises par côté.
  seed(reference, seconds) {
    for (const side of SIDES) {
      const weight = Math.min(seconds?.[side] ?? 0, WINDOW_S);
      const state = this.state[side];
      state.weight = weight;
      for (const key of KEYS[side]) {
        const value = reference[key] ?? this.initial[key];
        this.reference[key] = value;
        state.sums[key] = { sin: Math.sin(value) * weight, cos: Math.cos(value) * weight };
      }
    }
  }

  // Secondes de repos apprises par côté (plafonnées à la fenêtre).
  get learnedSeconds() {
    return Object.fromEntries(SIDES.map((side) => [side, Math.min(this.state[side].weight, WINDOW_S)]));
  }

  // `raw` : valeurs brutes de FeatureExtractor ; `has` : côtés détectés.
  update(raw, has, dtMs) {
    const dt = Math.min(dtMs, 100) / 1000;
    if (dt <= 0) return;
    const decay = Math.exp(-dt / WINDOW_S);

    for (const side of SIDES) {
      const state = this.state[side];
      if (!has[side]) {
        state.previous = null;
        continue;
      }
      const keys = KEYS[side];

      // Vitesse moyenne des doigts, lissée.
      if (state.previous) {
        const instant = keys.reduce((sum, k) => sum + Math.abs(wrap(raw[k] - state.previous[k])), 0) / keys.length / dt;
        state.speed += (instant - state.speed) * (1 - Math.exp(-dt / SPEED_SMOOTHING_S));
      }
      state.previous = Object.fromEntries(keys.map((k) => [k, raw[k]]));
      if (state.speed > MAX_SPEED) continue;

      if (state.weight >= WARMUP_S) {
        const deviation = keys.reduce((sum, k) => sum + Math.abs(wrap(raw[k] - this.reference[k])), 0) / keys.length;
        if (deviation > MAX_DEVIATION) continue;
      }

      // Moyenne circulaire pondérée, avec oubli au-delà de la fenêtre.
      state.weight = state.weight * decay + dt;
      for (const key of keys) {
        const sum = (state.sums[key] ??= { sin: 0, cos: 0 });
        sum.sin = sum.sin * decay + Math.sin(raw[key]) * dt;
        sum.cos = sum.cos * decay + Math.cos(raw[key]) * dt;
        this.reference[key] = Math.atan2(sum.sin, sum.cos);
      }
    }
  }
}
