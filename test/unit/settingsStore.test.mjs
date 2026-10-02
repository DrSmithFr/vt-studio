import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, createDefaultSettings } from '../../src/ui/SettingsStore.js';
import { JointConstraints } from '../../src/core/JointConstraints.js';
import { ROTATION_JOINTS } from '../../src/core/JointSchema.js';

// localStorage minimal pour Node.
beforeEach(() => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
});

function makeStore() {
  const defaults = createDefaultSettings();
  defaults.constraints = structuredClone(new JointConstraints().limits);
  return new SettingsStore(defaults);
}

test('valeurs par défaut : détection désactivée, miroir, ressorts par groupe', () => {
  const { data } = makeStore();
  assert.equal(data.detection.enabled, false);
  assert.equal(data.general.mirrorAvatar, true);
  assert.deepEqual(Object.keys(data.joints).sort(), [...ROTATION_JOINTS].sort());
  assert.equal(data.joints.leftUpperArm.stiffness, 400);
  assert.equal(data.joints.leftIndexProximal.stiffness, 600);
  assert.equal(data.joints.hips.stiffness, 150);
  assert.equal(data.calibration.handsMode, 'auto');
});

test('import : références conservées, clés inconnues et types incorrects ignorés', () => {
  const store = makeStore();
  const sideRef = store.data.retarget.sideInversion;
  const limitRef = store.data.constraints.neck.x;
  store.import(
    JSON.stringify({
      version: 2,
      settings: {
        retarget: { sideInversion: { arms: true } },
        constraints: { neck: { x: [-1, 1] } },
        unknownKey: 3,
        layers: { camera: 'pas un booléen' },
      },
    }),
  );
  assert.equal(store.data.retarget.sideInversion, sideRef);
  assert.equal(sideRef.arms, true);
  assert.equal(store.data.constraints.neck.x, limitRef);
  assert.deepEqual(limitRef, [-1, 1]);
  assert.equal(store.data.layers.camera, true);
  assert.ok(!('unknownKey' in store.data));
});

test('réinitialisation : retour aux valeurs par défaut, mêmes objets', () => {
  const store = makeStore();
  const ref = store.data.retarget.sideInversion;
  ref.arms = true;
  store.data.constraints.neck.x[0] = -3;
  store.reset();
  assert.equal(ref.arms, false);
  assert.deepEqual(store.data.constraints.neck.x, [-0.6, 0.6]);
});

test('migration v1 → v2 : anciennes valeurs du ressort abandonnées, offsets gardés', () => {
  const store = makeStore();
  store.import({
    version: 1,
    settings: { joints: { leftUpperArm: { offset: { x: 0.5, y: 0, z: 0 }, stiffness: 120, damping: 18 } } },
  });
  assert.equal(store.data.joints.leftUpperArm.offset.x, 0.5);
  assert.equal(store.data.joints.leftUpperArm.stiffness, 400);
});

test('persistance : sauvegarde différée puis rechargement', async () => {
  const store = makeStore();
  store.data.general.framing = 'seated';
  store.commit();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const reloaded = makeStore();
  reloaded.load();
  assert.equal(reloaded.data.general.framing, 'seated');
});

test('abonnés notifiés à chaque commit', () => {
  const store = makeStore();
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  store.commit();
  unsubscribe();
  store.commit();
  assert.equal(calls, 1);
});

test('export : version et réglages', () => {
  const json = makeStore().toJSON();
  assert.equal(json.version, 2);
  assert.ok(json.settings.detection);
});
