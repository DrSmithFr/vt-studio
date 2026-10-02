import { DETECTOR_PARTS } from './detectors.js';
import { RemoteBackend, WorkerBackend } from './backends.js';

// Au-delà, une partie (pose, visage, mains) dont le détecteur ne répond plus
// est considérée comme perdue.
const STALE_AFTER_MS = 500;

// Fenêtre de calcul des statistiques (FPS effectif, temps d'inférence).
const STATS_WINDOW_MS = 1000;

// Webcam + ordonnancement des détecteurs.
//
// Selon les réglages de détection, instancie un détecteur Holistic ou trois
// détecteurs Composite (corps, visage, mains), chacun sur son backend
// (Web Worker ou distant). À chaque tick, envoie une frame de la webcam aux
// détecteurs dont l'intervalle (1 / FPS réglé) est écoulé et qui ne sont pas
// occupés. Les résultats arrivent de façon asynchrone et sont fusionnés dans
// un état « dernière détection » par partie.
export class TrackerManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.detectors = [];
    this.signature = null;
    this.fps = {};
    // Dernier résultat par partie : { data, timestamp, source }.
    this.latest = { pose: null, face: null, hands: null };
  }

  async startWebcam() {
    // navigator.mediaDevices n'existe qu'en contexte sécurisé (HTTPS ou
    // localhost) : page servie en HTTP depuis une adresse réseau.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Webcam indisponible : la page doit être servie en HTTPS ou sur localhost.'), {
        name: 'InsecureContext',
      });
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: false,
    });
    this.video.srcObject = stream;
    await new Promise((resolve) => {
      this.video.onloadedmetadata = () => resolve();
    });
    await this.video.play();
  }

  get active() {
    return this.detectors.length > 0;
  }

  get videoSize() {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  // Applique les réglages de détection. Les détecteurs ne sont recréés que
  // si le mode, un backend ou le modèle de pose change ; un changement de
  // FPS s'applique immédiatement.
  configure(detection) {
    const specs = !detection.enabled
      ? []
      : detection.mode === 'holistic'
        ? [{ id: 'holistic', kind: 'holistic', backend: detection.holisticBackend, fps: detection.fps.holistic }]
        : ['pose', 'face', 'hand'].map((kind) => ({
            id: kind,
            kind,
            backend: detection.backends[kind],
            fps: detection.fps[kind],
          }));
    this.fps = Object.fromEntries(specs.map((s) => [s.id, s.fps]));

    const signature = JSON.stringify([specs.map(({ id, backend }) => [id, backend]), detection.poseModel]);
    if (signature === this.signature) return;
    this.signature = signature;

    for (const detector of this.detectors) detector.backend.dispose();
    this.latest = { pose: null, face: null, hands: null };
    this.detectors = specs.map((spec) => this.#createDetector(spec, detection));
  }

  #createDetector({ id, kind, backend: backendType }, detection) {
    const options = { poseModel: detection.poseModel };
    const backend = backendType === 'remote' ? new RemoteBackend(kind) : new WorkerBackend(kind, options);
    const detector = {
      id,
      kind,
      backend,
      status: 'loading', // 'loading' | 'ready' | 'error'
      message: '',
      lastSentMs: -Infinity,
      lastTimestamp: -Infinity,
      samples: [], // { at, inferenceMs } sur la fenêtre de statistiques
    };

    backend.ready.then(
      () => (detector.status = 'ready'),
      (error) => {
        detector.status = 'error';
        detector.message = error.message;
      },
    );
    backend.onError = (message) => {
      detector.message = message;
    };
    backend.onResult = ({ timestamp, parts, inferenceMs }) => {
      // Un résultat plus ancien que le dernier reçu (ne devrait pas arriver
      // avec un seul envoi en vol) est ignoré.
      if (timestamp <= detector.lastTimestamp) return;
      detector.lastTimestamp = timestamp;
      const now = performance.now();
      detector.samples.push({ at: now, inferenceMs });
      for (const part of DETECTOR_PARTS[kind]) {
        if (part in parts) this.latest[part] = { data: parts[part], timestamp, source: id };
      }
    };
    return detector;
  }

  // À appeler à chaque frame de rendu.
  tick(nowMs) {
    if (this.video.readyState < 2) return;
    for (const detector of this.detectors) {
      if (detector.status !== 'ready' || detector.backend.busy) continue;
      const intervalMs = 1000 / Math.max(1, this.fps[detector.id] ?? 30);
      // Petite tolérance : sans elle, un FPS réglé égal à celui de l'écran
      // sauterait une frame sur deux à cause de la gigue de requestAnimationFrame.
      if (nowMs - detector.lastSentMs < intervalMs - 4) continue;
      detector.lastSentMs = nowMs;
      detector.backend.busy = true;
      createImageBitmap(this.video).then(
        (frame) => detector.backend.send(frame, nowMs),
        () => (detector.backend.busy = false),
      );
    }
  }

  // Dernière détection connue, au format attendu par la suite du pipeline :
  // { pose, face, hands: { left, right }, timestamps: { pose, face, hands } }.
  // Une partie trop ancienne est rendue absente (null).
  getLatest(nowMs) {
    const fresh = (entry) => (entry && nowMs - entry.timestamp < STALE_AFTER_MS ? entry : null);
    const pose = fresh(this.latest.pose);
    const face = fresh(this.latest.face);
    const hands = fresh(this.latest.hands);
    return {
      pose: pose?.data ?? null,
      face: face?.data ?? null,
      hands: hands?.data ?? { left: null, right: null },
      timestamps: { pose: pose?.timestamp ?? null, face: face?.timestamp ?? null, hands: hands?.timestamp ?? null },
    };
  }

  // Statistiques par détecteur pour le panneau : FPS effectif, temps
  // d'inférence moyen, état, délégation.
  getStats(nowMs) {
    return this.detectors.map((detector) => {
      detector.samples = detector.samples.filter((s) => nowMs - s.at < STATS_WINDOW_MS);
      const count = detector.samples.length;
      const inferenceMs = count ? detector.samples.reduce((sum, s) => sum + s.inferenceMs, 0) / count : null;
      return {
        id: detector.id,
        status: detector.status,
        message: detector.message,
        delegate: detector.backend.delegate,
        fps: (count * 1000) / STATS_WINDOW_MS,
        inferenceMs,
      };
    });
  }
}
