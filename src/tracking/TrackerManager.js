import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker,
  HandLandmarker,
} from '@mediapipe/tasks-vision';
import simdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import simdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import noSimdLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url';
import noSimdBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url';

// Le runtime WASM est servi depuis le paquet npm installé plutôt que depuis
// un CDN : sa version correspond forcément à celle du bundle JS (un écart
// de version peut faire échouer l'initialisation).
async function resolveWasmFileset() {
  return (await FilesetResolver.isSimdSupported())
    ? { wasmLoaderPath: simdLoaderUrl, wasmBinaryPath: simdBinaryUrl }
    : { wasmLoaderPath: noSimdLoaderUrl, wasmBinaryPath: noSimdBinaryUrl };
}
const MODELS_BASE = 'https://storage.googleapis.com/mediapipe-models';

// Charge les trois landmarkers MediaPipe Tasks Vision et pilote la boucle de
// détection sur un flux vidéo. Chaque appel à `detect()` retourne l'état
// courant des trois couches de détection, prêt à être passé à
// GlobalSkeletonBuilder.build().
export class TrackerManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.faceLandmarker = null;
    this.poseLandmarker = null;
    this.handLandmarker = null;
  }

  async init() {
    const vision = await resolveWasmFileset();

    this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${MODELS_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputFaceBlendshapes: true,
      numFaces: 1,
    });

    this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${MODELS_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
    });

    this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `${MODELS_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
    });
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
    this.video.play();
  }

  // À appeler une fois par frame de rendu. `timestampMs` doit être croissant
  // (ex. performance.now()) : c'est une exigence de l'API "VIDEO" de
  // MediaPipe Tasks.
  detect(timestampMs) {
    if (this.video.readyState < 2) return null;

    const faceResult = this.faceLandmarker.detectForVideo(this.video, timestampMs);
    const poseResult = this.poseLandmarker.detectForVideo(this.video, timestampMs);
    const handResult = this.handLandmarker.detectForVideo(this.video, timestampMs);

    return {
      face: faceResult.faceBlendshapes?.[0]
        ? { landmarks: faceResult.faceLandmarks[0], blendshapes: faceResult.faceBlendshapes[0].categories }
        : null,
      pose: poseResult.worldLandmarks?.[0] ?? null,
      poseScreen: poseResult.landmarks?.[0] ?? null,
      hands: this.#splitHands(handResult),
    };
  }

  // Renvoie, pour chaque main détectée, à la fois les landmarks 3D métriques
  // (worldLandmarks, utilisés pour calculer une rotation) et les landmarks
  // normalisés (utilisés pour le dessin de la couche de débogage en 2D).
  #splitHands(handResult) {
    const hands = { left: null, right: null };
    if (!handResult.landmarks) return hands;
    handResult.handedness.forEach((handednessList, i) => {
      const label = handednessList[0]?.categoryName; // 'Left' ou 'Right'
      const entry = { world: handResult.worldLandmarks[i], screen: handResult.landmarks[i] };
      if (label === 'Left') hands.left = entry;
      if (label === 'Right') hands.right = entry;
    });
    return hands;
  }
}
