import React, { useEffect, useRef, useState } from "react";
import Scene from "./Scene.jsx";
import { recordSceneCanvas, sceneRecordingSupport, SCENE_CAPTURE_SIZE } from "./scene-recording.mjs";

const cameras = [["perspective", "전체"], ["entry", "입구"], ["follow", "방문객 따라가기"], ["top", "평면"]];
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export default function ScenePlayer({ candidate, initialMoving = true }) {
  const host = useRef(null), session = useRef(null), mounted = useRef(true);
  const active = useRef(false), captureCandidate = useRef(null), downloadURL = useRef(null);
  const [view, setView] = useState("follow"), [moving, setMoving] = useState(initialMoving);
  const [status, setStatus] = useState("idle"), [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(""), [download, setDownload] = useState(null);
  const [support, setSupport] = useState({ supported: false, reason: "브라우저 녹화 지원 확인 중" });
  const capturing = status === "preparing" || status === "recording";

  useEffect(() => {
    mounted.current = true;
    setSupport(sceneRecordingSupport(host.current?.querySelector("canvas")));
    return () => {
      mounted.current = false;
      active.current = false;
      session.current?.cancel();
      session.current = null;
      if (downloadURL.current) URL.revokeObjectURL(downloadURL.current);
      downloadURL.current = null;
    };
  }, []);
  useEffect(() => {
    if (status !== "recording") return;
    const started = performance.now();
    const timer = setInterval(() => setElapsed(Math.min(20, (performance.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [status]);

  async function record() {
    if (active.current || !candidate) return;
    active.current = true;
    captureCandidate.current = candidate;
    setError(""); setElapsed(0); setStatus("preparing");
    try {
      // Wait for the 1080p render itself, not merely React's state commit.
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        await nextFrame();
        const canvas = host.current?.querySelector("canvas");
        if (canvas?.width === SCENE_CAPTURE_SIZE.width &&
            canvas?.height === SCENE_CAPTURE_SIZE.height &&
            canvas.dataset.captureReady === "true") { ready = true; break; }
      }
      if (!mounted.current || !active.current) return;
      if (!ready) throw new Error("1080p 장면 렌더가 준비되지 않았습니다. 화면의 3D 오류를 확인해 주세요.");
      const recorder = recordSceneCanvas(host.current?.querySelector("canvas"));
      session.current = recorder;
      setStatus("recording");
      const result = await recorder.done;
      if (!mounted.current) return;
      const url = URL.createObjectURL(result.blob);
      if (downloadURL.current) URL.revokeObjectURL(downloadURL.current);
      downloadURL.current = url;
      const id = String(captureCandidate.current?.id || "scene").replace(/[^a-zA-Z0-9_-]/g, "");
      const recorded = { ...result, url, name: `event-twin-${id}-1080p.${result.extension}` };
      setDownload(recorded);
      setStatus("saving");
      try {
        const response = await fetch("/api/demo/scene-video", {
          method: "POST",
          headers: { "Content-Type": result.blob.type },
          body: result.blob,
        });
        if (!response.ok) throw new Error(`로컬 저장 실패 (${response.status})`);
        const saved = await response.json();
        if (mounted.current) setDownload({ ...recorded, savedPath: saved.path });
      } catch (saveError) {
        if (mounted.current) setError(`${saveError.message} · 브라우저 다운로드는 사용할 수 있습니다.`);
      }
      setStatus("ready");
    } catch (failure) {
      if (mounted.current) { setError(failure.message || "녹화를 완료하지 못했습니다."); setStatus("error"); }
    } finally {
      active.current = false;
      session.current = null;
      captureCandidate.current = null;
    }
  }

  return <section className={`scene-player${capturing ? " is-recording" : ""}`} aria-label="3D 공간 영상 플레이어">
    <div className="scene-player-toolbar">
      <div className="segmented scene-player-cameras" role="group" aria-label="3D 카메라">
        {cameras.map(([key, label]) => <button key={key} type="button" aria-pressed={view === key}
          className={view === key ? "active" : ""} disabled={capturing} onClick={() => setView(key)}>{label}</button>)}
      </div>
      <button type="button" className="scene-player-play" disabled={capturing}
        aria-label={moving ? "방문객 모션 일시정지" : "방문객 모션 재생"}
        onClick={() => setMoving((value) => !value)}>{moving ? "일시정지" : "재생"}</button>
    </div>
    <div ref={host} className="scene-player-stage detail-scene">
      <Scene candidate={capturing ? captureCandidate.current : candidate} view={view}
        moving={capturing || moving} captureSize={capturing ? SCENE_CAPTURE_SIZE : null} />
      <div className="scene-player-overlay" aria-hidden="true">
        <span>{capturing ? "● REC · 1080p" : moving ? "방문객 모션 재생 중" : "일시정지"}</span>
        <span>{cameras.find(([key]) => key === view)?.[1]}</span>
      </div>
    </div>
    <div className="scene-player-recording">
      <div className="scene-player-record-actions">
        {status === "recording"
          ? <button type="button" className="scene-record-button recording" onClick={() => session.current?.stop()}>녹화 종료 · 저장</button>
          : <button type="button" className="scene-record-button" disabled={capturing || !support.supported || !candidate} onClick={record}>
            {status === "preparing" ? "1080p 준비 중…" : "20초 HD 영상 녹화"}</button>}
        {download && !capturing && <a className="scene-download-link" href={download.url} download={download.name}>
          {download.extension.toUpperCase()} 영상 다운로드 · {(download.durationMs / 1000).toFixed(1)}초
        </a>}
      </div>
      <p className="scene-record-status" role="status" aria-live="polite">
        {status === "recording" ? `녹화 중 ${elapsed.toFixed(1)} / 20초 · 카메라·해상도 고정`
          : status === "preparing" ? "1920 × 1080 캔버스를 준비합니다."
          : status === "saving" ? "녹화한 영상을 로컬 프로젝트에 저장하는 중…"
          : status === "ready" ? `1080p 영상 준비 완료 · ${download?.frameRate ? `${download.frameRate}fps 트랙` : "30fps 요청"}`
          : support.supported ? "1920 × 1080 · 30fps 요청 · 최대 20초 · 마이크 없음" : support.reason}
      </p>
      {error && <p className="scene-record-error" role="alert">{error}</p>}
      {download?.savedPath && <p className="scene-record-status" role="status">로컬 저장 완료 · {download.savedPath}</p>}
    </div>
    <p className="scene-player-disclaimer">방문객은 절차적 시각화입니다. 실측 이동이나 LLM 페르소나의 행동 예측이 아닙니다. 녹화는 3D 캔버스만 저장하며, 음성·화면 공유·외부 전송을 사용하지 않습니다.</p>
  </section>;
}
