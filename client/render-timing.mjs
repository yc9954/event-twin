export const SIMULATION_STEP_SECONDS = 1 / 60;
export const MAX_CATCH_UP_SECONDS = 0.25;

export function resetFrameClock() {
  return { lastNow: null, accumulator: 0 };
}

// Fixed physics steps follow elapsed foreground time, not the number of paints.
// Visibility/pause transitions reset the clock; a long main-thread stall is bounded.
export function planAnimationFrame(clock, now, active = true) {
  const idle = { steps: 0, stepSeconds: SIMULATION_STEP_SECONDS, droppedSeconds: 0 };
  if (!active || !Number.isFinite(now)) return { ...idle, clock: resetFrameClock() };
  if (clock.lastNow === null || now < clock.lastNow) {
    return { ...idle, clock: { lastNow: now, accumulator: 0 } };
  }
  const elapsed = Math.max(0, (now - clock.lastNow) / 1000);
  const bounded = Math.min(elapsed, MAX_CATCH_UP_SECONDS);
  const accumulated = clock.accumulator + bounded;
  const steps = Math.floor((accumulated + 1e-10) / SIMULATION_STEP_SECONDS);
  return {
    steps,
    stepSeconds: SIMULATION_STEP_SECONDS,
    droppedSeconds: elapsed - bounded,
    clock: {
      lastNow: now,
      accumulator: Math.max(0, accumulated - steps * SIMULATION_STEP_SECONDS),
    },
  };
}

export function presentationSize(rect, captureSize, devicePixelRatio = 1) {
  if (captureSize) {
    const { width, height } = captureSize;
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 16 || height < 16 || width > 3840 || height > 2160) {
      throw new RangeError("Capture resolution must be 16–3840 × 16–2160 pixels.");
    }
    return { width, height };
  }
  const ratio = Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(2, devicePixelRatio)) : 1;
  const scale = Math.min(ratio, 2560 / rect.width, 1536 / rect.height);
  return {
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

export function previewFrameRate(visiblePreviews) {
  // Keep the aggregate board render budget bounded as all sixteen cards enter view.
  return Math.max(15, Math.min(30, Math.floor(240 / Math.max(1, visiblePreviews))));
}

export function shouldPaint({ dirty, forcePaint, lastPaintAt, now, priority, previewFps = 30 }) {
  return dirty && (forcePaint || lastPaintAt === null ||
    now - lastPaintAt >= 1000 / (priority ? 60 : previewFps) - 0.5);
}

export function selectFollowTarget(agents, previous, time) {
  const current = agents.find(agent => agent.id === previous?.id);
  const moving = agent => agent && agent.speed > 0.15 && agent.wait <= 0;
  const lastMovingAt = moving(current) ? time : (previous?.lastMovingAt ?? time);
  if (current && time - previous.selectedAt < 20 && time - lastMovingAt < 3) {
    return { ...previous, lastMovingAt };
  }
  const next = agents.filter(moving).sort((a, b) => b.speed - a.speed || a.id - b.id)[0] || current || agents[0];
  return next ? { id: next.id, selectedAt: time, lastMovingAt: time } : null;
}
