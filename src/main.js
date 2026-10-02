import './style.css';
import { ALL_CHANNELS } from './core/JointSchema.js';
import { GlobalSkeletonBuilder } from './core/GlobalSkeleton.js';
import { SkeletonSmoother } from './core/Smoother.js';
import { RetargetConfig, applyRetargeting } from './core/RetargetConfig.js';
import { JointConstraints } from './core/JointConstraints.js';
import { TrackerManager } from './tracking/TrackerManager.js';
import { VrmController } from './vrm/VrmController.js';
import { SceneManager } from './render/SceneManager.js';

// Modèles fournis dans public/models, proposés dans la liste déroulante.
// Le premier est chargé au démarrage.
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
const modelSelect = document.getElementById('model-select');
const modelFileInput = document.getElementById('model-file');

const sceneManager = new SceneManager(sceneCanvas);
const vrmController = new VrmController(sceneManager.scene);
const trackerManager = new TrackerManager(video);
const globalSkeletonBuilder = new GlobalSkeletonBuilder();
const skeletonSmoother = new SkeletonSmoother(ALL_CHANNELS);
const retargetConfig = new RetargetConfig();
const jointConstraints = new JointConstraints();

// État affiché dans la barre de statut, mis à jour par morceaux.
const status = { model: 'aucun modèle', tracking: 'suivi : initialisation…', fps: 0 };

function renderStatus() {
  statusBar.textContent = `${status.model} · ${status.tracking} · ${status.fps.toFixed(0)} fps`;
}

// --- Chargement du modèle ---------------------------------------------------

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
  } catch (error) {
    console.error(error);
    status.model = `échec du chargement de ${label}`;
  }
  renderStatus();
}

for (const { label, url } of BUNDLED_MODELS) {
  modelSelect.add(new Option(label, url));
}
modelSelect.addEventListener('change', () => {
  loadModel(modelSelect.value, modelSelect.selectedOptions[0].text);
});

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

// --- Suivi ------------------------------------------------------------------

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
    status.tracking = `suivi indisponible (${error.name ?? 'erreur'})`;
  }
  renderStatus();
}

// --- Boucle par frame -------------------------------------------------------
// Voir CLAUDE.md, « Boucle par frame ».

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
    const outputPose = jointConstraints.apply(retargeted);
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

renderStatus();
loadModel(BUNDLED_MODELS[0].url, BUNDLED_MODELS[0].label);
startTracking();
requestAnimationFrame(frame);
