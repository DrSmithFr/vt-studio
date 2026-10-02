import './style.css';
import { ALL_CHANNELS, AXES } from './core/JointSchema.js';
import { GlobalSkeletonBuilder } from './core/GlobalSkeleton.js';
import { SkeletonSmoother } from './core/Smoother.js';
import { RetargetConfig, applyRetargeting } from './core/RetargetConfig.js';
import { JointConstraints } from './core/JointConstraints.js';
import { TrackerManager } from './tracking/TrackerManager.js';
import { VrmController } from './vrm/VrmController.js';
import { SceneManager } from './render/SceneManager.js';
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
const statusBar = document.getElementById('status-bar');
const modelFileInput = document.getElementById('model-file');
const settingsFileInput = document.getElementById('settings-file');

const sceneManager = new SceneManager(sceneCanvas);
const vrmController = new VrmController(sceneManager.scene);
const trackerManager = new TrackerManager(video);
const globalSkeletonBuilder = new GlobalSkeletonBuilder();
const skeletonSmoother = new SkeletonSmoother(ALL_CHANNELS);
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
  globalSkeletonBuilder.torsoRadius = settings.collision.torsoRadius;
}

store.subscribe(applySettings);

// --- Interface ------------------------------------------------------------------

const leftPanel = new LeftPanel(document.getElementById('left-panel'), store);
const rightPanel = new RightPanel(document.getElementById('right-panel'), store);
const jointDock = new JointDock(document.getElementById('joint-dock'), store);

// Resynchronise les contrôles après un changement venu d'ailleurs (menu,
// import, réinitialisation).
function refreshUi() {
  leftPanel.refresh(settings);
  rightPanel.refresh();
  jointDock.refresh();
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
      toggleEntry('Caméra en miroir', settings.general, 'mirrorCamera'),
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
  }
});

// --- Barre de statut ------------------------------------------------------------

const status = { model: 'aucun modèle', tracking: 'suivi : initialisation…', fps: 0 };

function renderStatus() {
  statusBar.textContent = `${status.model}  ·  ${status.tracking}  ·  ${status.fps.toFixed(0)} fps`;
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
    // pour le nouveau.
    applySettings();
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

async function startTracking() {
  try {
    status.tracking = 'suivi : chargement des modèles MediaPipe…';
    renderStatus();
    await trackerManager.init();
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

  if (trackingReady) {
    const detection = trackerManager.detect(timestampMs);
    // Sans détection cette frame, une pose vide laisse le lisseur conserver
    // les dernières valeurs lissées.
    const rawPose = detection ? globalSkeletonBuilder.build(detection) : {};
    const smoothedPose = skeletonSmoother.update(rawPose, dtMs);
    const retargeted = applyRetargeting(smoothedPose, retargetConfig);
    const outputPose = applyJointOffsets(jointConstraints.apply(retargeted));
    vrmController.applyPose(outputPose);
  }

  vrmController.update(Math.min(dtMs / 1000, MAX_DT_SECONDS));
  sceneManager.render();

  fpsAccumulator.frames++;
  fpsAccumulator.elapsedMs += dtMs;
  if (fpsAccumulator.elapsedMs >= 500) {
    status.fps = (fpsAccumulator.frames * 1000) / fpsAccumulator.elapsedMs;
    fpsAccumulator = { frames: 0, elapsedMs: 0 };
    renderStatus();
  }

  requestAnimationFrame(frame);
}

applySettings();
renderStatus();
loadModel(BUNDLED_MODELS[0].url, BUNDLED_MODELS[0].label);
startTracking();
requestAnimationFrame(frame);
