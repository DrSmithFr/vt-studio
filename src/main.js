import './style.css';
import { ALL_CHANNELS, AXES, ROTATION_JOINTS } from './core/JointSchema.js';
import { CALIBRATED_KEYS } from './core/FeatureSchema.js';
import { FeatureExtractor } from './core/FeatureExtractor.js';
import { KeyPoseBuilder } from './core/KeyPoseBuilder.js';
import { HandRestTracker } from './core/HandRestTracker.js';
import { SkeletonSmoother } from './core/Smoother.js';
import { DetectionSmoother } from './core/DetectionSmoother.js';
import { RetargetConfig, applyRetargeting } from './core/RetargetConfig.js';
import { JointConstraints } from './core/JointConstraints.js';
import { TrackerManager } from './tracking/TrackerManager.js';
import { VrmController } from './vrm/VrmController.js';
import { SceneManager } from './render/SceneManager.js';
import { OverlayRenderer } from './render/OverlayRenderer.js';
import { KeyPoseSkeleton } from './render/KeyPoseSkeleton.js';
import { SettingsStore, createDefaultSettings } from './ui/SettingsStore.js';
import { MenuBar } from './ui/MenuBar.js';
import { LeftPanel } from './ui/LeftPanel.js';
import { RightPanel } from './ui/RightPanel.js';
import { JointDock } from './ui/JointDock.js';

// Modèles fournis dans public/models (menu Fichier). Le premier est chargé
// au démarrage.
const BUNDLED_MODELS = [
  { label: 'Avatar (VRM 1.0)', url: '/models/avatar.vrm' },
  { label: 'Avatar (VRM 0.x)', url: '/models/avatar_v0.vrm' },
];

// Au-delà, on considère que l'onglet était en arrière-plan : on ne simule pas
// un énorme pas de temps (les spring bones du VRM exploseraient).
const MAX_DT_SECONDS = 0.1;

const app = document.getElementById('app');
const video = document.getElementById('webcam-source');
const sceneCanvas = document.getElementById('scene-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const statusBar = document.getElementById('status-bar');
const modelFileInput = document.getElementById('model-file');
const settingsFileInput = document.getElementById('settings-file');

const sceneManager = new SceneManager(sceneCanvas);
const vrmController = new VrmController(sceneManager.scene);
const overlayRenderer = new OverlayRenderer(overlayCanvas);
const trackerManager = new TrackerManager(video);
const detectionSmoother = new DetectionSmoother();
const featureExtractor = new FeatureExtractor();
const keyPoseBuilder = new KeyPoseBuilder();
const keyPoseSkeleton = new KeyPoseSkeleton(sceneManager.scene);
// Suivi de la KeyPose par le modèle (lissage par articulation, remplacé par
// un ressort amorti en phase 6). Le déplacement du bassin est un canal
// supplémentaire, non angulaire.
const skeletonSmoother = new SkeletonSmoother([...ALL_CHANNELS, 'hipsOffset'], 80, ROTATION_JOINTS);
const retargetConfig = new RetargetConfig();
const jointConstraints = new JointConstraints();

// --- Réglages -----------------------------------------------------------------
// Les valeurs par défaut des sous-systèmes (groupes miroir, butées) font
// partie du schéma des réglages ; ensuite, les sous-systèmes travaillent
// directement sur les objets du store (mêmes références que les contrôles
// de l'interface).

const defaults = createDefaultSettings();
defaults.retarget.axisInvert = structuredClone(retargetConfig.axisInvert);
defaults.retarget.amplification = structuredClone(retargetConfig.amplification);
defaults.constraints = structuredClone(jointConstraints.limits);

const store = new SettingsStore(defaults);
store.load();
const settings = store.data;

// Repos naturel des doigts (mode auto), repris là où il en était.
const handRestTracker = new HandRestTracker(store.defaults.calibration.hands);
handRestTracker.seed(settings.calibration.handsAuto, settings.calibration.handsAutoSeconds);
const HAND_REST_SAVE_INTERVAL_MS = 10000;
let lastHandRestSaveMs = performance.now();

retargetConfig.sideInversion = settings.retarget.sideInversion;
retargetConfig.axisInvert = settings.retarget.axisInvert;
retargetConfig.amplification = settings.retarget.amplification;
jointConstraints.limits = settings.constraints;

// Applique les réglages qui ne sont pas lus directement à chaque frame.
function applySettings() {
  app.classList.toggle('hide-left', !settings.panels.left);
  app.classList.toggle('hide-right', !settings.panels.right);
  app.classList.toggle('hide-joint-dock', !settings.panels.jointDock);
  app.classList.toggle('hide-camera', !settings.layers.camera);
  app.classList.toggle('mirror-camera', settings.general.mirrorCamera);

  // Caméra visible : fond 3D transparent pour la voir derrière le modèle.
  sceneManager.setBackgroundVisible(!settings.layers.camera);
  vrmController.setVisible(settings.layers.model);
  vrmController.setTransform(settings.model);
  featureExtractor.torsoRadius = settings.collision.torsoRadius;
  // Ne recrée les détecteurs que si le mode, un backend ou le modèle change.
  const wasActive = trackerManager.active;
  trackerManager.configure(settings.detection);
  // Détection coupée : le modèle revient en pose de repos et les lisseurs
  // repartent de zéro à la prochaine activation.
  if (wasActive && !trackerManager.active) {
    vrmController.resetPose();
    keyPoseSkeleton.update({}, null, false);
    skeletonSmoother.reset();
    detectionSmoother.reset();
    overlayRenderer.clear();
  }
  renderStatus();
}

store.subscribe(applySettings);

// --- Interface ------------------------------------------------------------------

const leftPanel = new LeftPanel(document.getElementById('left-panel'), store, {
  calibrateBody: () => startCalibration('body'),
  calibrateHands: () => startCalibration('hands'),
  resetCalibration,
});
const rightPanel = new RightPanel(document.getElementById('right-panel'), store);
const jointDock = new JointDock(document.getElementById('joint-dock'), store);

// Resynchronise les contrôles après un changement venu d'ailleurs (menu,
// import, réinitialisation).
function refreshUi() {
  // Après un import ou une réinitialisation, le repos appris des mains
  // repart des valeurs des réglages.
  handRestTracker.seed(settings.calibration.handsAuto, settings.calibration.handsAutoSeconds);
  leftPanel.refresh(settings);
  rightPanel.refresh();
  jointDock.refresh();
  refreshCalibrationUi();
}

function toggle(obj, key) {
  obj[key] = !obj[key];
  store.commit();
  refreshUi();
}

function choose(obj, key, value) {
  obj[key] = value;
  store.commit();
  refreshUi();
}

const toggleEntry = (label, obj, key) => ({ label, checked: () => obj[key], action: () => toggle(obj, key) });
const choiceEntry = (label, obj, key, value) => ({
  label,
  checked: () => obj[key] === value,
  action: () => choose(obj, key, value),
});

new MenuBar(document.getElementById('menubar'), [
  {
    label: 'Fichier',
    items: [
      { label: 'Ouvrir un modèle VRM…', shortcut: 'Ctrl+O', action: () => modelFileInput.click() },
      {
        label: 'Modèles fournis',
        submenu: BUNDLED_MODELS.map(({ label, url }) => ({ label, action: () => loadModel(url, label) })),
      },
      { separator: true },
      { label: 'Importer les réglages…', action: () => settingsFileInput.click() },
      { label: 'Exporter les réglages', action: exportSettings },
    ],
  },
  {
    label: 'Views',
    items: [
      toggleEntry('Caméra', settings.layers, 'camera'),
      toggleEntry('Détections brutes', settings.layers, 'rawDetections'),
      toggleEntry('Détection lissée', settings.layers, 'smoothedDetections'),
      toggleEntry('Squelette KeyPose', settings.layers, 'keyPose'),
      toggleEntry('Modèle', settings.layers, 'model'),
      { separator: true },
      toggleEntry('Panneau gauche', settings.panels, 'left'),
      toggleEntry('Panneau droit', settings.panels, 'right'),
      toggleEntry('Menu des articulations', settings.panels, 'jointDock'),
    ],
  },
  {
    label: 'Settings',
    items: [
      {
        label: 'Cadrage',
        submenu: [
          choiceEntry('Automatique', settings.general, 'framing', 'auto'),
          choiceEntry('Assis (buste)', settings.general, 'framing', 'seated'),
          choiceEntry('Debout (corps entier)', settings.general, 'framing', 'standing'),
        ],
      },
      toggleEntry('Détection active', settings.detection, 'enabled'),
      toggleEntry('Caméra en miroir', settings.general, 'mirrorCamera'),
      toggleEntry('Avatar en miroir', settings.general, 'mirrorAvatar'),
      { separator: true },
      {
        label: 'Réinitialiser tous les réglages',
        action: () => {
          if (!confirm('Remettre tous les réglages à leurs valeurs par défaut ?')) return;
          store.reset();
          refreshUi();
        },
      },
    ],
  },
]);

function exportSettings() {
  const blob = new Blob([JSON.stringify(store.toJSON(), null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'vt-studio-reglages.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

settingsFileInput.addEventListener('change', async () => {
  const file = settingsFileInput.files[0];
  settingsFileInput.value = '';
  if (!file) return;
  try {
    store.import(await file.text());
    refreshUi();
  } catch (error) {
    console.error(error);
    alert(`Fichier de réglages illisible : ${error.message}`);
  }
});

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    modelFileInput.click();
    return;
  }
  // D : active / désactive la détection (hors saisie dans un champ).
  const typing = event.target.closest?.('input, select, textarea');
  if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'd') {
    toggle(settings.detection, 'enabled');
  }
});

// --- Barre de statut ------------------------------------------------------------

const status = { model: 'aucun modèle', tracking: 'suivi : initialisation…', fps: 0 };

function renderStatus() {
  const tracking = !trackingReady
    ? status.tracking
    : trackerManager.active
      ? 'détection active'
      : 'détection désactivée (D pour activer)';
  statusBar.textContent = `${status.model}  ·  ${tracking}  ·  ${status.fps.toFixed(0)} fps`;
}

// --- Chargement du modèle ---------------------------------------------------------

async function loadModel(source, label) {
  status.model = `chargement de ${label}…`;
  renderStatus();
  try {
    if (source instanceof File) {
      await vrmController.loadFromFile(source);
    } else {
      await vrmController.loadFromUrl(source);
    }
    status.model = `${label} (VRM ${vrmController.metaVersion === '0' ? '0.x' : '1.0'})`;
    // Transform et visibilité s'appliquent au modèle courant : à refaire
    // pour le nouveau. Proportions et squelette dupliqué dépendent du modèle.
    applySettings();
    const rest = vrmController.getRestInfo();
    if (rest) keyPoseBuilder.setModelRest(rest);
    keyPoseSkeleton.attach(vrmController);
  } catch (error) {
    console.error(error);
    status.model = `échec du chargement de ${label}`;
  }
  renderStatus();
}

modelFileInput.addEventListener('change', () => {
  const file = modelFileInput.files[0];
  if (file) loadModel(file, file.name);
  modelFileInput.value = '';
});

// Glisser-déposer d'un .vrm n'importe où sur la page.
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) app.classList.remove('dragging');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  const file = [...event.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith('.vrm'));
  if (file) loadModel(file, file.name);
});

// --- Suivi ---------------------------------------------------------------------

let trackingReady = false;

// Les détecteurs se chargent dans leurs workers dès applySettings() ; ici,
// seule la webcam est attendue.
async function startTracking() {
  try {
    status.tracking = 'suivi : en attente de la webcam…';
    renderStatus();
    await trackerManager.startWebcam();
    trackingReady = true;
    status.tracking = 'suivi : actif';
  } catch (error) {
    console.error(error);
    status.tracking = `suivi indisponible (${error.message ?? error.name ?? 'erreur'})`;
  }
  renderStatus();
}

function videoAspect() {
  const { width, height } = trackerManager.videoSize;
  return width && height ? width / height : 16 / 9;
}

// --- Calibration -----------------------------------------------------------------
// Compte à rebours (le temps de prendre la posture), puis moyenne des valeurs
// brutes sur une courte fenêtre : elles deviennent le zéro de référence.

const CALIBRATION_COUNTDOWN_S = 3;
const CALIBRATION_WINDOW_MS = 600;
let calibrationCapture = null;
const calibrationLabels = {};

function refreshCalibrationUi() {
  leftPanel.setCalibrationState(calibrationLabels, settings.calibration, handRestTracker.learnedSeconds);
}

function handsAuto() {
  return settings.calibration.handsMode === 'auto';
}

// Le repos appris évolue en continu : sauvegarde périodique, silencieuse.
function saveHandRestPeriodically(nowMs) {
  if (nowMs - lastHandRestSaveMs < HAND_REST_SAVE_INTERVAL_MS) return;
  lastHandRestSaveMs = nowMs;
  Object.assign(settings.calibration.handsAuto, handRestTracker.reference);
  Object.assign(settings.calibration.handsAutoSeconds, handRestTracker.learnedSeconds);
  store.saveSoon();
  refreshCalibrationUi();
}

function startCalibration(group) {
  if (calibrationCapture) return;
  if (!trackerManager.active) {
    alert('Activez la détection (D) avant de calibrer.');
    return;
  }
  const name = group === 'body' ? 'corps' : 'mains';
  let remaining = CALIBRATION_COUNTDOWN_S;
  calibrationLabels[group] = `Prenez la pose… ${remaining}`;
  refreshCalibrationUi();
  const timer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      calibrationLabels[group] = `Prenez la pose… ${remaining}`;
      refreshCalibrationUi();
      return;
    }
    clearInterval(timer);
    calibrationLabels[group] = 'Capture…';
    refreshCalibrationUi();
    calibrationCapture = createCalibrationCapture(group, (reference, count) => {
      calibrationCapture = null;
      delete calibrationLabels[group];
      if (count === 0) {
        alert(`Calibration ${name} impossible : rien n'a été détecté pendant la capture.`);
      } else {
        Object.assign(settings.calibration[group], reference);
        settings.calibration[group === 'body' ? 'bodyCalibrated' : 'handsCalibrated'] = true;
        // Capture main ouverte : passe en mode manuel (sinon elle serait
        // ignorée au profit du repos appris).
        if (group === 'hands') settings.calibration.handsMode = 'manual';
        store.commit();
        refreshUi();
      }
      refreshCalibrationUi();
    });
  }, 1000);
}

// Accumule les valeurs brutes des clés calibrées par le groupe. Angles :
// moyenne circulaire (pas de saut à ±π) ; positions : moyenne simple. Pour
// les mains, seuls les côtés détectés pendant la capture sont mis à jour.
function createCalibrationCapture(group, done) {
  const startMs = performance.now();
  const sums = {};
  let count = 0;
  return {
    collect({ raw, has }) {
      const usable = group === 'body' ? has.body : has.left || has.right;
      if (usable) {
        count++;
        for (const key of CALIBRATED_KEYS[group]) {
          const value = raw[key];
          if (value === undefined) continue;
          sums[key] ??= { sin: 0, cos: 0, sum: 0, n: 0 };
          sums[key].sin += Math.sin(value);
          sums[key].cos += Math.cos(value);
          sums[key].sum += value;
          sums[key].n++;
        }
      }
      if (performance.now() - startMs < CALIBRATION_WINDOW_MS) return;
      const reference = {};
      for (const [key, { sin, cos, sum, n }] of Object.entries(sums)) {
        const linear = key === 'pelvisX' || key === 'shouldersY';
        reference[key] = linear ? sum / n : Math.atan2(sin, cos);
      }
      done(reference, count);
    },
  };
}

function resetCalibration() {
  Object.assign(settings.calibration.body, store.defaults.calibration.body);
  Object.assign(settings.calibration.hands, store.defaults.calibration.hands);
  settings.calibration.bodyCalibrated = false;
  settings.calibration.handsCalibrated = false;
  settings.calibration.handsMode = 'auto';
  handRestTracker.reset();
  Object.assign(settings.calibration.handsAuto, handRestTracker.reference);
  Object.assign(settings.calibration.handsAutoSeconds, handRestTracker.learnedSeconds);
  store.commit();
  refreshUi();
  refreshCalibrationUi();
}

// Offsets par articulation (menu du bas), ajoutés en dernier à la pose.
function applyJointOffsets(pose) {
  for (const [name, { offset }] of Object.entries(settings.joints)) {
    const value = pose[name];
    if (!value) continue;
    for (const axis of AXES) {
      if (value[axis] !== undefined) value[axis] += offset[axis];
    }
  }
  return pose;
}

// --- Boucle par frame ------------------------------------------------------------
// Voir CLAUDE.md, « Architecture cible ».

let lastTimestampMs = performance.now();
let fpsAccumulator = { frames: 0, elapsedMs: 0 };

function frame() {
  const timestampMs = performance.now();
  const dtMs = timestampMs - lastTimestampMs;
  lastTimestampMs = timestampMs;

  if (trackingReady && trackerManager.active) {
    trackerManager.tick(timestampMs);
    const rawDetection = trackerManager.getLatest(timestampMs);
    const detection = detectionSmoother.update(rawDetection, settings.smoothing);

    // Valeurs relatives → KeyPose (cible) → retargeting, butées, offsets.
    const extraction = featureExtractor.extract(detection, {
      mirror: settings.general.mirrorAvatar,
      aspect: videoAspect(),
      framing: settings.general.framing,
      calibration: {
        body: settings.calibration.body,
        hands: handsAuto() ? handRestTracker.reference : settings.calibration.hands,
      },
    });
    calibrationCapture?.collect(extraction);
    handRestTracker.update(extraction.raw, extraction.has, dtMs);
    saveHandRestPeriodically(timestampMs);
    rightPanel.setFeatures(extraction.values);

    const keyPose = keyPoseBuilder.build(extraction, {
      restPose: settings.restPose,
      motion: settings.motion,
      bodyCalibrated: settings.calibration.bodyCalibrated,
      handsRelativeToRest: handsAuto(),
    });
    const target = applyJointOffsets(jointConstraints.apply(applyRetargeting(keyPose.pose, retargetConfig)));
    target.hipsOffset = keyPose.hipsOffset;
    keyPoseSkeleton.update(target, target.hipsOffset, settings.layers.keyPose);

    // Le modèle suit la cible.
    const output = skeletonSmoother.update(target, dtMs);
    vrmController.applyPose(output, output.hipsOffset);

    overlayRenderer.draw({
      raw: rawDetection,
      smoothed: detection,
      layers: settings.layers,
      mirror: settings.general.mirrorCamera,
      videoSize: trackerManager.videoSize,
    });
  }

  vrmController.update(Math.min(dtMs / 1000, MAX_DT_SECONDS));
  sceneManager.render();

  fpsAccumulator.frames++;
  fpsAccumulator.elapsedMs += dtMs;
  if (fpsAccumulator.elapsedMs >= 500) {
    status.fps = (fpsAccumulator.frames * 1000) / fpsAccumulator.elapsedMs;
    fpsAccumulator = { frames: 0, elapsedMs: 0 };
    renderStatus();
    leftPanel.setStats(trackerManager.getStats(timestampMs));
  }

  requestAnimationFrame(frame);
}

applySettings();
refreshCalibrationUi();
renderStatus();
loadModel(BUNDLED_MODELS[0].url, BUNDLED_MODELS[0].label);
startTracking();
requestAnimationFrame(frame);
