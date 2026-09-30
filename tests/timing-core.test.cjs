const test = require('node:test');
const assert = require('node:assert/strict');
require('../timing/core.js');
const { MotionGate, calibration, frameDifference, detectionRegion, cameraError } = globalThis.PaceTrackTiming;
test('calibration refuses insufficient, dark, overexposed or moving scenes', () => {
  assert.equal(calibration([]).ok, false);
  for (const light of [0, 255]) assert.equal(calibration(Array.from({ length: 30 }, () => ({ score: 0, light }))).ok, false);
  assert.equal(calibration(Array.from({ length: 50 }, () => ({ score: 50, light: 90 }))).ok, false);
  const valid = calibration(Array.from({ length: 70 }, () => ({ score: 3, light: 90 })));
  assert.equal(valid.ok, true); assert.equal(valid.threshold, 14);
});
test('one spike is rejected, one sustained crossing emits once at its first frame', () => {
  const gate = new MotionGate({ threshold: 20 });
  assert.equal(gate.update(30, 1000), null);
  assert.equal(gate.update(2, 1033), null);
  assert.equal(gate.update(30, 1066), null);
  assert.equal(gate.update(30, 1100).at, 1066);
  for (let t = 1133; t < 3000; t += 33) assert.equal(gate.update(40, t), null);
});
test('rearm requires a quiet interval and minimum separation', () => {
  const gate = new MotionGate({ threshold: 20 });
  gate.update(30, 0); assert.ok(gate.update(30, 33));
  gate.update(0, 100); gate.update(0, 240);
  assert.equal(gate.update(30, 270), null);
  gate.update(0, 350); gate.update(0, 520);
  assert.equal(gate.update(30, 600), null); assert.ok(gate.update(30, 633));
});
test('frame score is resolution-independent and samples RGB safely', () => {
  const a = new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255]);
  const b = new Uint8ClampedArray([40, 40, 40, 255, 40, 40, 40, 255]);
  assert.deepEqual(frameDifference(b, a), { score: 30, light: 40, fraction: 1 });
  assert.equal(frameDifference(b, null).score, 0);
});
test('camera errors explain recovery rather than silently arming', () => {
  assert.match(cameraError({ name: 'NotAllowedError' }), /permiso/);
  assert.match(cameraError({}, false), /HTTPS/);
  assert.match(cameraError({ name: 'NotFoundError' }), /manual/);
});
test('analysis matches the visible central line, excluding object-fit cover crop', () => {
  const wide = detectionRegion(640, 480, 1280, 720);
  assert.equal(wide.width, 32); assert.equal(wide.y, 60); assert.equal(wide.height, 360);
  const portrait = detectionRegion(640, 480, 390, 844);
  assert.ok(portrait.width < 12); assert.equal(portrait.height, 480);
  assert.equal(portrait.x + portrait.width / 2, 320);
});