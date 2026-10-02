import { createEmbeddedGui, markPending, refreshGui } from './guiHelpers.js';

const BACKEND_OPTIONS = { 'Web Worker': 'worker', 'Machine distante': 'remote' };

// Panneau gauche : position par défaut, détection, affichage, lissage.
export class LeftPanel {
  // `actions` : { calibrateBody(), calibrateHands() } — fournies par main.js.
  constructor(container, store, actions = {}) {
    const settings = store.data;
    this.gui = createEmbeddedGui(container, 'Capture', () => this.#onChange(store));

    // --- Position par défaut : pose de repos + calibration, corps / mains.
    const rest = this.gui.addFolder('Position par défaut');
    rest
      .add(settings.restPose, 'body', {
        'Bras le long du corps': 'armsDown',
        'Mains sur les cuisses': 'handsOnLap',
        'T-pose': 'tPose',
      })
      .name('Repos du corps');
    rest
      .add(settings.restPose, 'hands', { Détendues: 'relaxed', Ouvertes: 'open', Poing: 'fist' })
      .name('Repos des mains');
    rest.add({ calibrate: () => actions.calibrateBody?.() }, 'calibrate').name('Calibrer le corps').disable();
    rest.add({ calibrate: () => actions.calibrateHands?.() }, 'calibrate').name('Calibrer les mains').disable();
    markPending(rest, 4);

    // --- Détection.
    const detection = this.gui.addFolder('Détection');
    const d = settings.detection;
    detection.add(d, 'mode', { Composite: 'composite', Holistic: 'holistic' }).name('Mode');
    this.holisticControllers = [
      detection.add(d, 'holisticBackend', BACKEND_OPTIONS).name('Exécution'),
      detection.add(d.fps, 'holistic', 1, 60, 1).name('FPS'),
    ];
    this.compositeControllers = [
      detection.add(d.backends, 'pose', BACKEND_OPTIONS).name('Corps'),
      detection.add(d.backends, 'face', BACKEND_OPTIONS).name('Visage'),
      detection.add(d.backends, 'hand', BACKEND_OPTIONS).name('Mains'),
      detection.add(d.fps, 'pose', 1, 60, 1).name('FPS corps'),
      detection.add(d.fps, 'face', 1, 60, 1).name('FPS visage'),
      detection.add(d.fps, 'hand', 1, 60, 1).name('FPS mains'),
    ];
    detection.add(d, 'remoteUrl').name('Serveur distant');
    markPending(detection, 3);

    // --- Affichage : mêmes réglages que le menu Views.
    const display = this.gui.addFolder('Affichage');
    display.add(settings.layers, 'camera').name('Caméra');
    display.add(settings.layers, 'rawDetections').name('Détections brutes');
    display.add(settings.layers, 'smoothedDetections').name('Détection lissée');

    // --- Lissage des landmarks, constante de temps par détecteur.
    const smoothing = this.gui.addFolder('Lissage (ms)');
    smoothing.add(settings.smoothing, 'pose', 0, 500, 5).name('Corps');
    smoothing.add(settings.smoothing, 'face', 0, 500, 5).name('Visage');
    smoothing.add(settings.smoothing, 'hand', 0, 500, 5).name('Mains');
    markPending(smoothing, 3);

    this.#updateModeVisibility(settings);
  }

  #onChange(store) {
    this.#updateModeVisibility(store.data);
    store.commit();
  }

  // Seuls les contrôles du mode de détection actif sont affichés.
  #updateModeVisibility(settings) {
    const holistic = settings.detection.mode === 'holistic';
    for (const c of this.holisticControllers) c.show(holistic);
    for (const c of this.compositeControllers) c.show(!holistic);
  }

  refresh(settings) {
    this.#updateModeVisibility(settings);
    refreshGui(this.gui);
  }
}
