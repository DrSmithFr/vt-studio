import { BODY_JOINTS } from '../core/JointSchema.js';

const STORAGE_KEY = 'vt-studio.settings';
const SETTINGS_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

// Réglages par défaut de toute l'application. C'est aussi le schéma : à
// l'import ou au chargement depuis localStorage, seules les clés présentes
// ici sont reprises (voir mergeInto), ce qui tolère un fichier ancien ou
// partiel.
export function createDefaultSettings() {
  return {
    // Couches visibles (menu Views et panneau gauche).
    layers: {
      camera: true,
      rawDetections: false,
      smoothedDetections: true,
      keyPose: false,
      model: true,
    },

    // Panneaux de l'interface (menu Views).
    panels: {
      left: true,
      right: true,
      jointDock: true,
    },

    // Menu Settings.
    general: {
      // 'auto' : jambes figées en pose de repos si peu visibles ;
      // 'seated' : toujours figées ; 'standing' : toujours suivies.
      framing: 'auto',
      mirrorCamera: true,
    },

    // Panneau gauche : détection.
    detection: {
      mode: 'composite', // 'holistic' | 'composite'
      holisticBackend: 'worker', // 'worker' | 'remote'
      backends: { pose: 'worker', face: 'worker', hand: 'worker' },
      // Corps plus espacé, visage normal, mains plus fréquentes.
      fps: { holistic: 30, pose: 15, face: 30, hand: 45 },
      remoteUrl: '',
    },

    // Panneau gauche : lissage des landmarks, constante de temps en ms.
    smoothing: {
      pose: 80,
      face: 50,
      hand: 40,
    },

    // Panneau gauche : position par défaut (pose de repos), corps / mains.
    restPose: {
      body: 'armsDown', // 'armsDown' | 'handsOnLap' | 'tPose'
      hands: 'relaxed', // 'relaxed' | 'open' | 'fist'
    },

    // Panneau droit : retargeting (même structure que RetargetConfig).
    retarget: {
      sideInversion: { arms: false, hands: false, legs: false },
      axisInvert: {},
      amplification: {},
    },

    // Panneau droit : butées (même structure que JointConstraints.limits).
    constraints: {},

    // Panneau droit : capsule du torse (CollisionAvoidance).
    collision: {
      torsoRadius: 0.14,
    },

    // Panneau droit : transform du modèle (VrmController.setTransform).
    model: {
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      scale: 1,
    },

    // Menu flottant du bas : par articulation, offset (radians) et ressort
    // de retour à la KeyPose.
    joints: Object.fromEntries(
      BODY_JOINTS.map((name) => [
        name,
        { offset: { x: 0, y: 0, z: 0 }, stiffness: 120, damping: 18 },
      ]),
    ),
  };
}

// Copie récursivement dans `target` les valeurs de `source` dont la clé
// existe déjà dans `target` (et de même type). Les objets de `target` sont
// conservés tels quels : les références partagées avec les sous-systèmes
// (RetargetConfig, JointConstraints…) et avec les contrôles lil-gui restent
// valides après un import ou une réinitialisation.
function mergeInto(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(target)) {
    if (!(key in source)) continue;
    const current = target[key];
    const incoming = source[key];
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      mergeInto(current, incoming);
    } else if (Array.isArray(current) && Array.isArray(incoming)) {
      current.splice(0, current.length, ...incoming);
    } else if (typeof incoming === typeof current) {
      target[key] = incoming;
    }
  }
}

export class SettingsStore {
  // `defaults` peut être complété par les sous-systèmes avant le chargement
  // (ex. groupes miroir de RetargetConfig, limites de JointConstraints), pour
  // que ces clés fassent partie du schéma.
  constructor(defaults = createDefaultSettings()) {
    this.defaults = structuredClone(defaults);
    this.data = structuredClone(defaults);
    this.listeners = new Set();
    this.saveTimer = null;
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) mergeInto(this.data, JSON.parse(raw).settings);
    } catch (error) {
      console.warn('Réglages locaux illisibles, valeurs par défaut utilisées.', error);
    }
  }

  // À appeler après toute modification de `data` : notifie les abonnés et
  // planifie la sauvegarde locale.
  commit() {
    for (const listener of this.listeners) listener(this.data);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#save(), SAVE_DEBOUNCE_MS);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset() {
    mergeInto(this.data, structuredClone(this.defaults));
    this.commit();
  }

  toJSON() {
    return { version: SETTINGS_VERSION, settings: this.data };
  }

  import(json) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    mergeInto(this.data, parsed.settings ?? parsed);
    this.commit();
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
    } catch (error) {
      console.warn('Sauvegarde locale des réglages impossible.', error);
    }
  }
}
