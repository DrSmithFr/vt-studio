import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, DETECTOR_PARTS } from '../../src/tracking/detectors.js';
import { TrackerManager } from '../../src/tracking/TrackerManager.js';
import { DetectionSmoother } from '../../src/core/DetectionSmoother.js';

const points = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0.5, z: 0, ...extra }));
const category = (categoryName, score = 0.9) => ({ categoryName, score });

// --- Normalisation des résultats MediaPipe --------------------------------------

test('normalisation pose : écran + monde, visibilité conservée', () => {
  const parts = normalizeResult('pose', { landmarks: [points(33, { visibility: 0.7 })], worldLandmarks: [points(33)] });
  assert.equal(parts.pose.screen.length, 33);
  assert.equal(parts.pose.screen[0].visibility, 0.7);
  assert.equal(normalizeResult('pose', { landmarks: [], worldLandmarks: [] }).pose, null);
});

test('normalisation visage : blendshapes en dictionnaire nom → score', () => {
  const parts = normalizeResult('face', {
    faceLandmarks: [points(478)],
    faceBlendshapes: [{ categories: [category('jawOpen', 0.4), category('eyeBlinkLeft', 0.1)] }],
  });
  assert.deepEqual(parts.face.blendshapes, { jawOpen: 0.4, eyeBlinkLeft: 0.1 });
});

test('normalisation mains : étiquette « Left » de HandLandmarker = main droite anatomique', () => {
  const parts = normalizeResult('hand', {
    handedness: [[category('Left')]],
    landmarks: [points(21)],
    worldLandmarks: [points(21)],
  });
  assert.ok(parts.hands.right && !parts.hands.left);
});

test('normalisation Holistic : toutes les parties', () => {
  const parts = normalizeResult('holistic', {
    poseLandmarks: [points(33)],
    poseWorldLandmarks: [points(33)],
    faceLandmarks: [points(478)],
    faceBlendshapes: [{ categories: [category('jawOpen')] }],
    leftHandLandmarks: [points(21)],
    leftHandWorldLandmarks: [points(21)],
    rightHandLandmarks: [],
    rightHandWorldLandmarks: [],
  });
  assert.ok(parts.pose && parts.face && parts.hands.left);
  assert.equal(parts.hands.right, null);
  assert.deepEqual(Object.keys(parts).sort(), [...DETECTOR_PARTS.holistic].sort());
});

// --- Ordonnanceur ---------------------------------------------------------------------

function trackerWith({ pose, hands, poseTime = 0, handsTime = 0 }) {
  const tracker = new TrackerManager({});
  tracker.latest = {
    pose: pose ? { data: pose, timestamp: poseTime } : null,
    face: null,
    hands: hands ? { data: hands, timestamp: handsTime } : null,
  };
  return tracker;
}

const poseWithWrists = (left, right) => {
  const screen = points(33);
  screen[15] = { x: left, y: 0.6 }; // poignet gauche anatomique
  screen[16] = { x: right, y: 0.6 };
  return { screen, world: points(33) };
};
const hand = (x, name) => ({ name, screen: [{ x, y: 0.62 }], world: [] });

test('mains rattachées au poignet le plus proche, quelle que soit l\'étiquette', () => {
  const pose = poseWithWrists(0.7, 0.3);
  const swapped = trackerWith({ pose, hands: { left: hand(0.31, 'D'), right: hand(0.69, 'G') } }).getLatest(10).hands;
  assert.equal(swapped.left.name, 'G');
  assert.equal(swapped.right.name, 'D');
  const single = trackerWith({ pose, hands: { left: null, right: hand(0.68, 'G') } }).getLatest(10).hands;
  assert.equal(single.left?.name, 'G');
  assert.equal(single.right, null);
});

test('main seule loin des poignets, ou sans squelette : étiquette conservée', () => {
  const far = trackerWith({ pose: poseWithWrists(0.9, 0.1), hands: { left: hand(0.5, 'X'), right: null } }).getLatest(10);
  assert.equal(far.hands.left.name, 'X');
  const noPose = trackerWith({ pose: null, hands: { left: null, right: hand(0.3, 'Y') } }).getLatest(10);
  assert.equal(noPose.hands.right.name, 'Y');
});

test('une partie trop ancienne est considérée perdue', () => {
  const tracker = trackerWith({ pose: poseWithWrists(0.7, 0.3), poseTime: 0 });
  assert.ok(tracker.getLatest(100).pose);
  assert.equal(tracker.getLatest(600).pose, null);
  assert.equal(tracker.getLatest(600).timestamps.pose, null);
});

test('détection désactivée : aucun détecteur, statistiques vides', () => {
  const tracker = new TrackerManager({});
  tracker.configure({ enabled: false, mode: 'composite', backends: {}, fps: {} });
  assert.equal(tracker.active, false);
  assert.deepEqual(tracker.getStats(0), []);
});

test('backend distant sans adresse : erreur explicite dans les statistiques', async () => {
  const tracker = new TrackerManager({ srcObject: null });
  tracker.configure({ enabled: true, mode: 'holistic', holisticBackend: 'remote', fps: { holistic: 30 }, remoteUrl: '' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [stats] = tracker.getStats(0);
  assert.equal(stats.status, 'error');
  assert.match(stats.message, /adresse/);
  tracker.configure({ enabled: false });
});

// --- Lissage des landmarks -------------------------------------------------------------

const detectionAt = (x, timestamp) => ({
  pose: { screen: [{ x, y: 0, z: 0, visibility: 0.8 }], world: [{ x, y: 0, z: 0 }] },
  face: null,
  hands: { left: null, right: null },
  timestamps: { pose: timestamp, face: null, hands: null },
});

test('lissage : premier échantillon tel quel, puis moyenne exponentielle', () => {
  const smoother = new DetectionSmoother();
  const delays = { pose: 100, face: 50, hand: 40 };
  assert.equal(smoother.update(detectionAt(0, 0), delays).pose.screen[0].x, 0);
  const x = smoother.update(detectionAt(1, 100), delays).pose.screen[0].x;
  assert.ok(Math.abs(x - (1 - Math.exp(-1))) < 1e-9, `alpha = 1 - e^(-dt/τ), obtenu ${x}`);
  assert.equal(smoother.update(detectionAt(1, 100), delays).pose.screen[0].x, x, 'même horodatage : pas de recalcul');
});

test('lissage : délai nul = pas de lissage ; visibilité non lissée', () => {
  const smoother = new DetectionSmoother();
  const delays = { pose: 0, face: 0, hand: 0 };
  smoother.update(detectionAt(0, 0), delays);
  const out = smoother.update(detectionAt(1, 10), delays);
  assert.equal(out.pose.screen[0].x, 1);
  assert.equal(out.pose.screen[0].visibility, 0.8);
});

test('lissage : une partie perdue repart de zéro à sa réapparition', () => {
  const smoother = new DetectionSmoother();
  const delays = { pose: 100, face: 50, hand: 40 };
  smoother.update(detectionAt(0, 0), delays);
  assert.equal(smoother.update({ ...detectionAt(0, 0), pose: null, timestamps: { pose: null } }, delays).pose, null);
  assert.equal(smoother.update(detectionAt(1, 500), delays).pose.screen[0].x, 1);
});
