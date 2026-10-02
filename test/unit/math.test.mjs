import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { swingRotation, quaternionToEuler, clamp01, distance3D } from '../../src/utils/MathUtils.js';
import { solveTwoBoneIK } from '../../src/core/TwoBoneIK.js';
import { pushOutOfTorso } from '../../src/core/CollisionAvoidance.js';
import { assertDirection, DEG } from '../helpers.mjs';

const X = new THREE.Vector3(1, 0, 0);

test('swingRotation amène la direction de repos sur la direction observée', () => {
  const { local, world } = swingRotation(X, { x: 0, y: -2, z: 0 });
  assertDirection(assert, X.clone().applyQuaternion(local), [0, -1, 0], 0.01, 'local');
  assert.ok(local.equals(world), 'sans parent, rotation locale = rotation monde');
});

test('swingRotation exprime la rotation dans le repère du parent', () => {
  const parent = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 90 * DEG);
  const { local, world } = swingRotation(X, { x: -1, y: 0, z: 0 }, parent);
  // Monde : la chaîne parent × local amène bien X sur la direction voulue.
  assertDirection(assert, X.clone().applyQuaternion(world), [-1, 0, 0], 0.01, 'monde');
  // Local : parent tourné de 90° (X → Y), il reste 90° à parcourir.
  assert.ok(Math.abs(2 * Math.acos(Math.abs(local.w)) - 90 * DEG) < 1e-6);
});

test('swingRotation sur une direction nulle renvoie l\'identité', () => {
  const { local } = swingRotation(X, { x: 0, y: 0, z: 0 });
  assert.equal(local.w, 1);
});

test('quaternionToEuler : ordre XYZ', () => {
  const e = quaternionToEuler(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 0.3, 'XYZ')));
  assert.ok(Math.abs(e.x - 0.1) < 1e-9 && Math.abs(e.y - 0.2) < 1e-9 && Math.abs(e.z - 0.3) < 1e-9);
});

test('clamp01 et distance3D', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(distance3D({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
});

test('IK à deux os : les segments gardent leurs longueurs et atteignent la cible', () => {
  const root = { x: 0, y: 0, z: 0 };
  const target = { x: 0.4, y: 0, z: 0 };
  const result = solveTwoBoneIK({ root, hint: { x: 0.2, y: 0.1, z: 0 }, target, upperLength: 0.3, lowerLength: 0.25 });
  const upper = new THREE.Vector3(result.upperDirection.x, result.upperDirection.y, result.upperDirection.z);
  const lower = new THREE.Vector3(result.lowerDirection.x, result.lowerDirection.y, result.lowerDirection.z);
  assert.ok(Math.abs(upper.length() - 0.3) < 1e-6, 'longueur du bras');
  const end = upper.clone().add(lower);
  assert.ok(end.distanceTo(new THREE.Vector3(0.4, 0, 0)) < 1e-6, 'la main atteint la cible');
  // Le coude plie du côté indiqué par le landmark intermédiaire (+y).
  assert.ok(result.mid.y > 0, 'plan de flexion donné par le hint');
});

test('IK à deux os : une cible hors de portée est ramenée à la portée maximale', () => {
  const result = solveTwoBoneIK({
    root: { x: 0, y: 0, z: 0 },
    hint: { x: 0.3, y: 0.01, z: 0 },
    target: { x: 2, y: 0, z: 0 },
    upperLength: 0.3,
    lowerLength: 0.25,
  });
  for (const v of [result.upperDirection, result.lowerDirection, result.mid]) {
    assert.ok(Object.values(v).every(Number.isFinite), 'pas de NaN');
  }
});

test('IK à deux os : la flexion ne dépend pas de la profondeur du coude', () => {
  const base = { root: { x: 0, y: 0, z: 0 }, target: { x: 0.4, y: 0, z: 0 }, upperLength: 0.3, lowerLength: 0.25 };
  const a = solveTwoBoneIK({ ...base, hint: { x: 0.2, y: 0.1, z: 0 } });
  const b = solveTwoBoneIK({ ...base, hint: { x: 0.2, y: 0.3, z: 0 } });
  assert.ok(Math.abs(a.mid.y - b.mid.y) < 1e-9, 'même angle de flexion quel que soit le hint');
});

test('collision : une cible dans le torse est repoussée à la surface', () => {
  const shoulderMid = { x: 0, y: 0.5, z: 0 };
  const hipMid = { x: 0, y: 0, z: 0 };
  const pushed = pushOutOfTorso({ x: 0.05, y: 0.25, z: 0 }, shoulderMid, hipMid, 0.14);
  assert.ok(Math.abs(Math.hypot(pushed.x, pushed.z) - 0.14) < 1e-6, 'à la surface de la capsule');
  const outside = pushOutOfTorso({ x: 0.5, y: 0.25, z: 0 }, shoulderMid, hipMid, 0.14);
  assert.deepEqual(outside, { x: 0.5, y: 0.25, z: 0 }, 'une cible hors du torse est inchangée');
});
