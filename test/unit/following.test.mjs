import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpringFollower } from '../../src/core/SpringFollower.js';
import { HandRestTracker } from '../../src/core/HandRestTracker.js';
import { CALIBRATED_KEYS } from '../../src/core/FeatureSchema.js';

// --- Ressort amorti ------------------------------------------------------------------

const FRAME_MS = 1000 / 60;

// Échelon de 90° autour de Z suivi pendant `frames` images : renvoie la
// trajectoire de l'angle.
function stepResponse(stiffness, damping, frames = 120) {
  const follower = new SpringFollower(['leftLowerArm']);
  const params = { leftLowerArm: { stiffness, damping }, hips: { stiffness, damping } };
  follower.update({ leftLowerArm: { x: 0, y: 0, z: 0 } }, params, FRAME_MS);
  const trajectory = [];
  for (let i = 0; i < frames; i++) {
    trajectory.push(follower.update({ leftLowerArm: { x: 0, y: 0, z: Math.PI / 2 } }, params, FRAME_MS).leftLowerArm.z);
  }
  return trajectory;
}

test('ressort : converge vers la cible sans dépassement à l\'amortissement critique', () => {
  const k = 400;
  const trajectory = stepResponse(k, 2 * Math.sqrt(k));
  assert.ok(Math.abs(trajectory.at(-1) - Math.PI / 2) < 1e-3, 'atteint la cible');
  assert.ok(Math.max(...trajectory) <= Math.PI / 2 + 1e-3, 'pas de dépassement');
});

test('ressort : réglages par défaut du corps (400 / 38) → 90 % en moins de 250 ms', () => {
  const trajectory = stepResponse(400, 38);
  const frame = trajectory.findIndex((z) => z >= 0.9 * Math.PI / 2);
  assert.ok(frame >= 0 && (frame + 1) * FRAME_MS < 250, `90 % atteints en ${((frame + 1) * FRAME_MS).toFixed(0)} ms`);
});

test('ressort : faible amortissement = dépassement, mais stable', () => {
  const trajectory = stepResponse(500, 5, 600);
  assert.ok(Math.max(...trajectory) > Math.PI / 2 * 1.3, 'rebond visible');
  assert.ok(Math.abs(trajectory.at(-1) - Math.PI / 2) < 0.05, 'finit par se stabiliser');
});

test('ressort : raideur nulle = cible appliquée directement', () => {
  const trajectory = stepResponse(0, 0, 1);
  assert.ok(Math.abs(trajectory[0] - Math.PI / 2) < 1e-9);
});

test('ressort : un pas de temps énorme (onglet en arrière-plan) ne diverge pas', () => {
  const follower = new SpringFollower(['head']);
  const params = { head: { stiffness: 1000, damping: 10 }, hips: { stiffness: 150, damping: 24 } };
  follower.update({ head: { x: 0, y: 0, z: 0 } }, params, FRAME_MS);
  const out = follower.update({ head: { x: 0, y: 1, z: 0 } }, params, 5000).head;
  assert.ok(Object.values(out).every(Number.isFinite) && Math.abs(out.y) < Math.PI);
});

test('ressort : déplacement du bassin suivi par ressort vectoriel, visage passé tel quel', () => {
  const follower = new SpringFollower([]);
  const params = { hips: { stiffness: 150, damping: 24 } };
  follower.update({ hipsOffset: { x: 0, y: 0, z: 0 } }, params, FRAME_MS);
  let out;
  for (let i = 0; i < 300; i++) out = follower.update({ hipsOffset: { x: 0.5, y: 0, z: 0 }, mouthOpen: { x: 0.3 } }, params, FRAME_MS);
  assert.ok(Math.abs(out.hipsOffset.x - 0.5) < 1e-3);
  assert.deepEqual(out.mouthOpen, { x: 0.3 });
});

// --- Repos naturel des doigts ------------------------------------------------------------

const leftKeys = CALIBRATED_KEYS.hands.filter((k) => k.startsWith('left_'));
const initial = Object.fromEntries(CALIBRATED_KEYS.hands.map((k) => [k, 0]));
const handAt = (value, jitter = 0.01) =>
  Object.fromEntries(leftKeys.map((k) => [k, value + (Math.random() - 0.5) * jitter]));
const meanReference = (tracker) => leftKeys.reduce((sum, k) => sum + tracker.reference[k], 0) / leftKeys.length;

function feed(tracker, seconds, generate) {
  for (let i = 0; i < seconds * 60; i++) tracker.update(generate(i), { left: true, right: false }, FRAME_MS);
}

test('repos des mains : apprend la courbure naturelle', () => {
  const tracker = new HandRestTracker(initial);
  feed(tracker, 20, () => handAt(0.5));
  assert.ok(Math.abs(meanReference(tracker) - 0.5) < 0.02);
  assert.ok(tracker.learnedSeconds.left > 15 && tracker.learnedSeconds.right === 0);
});

test('repos des mains : un poing tenu immobile ne fait pas dériver le repos', () => {
  const tracker = new HandRestTracker(initial);
  feed(tracker, 20, () => handAt(0.5));
  feed(tracker, 20, () => handAt(1.6));
  assert.ok(Math.abs(meanReference(tracker) - 0.5) < 0.02);
});

test('repos des mains : des doigts qui bougent vite sont ignorés', () => {
  const tracker = new HandRestTracker(initial);
  feed(tracker, 20, () => handAt(0.5));
  feed(tracker, 10, (i) => handAt(0.5 + 0.5 * Math.sin(i / 3)));
  assert.ok(Math.abs(meanReference(tracker) - 0.5) < 0.02);
});

test('repos des mains : suit une évolution lente du repos naturel', () => {
  const tracker = new HandRestTracker(initial);
  feed(tracker, 30, () => handAt(0.5));
  feed(tracker, 90, () => handAt(0.7));
  assert.ok(meanReference(tracker) > 0.65, `obtenu ${meanReference(tracker).toFixed(2)}`);
});

test('repos des mains : reprise d\'un apprentissage sauvegardé, puis réinitialisation', () => {
  const tracker = new HandRestTracker(initial);
  const saved = Object.fromEntries(leftKeys.map((k) => [k, 0.4]));
  tracker.seed(saved, { left: 45, right: 0 });
  assert.ok(Math.abs(meanReference(tracker) - 0.4) < 1e-9);
  assert.equal(tracker.learnedSeconds.left, 45);
  tracker.reset();
  assert.equal(meanReference(tracker), 0);
});
