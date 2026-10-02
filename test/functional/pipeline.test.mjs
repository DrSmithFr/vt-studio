// Tests fonctionnels du pipeline complet, hors navigateur :
// détection (synthétique, format MediaPipe) → lissage → valeurs relatives →
// KeyPose → retargeting / butées → suivi par ressort.
// Les résultats sont vérifiés comme des directions d'os dans le repère de
// l'avatar (y vers le haut, avatar tourné vers +Z, son côté gauche vers +X).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureExtractor } from '../../src/core/FeatureExtractor.js';
import { KeyPoseBuilder } from '../../src/core/KeyPoseBuilder.js';
import { DetectionSmoother } from '../../src/core/DetectionSmoother.js';
import { RetargetConfig, applyRetargeting } from '../../src/core/RetargetConfig.js';
import { JointConstraints } from '../../src/core/JointConstraints.js';
import { SpringFollower } from '../../src/core/SpringFollower.js';
import { ROTATION_JOINTS } from '../../src/core/JointSchema.js';
import { createDefaultSettings } from '../../src/ui/SettingsStore.js';
import {
  DEG,
  LEFT_ARM_DOWN,
  LEFT_ARM_FORWARD,
  LEFT_ELBOW_UP,
  armChain,
  assertDirection,
  boneDirection,
  makeDetection,
  makeFace,
  makeLeftHandDown,
  makePose,
} from '../helpers.mjs';

const BUILD = { restPose: { body: 'armsDown', hands: 'relaxed' }, motion: { lateralRange: 1, verticalRange: 1 }, bodyCalibrated: false };

// Extraction (répétée pour stabiliser les longueurs calibrées) + KeyPose.
function run(detection, { mirror = false, framing = 'standing', calibration = {}, build = {} } = {}) {
  const extractor = new FeatureExtractor();
  let extraction;
  for (let i = 0; i < 3; i++) extraction = extractor.extract(detection, { mirror, aspect: 1, framing, calibration });
  return { extraction, ...new KeyPoseBuilder().build(extraction, { ...BUILD, ...build }) };
}

// Côté de l'avatar animé par le bras gauche de la personne, et direction de
// repos de ce bras.
const driven = (mirror) => (mirror ? { side: 'right', rest: [-1, 0, 0] } : { side: 'left', rest: [1, 0, 0] });

for (const mirror of [false, true]) {
  describe(`bras et tronc (${mirror ? 'miroir' : 'direct'})`, () => {
    const { side, rest } = driven(mirror);
    const cases = [
      ['T-pose', {}, [rest[0], 0, 0], [rest[0], 0, 0]],
      ['bras le long du corps', LEFT_ARM_DOWN, [0, -1, 0], [0, -1, 0]],
      ['bras tendu vers la caméra', LEFT_ARM_FORWARD, [0, 0, 1], [0, 0, 1]],
      ['coude plié, avant-bras vers le haut', LEFT_ELBOW_UP, [rest[0], 0, 0], [0, 1, 0]],
    ];
    for (const [name, overrides, upper, lower] of cases) {
      test(name, () => {
        const { pose } = run(makeDetection({ pose: makePose(overrides) }), { mirror });
        assertDirection(assert, boneDirection(pose, ['hips', 'spine', 'chest'], [0, 1, 0]), [0, 1, 0], 3, 'colonne');
        assertDirection(assert, boneDirection(pose, armChain(side), rest), upper, 5, 'bras');
        assertDirection(assert, boneDirection(pose, armChain(side, `${side}LowerArm`), rest), lower, 5, 'avant-bras');
      });
    }
  });

  describe(`main (${mirror ? 'miroir' : 'direct'})`, () => {
    const { side, rest } = driven(mirror);
    const handChain = armChain(side, `${side}LowerArm`, `${side}Hand`);
    for (const withHand of [true, false]) {
      test(`bras le long du corps, paume vers l'avant (${withHand ? 'HandLandmarker' : 'repli sur la pose'})`, () => {
        const hands = withHand ? { left: makeLeftHandDown() } : {};
        const { pose } = run(makeDetection({ pose: makePose(LEFT_ARM_DOWN), hands }), { mirror });
        assertDirection(assert, boneDirection(pose, handChain, rest), [0, -1, 0], 10, 'doigts vers le bas');
        assertDirection(assert, boneDirection(pose, handChain, [0, -1, 0]), [0, 0, 1], 10, 'paume vers la caméra');
        assertDirection(assert, boneDirection(pose, handChain, [0, 0, 1]), [rest[0], 0, 0], 10, 'pouce vers l\'extérieur');
      });
    }

    test('index qui se plie vers la paume', () => {
      const detection = makeDetection({ pose: makePose(LEFT_ARM_DOWN), hands: { left: makeLeftHandDown({ curl: 0.6 }) } });
      const { pose, extraction } = run(detection, { mirror });
      assert.ok(extraction.values[`${side}_index_baseFlex`] > 20 * DEG, 'flexion de la base positive');
      assert.ok(extraction.values[`${side}_index_tipFlex`] > 50 * DEG, 'bout plié');
      const tip = boneDirection(pose, [...handChain, `${side}IndexProximal`, `${side}IndexIntermediate`], rest);
      assert.ok(tip.z > 0.5, `la phalange penche côté paume (+z), obtenu ${tip.z.toFixed(2)}`);
    });
  });

  test(`tête : lacet (${mirror ? 'miroir' : 'direct'})`, () => {
    const { extraction, pose } = run(makeDetection({ pose: null, face: makeFace({ yaw: 30 * DEG }) }), { mirror });
    const expected = mirror ? -30 : 30;
    assert.ok(Math.abs(extraction.values.headYaw / DEG - expected) < 1, `lacet ${extraction.values.headYaw / DEG}°`);
    // Regard de l'avatar tourné vers son côté gauche (+X) en direct.
    const gaze = boneDirection(pose, ['neck', 'head'], [0, 0, 1]);
    assert.ok(Math.sign(gaze.x) === Math.sign(expected), 'regard du bon côté');
  });
}

test('tête penchée vers l\'avant : regard vers le bas', () => {
  const { pose } = run(makeDetection({ pose: null, face: makeFace({ pitch: 20 * DEG }) }));
  assert.ok(boneDirection(pose, ['neck', 'head'], [0, 0, 1]).y < -0.2);
});

test('genou plié : le tibia part vers l\'arrière', () => {
  const detection = makeDetection({ pose: makePose({ 27: [0.1, 0.7, 0.35] }) });
  const { pose, extraction } = run(detection);
  assert.ok(extraction.values.leftKneeBend > 30 * DEG);
  assert.ok(boneDirection(pose, ['hips', 'leftUpperLeg', 'leftLowerLeg'], [0, -1, 0]).z < -0.5);
});

test('cadrage : jambes figées si assis ou peu visibles en automatique', () => {
  const bent = { 27: [0.1, 0.7, 0.35] };
  const zero = { x: 0, y: 0, z: 0 };
  assert.deepEqual(run(makeDetection({ pose: makePose(bent) }), { framing: 'seated' }).pose.leftLowerLeg, zero);
  const hidden = makePose(bent, { visibility: { 25: 0.2, 27: 0.1 } });
  assert.deepEqual(run(makeDetection({ pose: hidden }), { framing: 'auto' }).pose.leftLowerLeg, zero);
  assert.notDeepEqual(run(makeDetection({ pose: makePose(bent) }), { framing: 'auto' }).pose.leftLowerLeg, zero);
});

test('calibration du corps : la posture de référence devient le zéro', () => {
  const twisted = makePose({ 11: [0.17, -0.5, 0.05], 12: [-0.17, -0.5, -0.05] });
  const { extraction } = run(makeDetection({ pose: twisted }));
  assert.ok(Math.abs(extraction.values.spineTwist) > 10 * DEG, 'rotation non calibrée');
  const calibrated = run(makeDetection({ pose: twisted }), { calibration: { body: extraction.raw } });
  assert.ok(Math.abs(calibrated.extraction.values.spineTwist) < 1e-9, 'rotation nulle après calibration');
});

test('déplacement du bassin : latéral toujours, vertical seulement après calibration', () => {
  const shifted = makeDetection({ pose: makePose({}, { screenOffset: [0.1, 0.05] }) });
  const uncalibrated = run(shifted, { mirror: false });
  assert.ok(Math.abs(uncalibrated.hipsOffset.x - 0.1) < 1e-9, 'latéral');
  assert.equal(uncalibrated.hipsOffset.y, 0, 'vertical désactivé sans calibration');
  assert.ok(run(shifted, { mirror: true }).hipsOffset.x < 0, 'latéral inversé en miroir');
  const calibrated = run(shifted, {
    calibration: { body: { shouldersY: 0.25 } },
    build: { bodyCalibrated: true },
  });
  assert.ok(calibrated.hipsOffset.y < 0, 'épaules plus basses que la référence → l\'avatar descend');
});

test('parties non détectées : poses de repos du corps et des mains', () => {
  const settings = { ...BUILD, restPose: { body: 'tPose', hands: 'fist' } };
  const extraction = { values: {}, has: { body: false, face: false, left: false, right: false, legs: false }, expressions: null };
  const { pose } = new KeyPoseBuilder().build(extraction, settings);
  assertDirection(assert, boneDirection(pose, armChain('left'), [1, 0, 0]), [1, 0, 0], 2, 'T-pose');
  // Poing : la 2e phalange de l'index, pliée côté paume (-Y au repos),
  // revient vers le poignet (plus de 120° par rapport au doigt tendu).
  const fist = boneDirection(pose, ['leftIndexProximal', 'leftIndexIntermediate'], [1, 0, 0]);
  assert.ok(fist.y < 0, 'repliée côté paume');
  assert.ok(Math.acos(fist.x) > 120 * DEG, `courbure ${(Math.acos(fist.x) / DEG).toFixed(0)}°`);
});

test('repos naturel des doigts : zéro → pose « Repos des mains » du modèle', () => {
  const detection = makeDetection({ pose: makePose(LEFT_ARM_DOWN), hands: { left: makeLeftHandDown({ curl: 0.3 }) } });
  const extractor = new FeatureExtractor();
  const raw = extractor.extract(detection, { mirror: false, aspect: 1, framing: 'standing' }).raw;
  // Référence = main naturelle actuelle : les valeurs des doigts sont nulles.
  const extraction = extractor.extract(detection, { mirror: false, aspect: 1, framing: 'standing', calibration: { hands: raw } });
  assert.ok(Math.abs(extraction.values.left_index_tipFlex) < 1e-9);
  const relative = new KeyPoseBuilder().build(extraction, { ...BUILD, handsRelativeToRest: true }).pose;
  const absolute = new KeyPoseBuilder().build(extraction, { ...BUILD, handsRelativeToRest: false }).pose;
  const rest = new KeyPoseBuilder().build({ ...extraction, has: { ...extraction.has, left: false } }, BUILD).pose;
  assert.deepEqual(relative.leftIndexIntermediate, rest.leftIndexIntermediate, 'main naturelle = repos du modèle');
  assert.ok(Math.abs(absolute.leftIndexIntermediate.z) < 1e-9, 'sans le mode relatif : doigt tendu');
});

test('expressions : en miroir, l\'œil gauche de la personne ferme l\'œil droit de l\'avatar', () => {
  const face = makeFace({ blendshapes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1, jawOpen: 0.5 } });
  const direct = run(makeDetection({ pose: null, face }), { mirror: false }).pose;
  const mirrored = run(makeDetection({ pose: null, face }), { mirror: true }).pose;
  assert.equal(direct.leftEyeBlink.x, 0.9);
  assert.equal(mirrored.rightEyeBlink.x, 0.9);
  assert.equal(mirrored.mouthOpen.x, 0.5);
});

test('proportions du modèle : le coude se place selon le bras du modèle', () => {
  const extraction = run(makeDetection({ pose: makePose(LEFT_ELBOW_UP) })).extraction;
  const builder = new KeyPoseBuilder();
  builder.setModelRest({ fingerDirections: {}, upperArmRatio: { left: 0.6, right: 0.6 } });
  const { pose } = builder.build(extraction, BUILD);
  assertDirection(assert, boneDirection(pose, armChain('left', 'leftLowerArm'), [1, 0, 0]), [0, 1, 0], 25, 'avant-bras toujours vers le haut');
});

test('pipeline complet : lissage → KeyPose → retargeting → butées → ressort', () => {
  const settings = createDefaultSettings();
  const smoother = new DetectionSmoother();
  const extractor = new FeatureExtractor();
  const builder = new KeyPoseBuilder();
  const retarget = new RetargetConfig();
  const constraints = new JointConstraints();
  const follower = new SpringFollower(ROTATION_JOINTS);

  const pose = makePose(LEFT_ARM_DOWN);
  let output;
  for (let frame = 0; frame < 120; frame++) {
    const t = frame * (1000 / 60);
    const detection = smoother.update(
      { ...makeDetection({ pose, face: makeFace() }), timestamps: { pose: t, face: t, hands: t } },
      settings.smoothing,
    );
    const extraction = extractor.extract(detection, { mirror: true, aspect: 16 / 9, framing: 'auto', calibration: settings.calibration });
    const keyPose = builder.build(extraction, { restPose: settings.restPose, motion: settings.motion, bodyCalibrated: false });
    const target = constraints.apply(applyRetargeting(keyPose.pose, retarget));
    target.hipsOffset = keyPose.hipsOffset;
    output = follower.update(target, settings.joints, 1000 / 60);
  }
  // En miroir, le bras gauche de la personne anime le bras droit de l'avatar.
  assertDirection(assert, boneDirection(output, armChain('right'), [-1, 0, 0]), [0, -1, 0], 5, 'bras droit de l\'avatar baissé');
  assertDirection(assert, boneDirection(output, armChain('left'), [1, 0, 0]), [1, 0, 0], 5, 'bras gauche en T');
  for (const [name, value] of Object.entries(output)) {
    if (value && typeof value === 'object') {
      assert.ok(Object.values(value).every(Number.isFinite), `${name} : pas de NaN`);
    }
  }
});
