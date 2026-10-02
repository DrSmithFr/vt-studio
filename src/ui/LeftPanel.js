import { ControlPanel, pendingBadge } from './controls.js';

const BACKEND_OPTIONS = { Worker: 'worker', Distant: 'remote' };

// Panneau gauche : position par défaut, détection, affichage, lissage.
export class LeftPanel {
  // `actions` : { calibrateBody(), calibrateHands() } — fournies par main.js.
  constructor(container, store, actions = {}) {
    const settings = store.data;
    this.panel = new ControlPanel(container, {
      onChange: () => {
        this.#updateModeVisibility(store.data);
        store.commit();
      },
    });

    // --- Position par défaut : pose de repos + calibration, corps / mains.
    const rest = this.panel.section('Position par défaut', { badge: pendingBadge(4) });
    rest.select(
      settings.restPose,
      'body',
      { 'Bras le long du corps': 'armsDown', 'Mains sur les cuisses': 'handsOnLap', 'T-pose': 'tPose' },
      { label: 'Repos du corps' },
    );
    rest.select(settings.restPose, 'hands', { Détendues: 'relaxed', Ouvertes: 'open', Poing: 'fist' }, {
      label: 'Repos des mains',
    });
    rest.button('Calibrer le corps', () => actions.calibrateBody?.()).disable();
    rest.button('Calibrer les mains', () => actions.calibrateHands?.()).disable();

    // --- Détection.
    const detection = this.panel.section('Détection', { badge: pendingBadge(3) });
    const d = settings.detection;
    detection.select(d, 'mode', { Composite: 'composite', Holistic: 'holistic' }, { label: 'Mode' });
    this.holisticControls = [
      detection.select(d, 'holisticBackend', BACKEND_OPTIONS, { label: 'Exécution' }),
      detection.slider(d.fps, 'holistic', { label: 'FPS', min: 1, max: 60, step: 1 }),
    ];
    this.compositeControls = [
      detection.select(d.backends, 'pose', BACKEND_OPTIONS, { label: 'Corps' }),
      detection.select(d.backends, 'face', BACKEND_OPTIONS, { label: 'Visage' }),
      detection.select(d.backends, 'hand', BACKEND_OPTIONS, { label: 'Mains' }),
      detection.slider(d.fps, 'pose', { label: 'FPS corps', min: 1, max: 60, step: 1 }),
      detection.slider(d.fps, 'face', { label: 'FPS visage', min: 1, max: 60, step: 1 }),
      detection.slider(d.fps, 'hand', { label: 'FPS mains', min: 1, max: 60, step: 1 }),
    ];
    detection.text(d, 'remoteUrl', { label: 'Serveur distant', placeholder: 'wss://hôte:port' });

    // --- Affichage : mêmes réglages que le menu Views.
    const display = this.panel.section('Affichage');
    display.toggle(settings.layers, 'camera', { label: 'Caméra' });
    display.toggle(settings.layers, 'rawDetections', { label: 'Détections brutes' });
    display.toggle(settings.layers, 'smoothedDetections', { label: 'Détection lissée' });

    // --- Lissage des landmarks, constante de temps par détecteur.
    const smoothing = this.panel.section('Lissage', { badge: pendingBadge(3) });
    smoothing.slider(settings.smoothing, 'pose', { label: 'Corps', min: 0, max: 500, step: 5, unit: 'ms' });
    smoothing.slider(settings.smoothing, 'face', { label: 'Visage', min: 0, max: 500, step: 5, unit: 'ms' });
    smoothing.slider(settings.smoothing, 'hand', { label: 'Mains', min: 0, max: 500, step: 5, unit: 'ms' });

    this.#updateModeVisibility(settings);
  }

  // Seuls les contrôles du mode de détection actif sont affichés.
  #updateModeVisibility(settings) {
    const holistic = settings.detection.mode === 'holistic';
    for (const control of this.holisticControls) control.show(holistic);
    for (const control of this.compositeControls) control.show(!holistic);
  }

  refresh(settings) {
    this.#updateModeVisibility(settings);
    this.panel.refresh();
  }
}
