import { FINGER_JOINTS, ROTATION_JOINTS } from '../core/JointSchema.js';
import { CALIBRATED_KEYS, fingerFeatureKey } from '../core/FeatureSchema.js';

function defaultSpring(joint) {
  if (joint === 'hips') return { stiffness: 150, damping: 24 };
  if (FINGER_JOINTS.includes(joint)) return { stiffness: 600, damping: 46 };
  return { stiffness: 400, damping: 38 };
}

// Références de calibration par défaut : zéro partout, sauf le pouce dont la
// position naturelle main ouverte est écartée et légèrement fléchie par
// rapport au plan de la paume (valeurs approximatives, remplacées par la
// calibration des mains).
function defaultCalibration() {
  const body = Object.fromEntries(CALIBRATED_KEYS.body.map((key) => [key, 0]));
  const hands = Object.fromEntries(CALIBRATED_KEYS.hands.map((key) => [key, 0]));
  for (const side of ['left', 'right']) {
    hands[fingerFeatureKey(side, 'thumb', 'baseSpread')] = 0.6;
    hands[fingerFeatureKey(side, 'thumb', 'baseFlex')] = 0.3;
  }
  return {
    body,
    hands,
    bodyCalibrated: false,
    handsCalibrated: false,
    // Repos des mains : 'auto' = repos naturel appris en continu
    // (HandRestTracker), 'manual' = capture main ouverte (bouton).
    handsMode: 'auto',
    // Apprentissage du mode auto, sauvegardé pour reprendre au rechargement.
    handsAuto: { ...hands },
    handsAutoSeconds: { left: 0, right: 0 },
  };
}

const STORAGE_KEY = 'vt-studio.settings';
const SETTINGS_VERSION = 2;
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
      // Avatar en miroir : la main droite levée anime le bras de l'avatar
      // situé du même côté de l'écran que dans un miroir.
      mirrorAvatar: true,
    },

    // Panneau gauche : détection.
    detection: {
      // Désactivée au démarrage : aucun worker ni modèle MediaPipe chargé
      // tant que l'utilisateur ne l'active pas.
      enabled: false,
      mode: 'composite', // 'holistic' | 'composite'
      holisticBackend: 'worker', // 'worker' | 'remote'
      backends: { pose: 'worker', face: 'worker', hand: 'worker' },
      // Corps plus espacé, visage normal, mains plus fréquentes.
      fps: { holistic: 30, pose: 15, face: 30, hand: 45 },
      poseModel: 'full', // 'lite' | 'full' | 'heavy' (mode Composite)
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

    // Panneau gauche : calibration (valeurs relatives de référence, voir
    // FeatureSchema). `bodyCalibrated` conditionne le déplacement vertical.
    calibration: defaultCalibration(),

    // Panneau droit : déplacement du bassin (m par unité de valeur
    // relative : largeur d'écran pour le latéral, hauteur pour le vertical).
    motion: {
      lateralRange: 1.0,
      verticalRange: 0.8,
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
    // de retour à la KeyPose (voir SpringFollower : taux d'amortissement
    // c / (2√k) ≈ 0,95, réponse à 90 % en ~180 ms pour le corps, plus
    // rapide pour les doigts). « hips » règle aussi le déplacement du
    // bassin, plus doux.
    joints: Object.fromEntries(
      ROTATION_JOINTS.map((name) => [name, { offset: { x: 0, y: 0, z: 0 }, ...defaultSpring(name) }]),
    ),
  };
}

// Mise à niveau d'un fichier de réglages d'une version antérieure, avant
// fusion. v1 → v2 : la raideur / l'amortissement des articulations étaient
// enregistrés sans être utilisés (valeurs provisoires), on les abandonne au
// profit des nouvelles valeurs par défaut.
function migrate(file) {
  const version = file?.version ?? 1;
  const settings = structuredClone(file?.settings ?? file ?? {});
  if (version < 2 && settings.joints) {
    for (const joint of Object.values(settings.joints)) {
      delete joint.stiffness;
      delete joint.damping;
    }
  }
  return settings;
}

// Copie récursivement dans `target` les valeurs de `source` dont la clé
// existe déjà dans `target` (et de même type). Les objets de `target` sont
// conservés tels quels : les références partagées avec les sous-systèmes
// (RetargetConfig, JointConstraints…) et avec les contrôles des panneaux restent
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
      if (raw) mergeInto(this.data, migrate(JSON.parse(raw)));
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

  // Sauvegarde différée sans notifier les abonnés : pour des données mises à
  // jour en continu (ex. repos des mains appris), qui n'ont pas à
  // resynchroniser l'interface.
  saveSoon() {
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
    mergeInto(this.data, migrate(parsed));
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
