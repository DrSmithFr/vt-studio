import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CHANNELS,
  BODY_JOINTS,
  FINGER_JOINTS,
  JOINT_LABELS,
  MIRROR_PAIRS,
  ROTATION_JOINTS,
  mirrorGroupKey,
  mirrorGroupLabel,
} from '../../src/core/JointSchema.js';
import { ALL_FEATURES, CALIBRATED_KEYS } from '../../src/core/FeatureSchema.js';
import { RetargetConfig, applyRetargeting } from '../../src/core/RetargetConfig.js';
import { JointConstraints } from '../../src/core/JointConstraints.js';

test('schéma : 15 os de doigts par main, tous libellés et appariés', () => {
  assert.equal(FINGER_JOINTS.length, 30);
  assert.ok(FINGER_JOINTS.includes('leftThumbMetacarpal') && FINGER_JOINTS.includes('rightLittleDistal'));
  assert.deepEqual(ROTATION_JOINTS, [...BODY_JOINTS, ...FINGER_JOINTS]);
  for (const name of ALL_CHANNELS) assert.ok(JOINT_LABELS[name], `libellé manquant : ${name}`);
  for (const name of FINGER_JOINTS.filter((n) => n.startsWith('left'))) {
    assert.ok(MIRROR_PAIRS.some(([l, r]) => l === name && r === name.replace('left', 'right')), name);
  }
});

test('schéma : une paire miroir partage un groupe de réglage', () => {
  assert.equal(mirrorGroupKey('leftUpperArm'), mirrorGroupKey('rightUpperArm'));
  assert.equal(mirrorGroupKey('spine'), 'spine');
  assert.equal(mirrorGroupLabel(mirrorGroupKey('leftUpperArm')), 'Bras (G/D)');
});

test('valeurs relatives : clés uniques, calibration corps et mains', () => {
  const keys = ALL_FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(CALIBRATED_KEYS.body.includes('pelvisX') && CALIBRATED_KEYS.body.includes('headYaw'));
  assert.equal(CALIBRATED_KEYS.hands.length, 2 * 5 * 3);
});

test('retargeting : inversion de côté des bras', () => {
  const config = new RetargetConfig();
  config.sideInversion.arms = true;
  const out = applyRetargeting({ leftUpperArm: { x: 1, y: 0, z: 0 }, rightUpperArm: { x: 2, y: 0, z: 0 } }, config);
  assert.equal(out.leftUpperArm.x, 2);
  assert.equal(out.rightUpperArm.x, 1);
});

test('retargeting : l\'inversion des mains inclut les doigts', () => {
  const config = new RetargetConfig();
  config.sideInversion.hands = true;
  const out = applyRetargeting({ leftIndexProximal: { x: 1, y: 0, z: 0 }, rightIndexProximal: { x: 2, y: 0, z: 0 } }, config);
  assert.equal(out.leftIndexProximal.x, 2);
});

test('retargeting : inversion et amplification par axe, fusionnées pour la paire', () => {
  const config = new RetargetConfig();
  config.setAxisInvert('leftLowerArm', 'y', true);
  config.setAmplification('rightLowerArm', 'z', 2);
  const out = applyRetargeting(
    { leftLowerArm: { x: 0.1, y: 0.2, z: 0.3 }, rightLowerArm: { x: 0.1, y: 0.2, z: 0.3 } },
    config,
  );
  for (const side of ['leftLowerArm', 'rightLowerArm']) {
    assert.ok(Math.abs(out[side].y + 0.2) < 1e-12, `${side} : y inversé`);
    assert.ok(Math.abs(out[side].z - 0.6) < 1e-12, `${side} : z amplifié`);
  }
});

test('retargeting : un canal de visage (x seul) reste à un axe', () => {
  const out = applyRetargeting({ mouthOpen: { x: 0.5 } }, new RetargetConfig());
  assert.deepEqual(out.mouthOpen, { x: 0.5 });
});

test('butées : valeurs ramenées dans la plage, réglables', () => {
  const constraints = new JointConstraints();
  const out = constraints.apply({ neck: { x: 2, y: -2, z: 0 }, spine: { x: 5, y: 0, z: 0 } });
  assert.equal(out.neck.x, 0.6);
  assert.equal(out.neck.y, -0.9);
  assert.equal(out.spine.x, 5, 'pas de limite par défaut sur la colonne');
  constraints.setLimit('spine', 'x', -1, 1);
  assert.equal(constraints.apply({ spine: { x: 5, y: 0, z: 0 } }).spine.x, 1);
});

test('butées : les limites par défaut ne sont pas partagées entre instances', () => {
  const a = new JointConstraints();
  a.setLimit('neck', 'x', 0, 0);
  assert.equal(new JointConstraints().apply({ neck: { x: 0.5, y: 0, z: 0 } }).neck.x, 0.5);
});
