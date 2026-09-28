import React, { useEffect, useRef, useState } from "react";
import { registerView } from "./scene-renderer.js";

export default function Scene({
  candidate,
  view = "perspective",
  moving = true,
  captureSize,
  className = "",
}) {
  const host = useRef(),
    canvas = useRef(),
    registration = useRef();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!candidate) return;
    registration.current = registerView(host.current, canvas.current, {
      candidate,
      view,
      moving,
      captureSize,
      onError: setError,
    });
    return () => {
      registration.current?.dispose();
      registration.current = null;
    };
  }, [Boolean(candidate)]);
  useEffect(() => {
    setError("");
    registration.current?.update({
      candidate,
      view,
      moving,
      captureSize,
      onError: setError,
    });
  }, [candidate, view, moving, captureSize]);
  return (
    <div
      ref={host}
      className={`scene-view ${className}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: 110,
        overflow: "hidden",
        background: "#e7eaec",
      }}
    >
      <canvas
        ref={canvas}
        style={{ display: "block", width: "100%", height: "100%" }}
        role="img"
        aria-label={`${candidate?.name || "공간"} · ${candidate?.space?.width || 24} × ${candidate?.space?.depth || 18}m · 절차적 관객 모션`}
      />
      {!candidate && (
        <span style={{ position: "absolute", inset: 20 }}>
          공간 입력을 준비해주세요.
        </span>
      )}
      {error && (
        <div
          role="status"
          style={{
            position: "absolute",
            inset: 12,
            background: "#fff",
            padding: 12,
            fontSize: 12,
          }}
        >
          3D 표시 실패. 수치와 비교 기능은 계속 사용할 수 있습니다.
          <small style={{ display: "block" }}>{error}</small>
        </div>
      )}
    </div>
  );
}
