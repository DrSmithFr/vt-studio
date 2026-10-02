// Web Worker exécutant un détecteur MediaPipe (un worker par détecteur).
//
// Messages reçus :
//   { type: 'init', kind, options }             — crée la tâche
//   { type: 'frame', frame: ImageBitmap, timestamp } — détecte (frame transférée)
// Messages envoyés :
//   { type: 'ready', delegate }
//   { type: 'delegate', delegate }               — repli CPU après coup
//   { type: 'result', timestamp, parts, inferenceMs }
//   { type: 'error', message }
//
// Le worker est un module ES : MediaPipe y charge son runtime WASM par
// import() dynamique, ce qui exige la variante « module » des fichiers WASM.

import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import binaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import { createDetectorTask, normalizeResult } from './detectors.js';

const fileset = {
  wasmLoaderPath: new URL(loaderUrl, self.location.href).href,
  wasmBinaryPath: new URL(binaryUrl, self.location.href).href,
};

let task = null;
let kind = null;
let options = null;
let delegate = null;
// Vrai tant qu'aucune frame n'a été traitée avec succès sur GPU : certaines
// erreurs de graphe GPU n'apparaissent qu'à la première inférence (ex.
// Holistic : FaceBlendshapesGraph « No support of const » en WebGL), pas à
// la création de la tâche.
let gpuUnproven = false;

// MediaPipe ne lève pas d'exception quand son graphe échoue pendant une
// inférence : il journalise l'erreur (console.error, via emscripten) et
// renvoie un résultat vide. On repère donc ces messages pour savoir si la
// dernière inférence a réellement abouti.
let graphError = null;
const consoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (/was not ok|Graph has errors|before StartRun/.test(text)) graphError ??= text;
  consoleError(...args);
};

// GPU d'abord (WebGL2 via OffscreenCanvas), CPU si indisponible.
async function createTask(detectorKind, options) {
  try {
    return { task: await createDetectorTask(detectorKind, fileset, 'GPU', options), delegate: 'GPU' };
  } catch (error) {
    console.warn(`[${detectorKind}] délégation GPU impossible, repli CPU.`, error);
    return { task: await createDetectorTask(detectorKind, fileset, 'CPU', options), delegate: 'CPU' };
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      kind = data.kind;
      options = data.options;
      const created = await createTask(kind, options);
      task = created.task;
      delegate = created.delegate;
      gpuUnproven = delegate === 'GPU';
      self.postMessage({ type: 'ready', delegate });
    } catch (error) {
      self.postMessage({ type: 'error', message: error?.message ?? String(error) });
    }
    return;
  }

  if (data.type === 'frame') {
    const { frame, timestamp } = data;
    try {
      graphError = null;
      const start = performance.now();
      const result = task.detectForVideo(frame, timestamp);
      const inferenceMs = performance.now() - start;
      if (graphError) throw new Error(graphError.split('\n')[0]);
      gpuUnproven = false;
      self.postMessage({ type: 'result', timestamp, parts: normalizeResult(kind, result), inferenceMs });
    } catch (error) {
      if (gpuUnproven) {
        await fallBackToCpu(error);
      } else {
        self.postMessage({ type: 'error', message: error?.message ?? String(error) });
      }
    } finally {
      frame.close();
    }
  }
};

// Recrée la tâche sur CPU après l'échec de la première inférence GPU. La
// frame en cours est perdue ; la suivante passe par le CPU.
async function fallBackToCpu(error) {
  console.warn(`[${kind}] échec de l'inférence GPU, repli CPU.`, error);
  gpuUnproven = false;
  try {
    // Le graphe GPU est dans un état incohérent : sa fermeture peut échouer.
    try {
      task.close();
    } catch {}
    task = await createDetectorTask(kind, fileset, 'CPU', options);
    delegate = 'CPU';
    self.postMessage({ type: 'delegate', delegate });
    // Libère le backend : aucune frame n'a produit de résultat.
    self.postMessage({ type: 'error', message: 'GPU non supporté pour ce détecteur, repli CPU' });
  } catch (cpuError) {
    self.postMessage({ type: 'error', message: cpuError?.message ?? String(cpuError) });
  }
}
