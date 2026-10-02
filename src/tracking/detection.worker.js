// Web Worker exécutant un détecteur MediaPipe (un worker par détecteur).
//
// Messages reçus :
//   { type: 'init', kind, options }             — crée la tâche
//   { type: 'frame', frame: ImageBitmap, timestamp } — détecte (frame transférée)
// Messages envoyés :
//   { type: 'ready', delegate }
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
      const created = await createTask(kind, data.options);
      task = created.task;
      self.postMessage({ type: 'ready', delegate: created.delegate });
    } catch (error) {
      self.postMessage({ type: 'error', message: error?.message ?? String(error) });
    }
    return;
  }

  if (data.type === 'frame') {
    const { frame, timestamp } = data;
    try {
      const start = performance.now();
      const result = task.detectForVideo(frame, timestamp);
      const inferenceMs = performance.now() - start;
      self.postMessage({ type: 'result', timestamp, parts: normalizeResult(kind, result), inferenceMs });
    } catch (error) {
      self.postMessage({ type: 'error', message: error?.message ?? String(error) });
    } finally {
      frame.close();
    }
  }
};
