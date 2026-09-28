import test from "node:test";
import assert from "node:assert/strict";
import { recordSceneCanvas, sceneRecordingSupport } from "../client/scene-recording.mjs";

function fixture({ mime = "video/webm;codecs=vp9", startError = false } = {}) {
  const state = { stoppedTracks: 0, cleared: 0, time: 0 };
  const track = { stop: () => state.stoppedTracks++, getSettings: () => ({ frameRate: 30 }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  class Recorder {
    static isTypeSupported(type) { return type === mime; }
    constructor(received, options) { assert.equal(received, stream); this.state = "inactive"; this.mimeType = options.mimeType; state.options = options; state.recorder = this; }
    start() { if (startError) throw new Error("encoder unavailable"); this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  }
  const canvas = { width: 1920, height: 1080, captureStream: fps => { state.fps = fps; return stream; } };
  const options = { Recorder, schedule: (fn, ms) => { state.timer = fn; state.duration = ms; return 1; }, unschedule: () => state.cleared++, clock: () => state.time };
  return { canvas, options, state, chunk: () => state.recorder.ondataavailable({ data: new Blob(["actual-encoded-frame"]) }) };
}

test("recording requires canvas capture and a supported encoder, including MP4", () => {
  assert.equal(sceneRecordingSupport({}, class {}).supported, false);
  const f = fixture({ mime: "video/mp4" });
  assert.deepEqual(sceneRecordingSupport(f.canvas, f.options.Recorder), { supported: true, mimeType: "video/mp4" });
  assert.equal(sceneRecordingSupport(f.canvas, class { static isTypeSupported() { return false; } }).supported, false);
});

test("actual stream uses HD canvas, requested frame rate, bitrate and bounded duration", async () => {
  const f = fixture();
  const recording = recordSceneCanvas(f.canvas, f.options);
  assert.equal(f.state.fps, 30); assert.equal(f.state.options.videoBitsPerSecond, 16000000);
  assert.equal(f.state.duration, 20000);
  f.chunk(); f.state.time = 20000; f.state.timer();
  const result = await recording.done;
  assert.equal(await result.blob.text(), "actual-encoded-frame");
  assert.equal(result.width, 1920); assert.equal(result.height, 1080);
  assert.equal(result.durationMs, 20000); assert.equal(result.extension, "webm");
  assert.equal(f.state.stoppedTracks, 1); assert.equal(f.state.cleared, 1);
});

test("manual stop produces an honestly timed MP4 clip and releases tracks", async () => {
  const f = fixture({ mime: "video/mp4" }); const recording = recordSceneCanvas(f.canvas, f.options);
  f.chunk(); f.state.time = 4200; recording.stop(); recording.stop();
  const result = await recording.done;
  assert.equal(result.durationMs, 4200); assert.equal(result.extension, "mp4");
  assert.equal(result.blob.type, "video/mp4"); assert.equal(f.state.stoppedTracks, 1);
});

test("unmount cancellation stops encoder and tracks without producing a download", async () => {
  const f = fixture(); const recording = recordSceneCanvas(f.canvas, f.options);
  f.chunk(); const rejected = assert.rejects(recording.done, /취소/); recording.cancel(); await rejected;
  assert.equal(f.state.recorder.state, "inactive"); assert.equal(f.state.stoppedTracks, 1);
  assert.equal(f.state.cleared, 1); assert.equal(f.state.recorder.onstop, null);
});

test("encoder error and empty recording fail honestly and clean up", async () => {
  for (const encoderError of [true, false]) {
    const f = fixture(); const recording = recordSceneCanvas(f.canvas, f.options);
    const rejected = assert.rejects(recording.done, encoderError ? /인코더/ : /데이터가 없습니다/);
    if (encoderError) f.state.recorder.onerror(); else recording.stop();
    await rejected; assert.equal(f.state.stoppedTracks, 1); assert.equal(f.state.cleared, 1);
  }
});

test("failed encoder startup releases the acquired video stream", () => {
  const f = fixture({ startError: true });
  assert.throws(() => recordSceneCanvas(f.canvas, f.options), /시작하지 못했습니다/);
  assert.equal(f.state.stoppedTracks, 1);
});

test("recording refuses a resized or not-yet-ready canvas before acquiring a stream", () => {
  const f = fixture(); f.canvas.width = 960;
  assert.throws(() => recordSceneCanvas(f.canvas, f.options), /1080p/);
  assert.equal(f.state.fps, undefined);
});
