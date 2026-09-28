export const SCENE_CAPTURE_SIZE = Object.freeze({ width: 1920, height: 1080 });
export const SCENE_RECORDING_PROFILE = Object.freeze({
  ...SCENE_CAPTURE_SIZE,
  frameRate: 30,
  durationMs: 20000,
  videoBitsPerSecond: 16000000,
});

const mimeTypes = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
];

export function sceneRecordingSupport(canvas, Recorder = globalThis.MediaRecorder) {
  if (typeof canvas?.captureStream !== "function" || typeof Recorder !== "function")
    return { supported: false, reason: "이 브라우저는 캔버스 영상 녹화를 지원하지 않습니다." };
  const mimeType = mimeTypes.find((type) => Recorder.isTypeSupported?.(type));
  return mimeType
    ? { supported: true, mimeType }
    : { supported: false, reason: "이 브라우저에서 지원하는 WebM/MP4 인코더를 찾지 못했습니다." };
}

// Only this canvas is captured. No microphone, display capture, upload or API call.
export function recordSceneCanvas(canvas, {
  Recorder = globalThis.MediaRecorder,
  schedule = globalThis.setTimeout,
  unschedule = globalThis.clearTimeout,
  clock = () => performance.now(),
} = {}) {
  const support = sceneRecordingSupport(canvas, Recorder);
  if (!support.supported) throw new Error(support.reason);
  const profile = SCENE_RECORDING_PROFILE;
  if (canvas.width !== profile.width || canvas.height !== profile.height)
    throw new Error("1080p 캔버스가 아직 준비되지 않았습니다. 잠시 후 다시 녹화해주세요.");
  const stream = canvas.captureStream(profile.frameRate);
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  let recorder;
  try {
    if (!stream.getVideoTracks().length) throw new Error("영상 트랙이 없습니다.");
    recorder = new Recorder(stream, {
      mimeType: support.mimeType,
      videoBitsPerSecond: profile.videoBitsPerSecond,
    });
  } catch (error) {
    stopTracks();
    throw new Error(`녹화 인코더를 시작할 수 없습니다: ${error.message}`);
  }

  const chunks = [];
  let timer, settled = false, resolveDone, rejectDone;
  const started = clock();
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const cleanup = () => {
    if (timer !== undefined) unschedule(timer);
    recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
    stopTracks();
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    // Detach handlers before stopping; cancellation must not produce a download.
    cleanup();
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch {}
    }
    rejectDone(error);
  };
  const stop = () => {
    if (settled || recorder.state === "inactive") return;
    try { recorder.stop(); } catch { fail(new Error("녹화를 마무리하지 못했습니다.")); }
  };
  recorder.ondataavailable = ({ data }) => { if (data?.size) chunks.push(data); };
  recorder.onerror = () => fail(new Error("브라우저 영상 인코더에서 오류가 발생했습니다. 녹화 파일을 만들지 못했습니다."));
  recorder.onstop = () => {
    if (settled) return;
    if (!chunks.length) { fail(new Error("녹화된 영상 데이터가 없습니다. 파일을 저장하지 않았습니다.")); return; }
    settled = true;
    const mimeType = recorder.mimeType || support.mimeType;
    const blob = new Blob(chunks, { type: mimeType });
    const frameRate = stream.getVideoTracks()[0]?.getSettings?.().frameRate ?? null;
    const durationMs = Math.max(0, clock() - started);
    cleanup();
    resolveDone({ blob, mimeType, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
      width: profile.width, height: profile.height, requestedFrameRate: profile.frameRate,
      frameRate, durationMs });
  };
  try {
    recorder.start(250);
    timer = schedule(stop, profile.durationMs);
  } catch (error) {
    cleanup();
    throw new Error(`녹화를 시작하지 못했습니다: ${error.message}`);
  }
  return { done, stop, cancel: () => fail(new Error("녹화가 취소되었습니다.")) };
}
