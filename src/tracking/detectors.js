import { FaceLandmarker, HandLandmarker, HolisticLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

// Définition des détecteurs MediaPipe, partagée par le Web Worker (et, en
// phase 7, documentant le format attendu du serveur distant).
//
// Chaque détecteur renvoie des « parties » au format commun :
//   pose  : { screen: Landmark[33], world: Landmark[33] } | null
//   face  : { screen: Landmark[478], blendshapes: { [nom]: score } } | null
//   hands : { left: { screen, world } | null, right: { screen, world } | null }
// Les côtés gauche/droite sont toujours anatomiques (main gauche de la
// personne filmée), quel que soit le détecteur.
//   - `screen` : coordonnées normalisées à l'image (0-1, y vers le bas) ;
//   - `world`  : coordonnées métriques (m), origine au centre des hanches
//                (pose) ou de la main, y vers le bas.

const MODELS_BASE = 'https://storage.googleapis.com/mediapipe-models';

const MODEL_URLS = {
  holistic: `${MODELS_BASE}/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task`,
  face: `${MODELS_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  hand: `${MODELS_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  pose: {
    lite: `${MODELS_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    full: `${MODELS_BASE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    heavy: `${MODELS_BASE}/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`,
  },
};

// Parties produites par chaque type de détecteur.
export const DETECTOR_PARTS = {
  holistic: ['pose', 'face', 'hands'],
  pose: ['pose'],
  face: ['face'],
  hand: ['hands'],
};

// Crée la tâche MediaPipe d'un détecteur. `options.poseModel` : 'lite' |
// 'full' | 'heavy'.
export async function createDetectorTask(kind, fileset, delegate, options = {}) {
  const baseOptions = (modelAssetPath) => ({ modelAssetPath, delegate });
  switch (kind) {
    case 'holistic':
      return HolisticLandmarker.createFromOptions(fileset, {
        baseOptions: baseOptions(MODEL_URLS.holistic),
        runningMode: 'VIDEO',
        outputFaceBlendshapes: true,
      });
    case 'pose':
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: baseOptions(MODEL_URLS.pose[options.poseModel] ?? MODEL_URLS.pose.full),
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    case 'face':
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: baseOptions(MODEL_URLS.face),
        runningMode: 'VIDEO',
        outputFaceBlendshapes: true,
        numFaces: 1,
      });
    case 'hand':
      return HandLandmarker.createFromOptions(fileset, {
        baseOptions: baseOptions(MODEL_URLS.hand),
        runningMode: 'VIDEO',
        numHands: 2,
      });
    default:
      throw new Error(`Détecteur inconnu : ${kind}`);
  }
}

// Copie compacte d'une liste de landmarks (objets simples, transférables
// par postMessage sans les propriétés internes de MediaPipe).
function copyLandmarks(list) {
  if (!list?.length) return null;
  return list.map(({ x, y, z, visibility }) =>
    visibility === undefined ? { x, y, z } : { x, y, z, visibility },
  );
}

function blendshapeMap(classifications) {
  const categories = classifications?.categories;
  if (!categories?.length) return null;
  return Object.fromEntries(categories.map((c) => [c.categoryName, c.score]));
}

function poseFrom(screen, world) {
  const s = copyLandmarks(screen);
  const w = copyLandmarks(world);
  return s && w ? { screen: s, world: w } : null;
}

function handFrom(screen, world) {
  const s = copyLandmarks(screen);
  const w = copyLandmarks(world);
  return s && w ? { screen: s, world: w } : null;
}

// Convertit le résultat brut d'une tâche en parties au format commun.
export function normalizeResult(kind, result) {
  switch (kind) {
    case 'holistic':
      // HolisticLandmarker associe les mains aux poignets du squelette de
      // pose : leftHand = main gauche anatomique.
      return {
        pose: poseFrom(result.poseLandmarks?.[0], result.poseWorldLandmarks?.[0]),
        face: result.faceLandmarks?.[0]
          ? { screen: copyLandmarks(result.faceLandmarks[0]), blendshapes: blendshapeMap(result.faceBlendshapes?.[0]) }
          : null,
        hands: {
          left: handFrom(result.leftHandLandmarks?.[0], result.leftHandWorldLandmarks?.[0]),
          right: handFrom(result.rightHandLandmarks?.[0], result.rightHandWorldLandmarks?.[0]),
        },
      };
    case 'pose':
      return { pose: poseFrom(result.landmarks?.[0], result.worldLandmarks?.[0]) };
    case 'face':
      return {
        face: result.faceLandmarks?.[0]
          ? { screen: copyLandmarks(result.faceLandmarks[0]), blendshapes: blendshapeMap(result.faceBlendshapes?.[0]) }
          : null,
      };
    case 'hand': {
      // HandLandmarker étiquette la latéralité en supposant une image miroir
      // (caméra frontale retournée). Le flux webcam n'étant pas retourné,
      // l'étiquette « Left » désigne la main droite anatomique.
      const hands = { left: null, right: null };
      (result.handedness ?? []).forEach((handedness, i) => {
        const label = handedness[0]?.categoryName;
        const hand = handFrom(result.landmarks[i], result.worldLandmarks[i]);
        if (label === 'Left') hands.right = hand;
        if (label === 'Right') hands.left = hand;
      });
      return { hands };
    }
    default:
      return {};
  }
}
