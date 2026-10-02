import { ControlPanel } from './controls.js';

const BACKEND_OPTIONS = { Worker: 'worker', Distant: 'remote' };

const DETECTOR_LABELS = { holistic: 'Holistic', pose: 'Corps', face: 'Visage', hand: 'Mains' };

function formatStats(stats) {
  if (!stats) return '—';
  if (stats.status === 'loading') return 'chargement…';
  if (stats.status === 'error') return `erreur : ${stats.message}`;
  const inference = stats.inferenceMs === null ? '—' : `${stats.inferenceMs.toFixed(0)} ms`;
  return `${stats.fps.toFixed(0)} fps · ${inference} · ${stats.delegate}`;
}

// Panneau gauche : position par défaut, détection, affichage, lissage.
export class LeftPanel {
  // `actions` : { calibrateBody(), calibrateHands(), resetCalibration() } —
  // fournies par main.js.
  constructor(container, store, actions = {}) {
    const settings = store.data;
    this.panel = new ControlPanel(container, {
      onChange: () => {
        this.#updateModeVisibility(store.data);
        store.commit();
      },
    });

    // --- Position par défaut : pose de repos + calibration, corps / mains.
    const rest = this.panel.section('Position par défaut');
    rest.select(
      settings.restPose,
      'body',
      { 'Bras le long du corps': 'armsDown', 'Mains sur les cuisses': 'handsOnLap', 'T-pose': 'tPose' },
      { label: 'Repos du corps' },
    );
    rest.select(settings.restPose, 'hands', { Détendues: 'relaxed', Ouvertes: 'open', Poing: 'fist' }, {
      label: 'Repos des mains',
    });
    // Calibration : la posture tenue pendant la capture devient le zéro des
    // valeurs relatives (corps : droit, face caméra ; mains : ouvertes,
    // doigts tendus et serrés).
    this.calibrationButtons = {
      body: rest.button('Calibrer le corps', () => actions.calibrateBody?.()),
      hands: rest.button('Calibrer les mains', () => actions.calibrateHands?.()),
    };
    this.calibrationStatus = rest.readout('Calibration');
    rest.button('Réinitialiser la calibration', () => actions.resetCalibration?.());

    // --- Détection.
    const detection = this.panel.section('Détection');
    const d = settings.detection;
    detection.toggle(d, 'enabled', { label: 'Détection active' }).tooltip('Raccourci : D');
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
      detection.select(d, 'poseModel', { Lite: 'lite', Full: 'full', Heavy: 'heavy' }, { label: 'Modèle corps' }),
    ];
    detection
      .text(d, 'remoteUrl', { label: 'Serveur distant', placeholder: 'wss://hôte:port' })
      .tooltip('Exécution distante : phase 7 de la reconstruction.');

    // Statistiques temps réel par détecteur (voir setStats).
    const stats = detection.section('Statistiques');
    this.statReadouts = Object.fromEntries(
      Object.entries(DETECTOR_LABELS).map(([id, label]) => [id, stats.readout(label)]),
    );

    // --- Affichage : mêmes réglages que le menu Views.
    const display = this.panel.section('Affichage');
    display.toggle(settings.layers, 'camera', { label: 'Caméra' });
    display.toggle(settings.layers, 'rawDetections', { label: 'Détections brutes' });
    display.toggle(settings.layers, 'smoothedDetections', { label: 'Détection lissée' });

    // --- Lissage des landmarks, constante de temps par détecteur.
    const smoothing = this.panel.section('Lissage');
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
    this.statReadouts.holistic.show(holistic);
    for (const id of ['pose', 'face', 'hand']) this.statReadouts[id].show(!holistic);
  }

  // `labels` : { body, hands } — texte des boutons (compte à rebours) ;
  // `calibration` : réglages de calibration (état affiché).
  setCalibrationState(labels, calibration) {
    this.calibrationButtons.body.setLabel(labels.body ?? 'Calibrer le corps');
    this.calibrationButtons.hands.setLabel(labels.hands ?? 'Calibrer les mains');
    const state = (done) => (done ? 'fait' : 'par défaut');
    this.calibrationStatus.set(`corps ${state(calibration.bodyCalibrated)} · mains ${state(calibration.handsCalibrated)}`);
  }

  // `stats` : TrackerManager.getStats().
  setStats(stats) {
    for (const [id, readout] of Object.entries(this.statReadouts)) {
      readout.set(formatStats(stats.find((s) => s.id === id)));
    }
  }

  refresh(settings) {
    this.#updateModeVisibility(settings);
    this.panel.refresh();
  }
}
