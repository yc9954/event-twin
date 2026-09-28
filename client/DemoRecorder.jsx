import React, { useEffect, useRef, useState } from 'react';
import { Video, Square, Download, X, Circle, AlertTriangle } from 'lucide-react';

export const TAB_CAPTURE_OPTIONS = Object.freeze({
  video: { displaySurface: 'browser', frameRate: { ideal: 30, max: 60 } },
  audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
  monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude',
});
const CODECS = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm'];
export function chooseRecordingMime(Recorder) {
  return typeof Recorder?.isTypeSupported === 'function' ? CODECS.find(type => Recorder.isTypeSupported(type)) || null : null;
}
export const idleRecording = () => ({ status: 'idle', elapsedMs: 0, settings: null, bytes: 0, url: null, filename: '', mimeType: '', error: '', reason: '' });
const stopTracks = stream => stream?.getTracks().forEach(track => { try { track.stop(); } catch {} });
const permissionError = error => error?.name === 'NotAllowedError' ? '탭 공유가 취소되었거나 권한이 허용되지 않았습니다. 녹화를 시작하지 않았습니다.' : error?.name === 'InvalidStateError' ? '활성 앱 화면에서 녹화 버튼을 직접 눌러 시작하세요.' : error?.name === 'NotReadableError' ? '선택한 탭을 읽을 수 없습니다. 공유 권한과 브라우저 상태를 확인하세요.' : '녹화를 시작하지 못했습니다. 이 브라우저의 탭 공유 지원을 확인하세요.';

/** UI-driven tab capture only. Dependencies make permission and cleanup paths testable without recording a screen. */
export function createTabRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  urls = globalThis.URL,
  BlobClass = globalThis.Blob,
  now = () => globalThis.performance.now(),
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  maxDurationMs = 600000,
  onUpdate = () => {},
  onReady = () => {},
} = {}) {
  let state = idleRecording(), stream = null, recorder = null, chunks = [], startedAt = 0;
  let generation = 0, disposed = false, ticker = null, deadline = null, stopDeadline = null, endedHandler = null;
  const durationLimit = Number.isFinite(maxDurationMs) ? Math.min(600000, Math.max(1000, maxDurationMs)) : 600000;
  function update(patch) { state = { ...state, ...patch }; if (!disposed) onUpdate({ ...state }); }
  function clearTimers() { if (ticker !== null) clearIntervalFn(ticker); if (deadline !== null) clearTimeoutFn(deadline); if (stopDeadline !== null) clearTimeoutFn(stopDeadline); ticker = deadline = stopDeadline = null; }
  function releaseStream() { if (stream && endedHandler) stream.getVideoTracks().forEach(track => track.removeEventListener('ended', endedHandler)); endedHandler = null; stopTracks(stream); stream = null; }
  function releaseRecorder() { if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; } }
  function revokeResult() { if (state.url) { urls.revokeObjectURL(state.url); state = { ...state, url: null, filename: '' }; } }
  function fail(message) {
    clearTimers();
    const active = recorder; releaseRecorder();
    if (active && active.state !== 'inactive') { try { active.stop(); } catch {} }
    releaseStream(); recorder = null; chunks = []; revokeResult();
    update({ status: 'error', error: message, url: null, filename: '' });
  }
  function finish(token) {
    if (disposed || token !== generation) return;
    clearTimers(); releaseStream(); releaseRecorder();
    const mimeType = recorder?.mimeType || state.mimeType;
    recorder = null;
    if (!chunks.length) { fail('저장할 영상 데이터가 없습니다. 빈 영상을 성공한 녹화로 표시하지 않습니다.'); return; }
    try {
      const blob = new BlobClass(chunks, { type: mimeType }); chunks = [];
      if (!blob.size) { fail('녹화 파일이 비어 있습니다.'); return; }
      const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      const filename = `event-twin-tab-${new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z')}.${extension}`;
      const url = urls.createObjectURL(blob);
      update({ status: 'ready', bytes: blob.size, url, filename, mimeType, error: '' });
      onReady(blob);
    } catch { fail('브라우저에서 녹화 파일을 만들지 못했습니다. 메모리와 저장 공간을 확인하세요.'); }
  }
  function stop(reason = 'owner') {
    if (!['recording', 'stopping'].includes(state.status) || state.status === 'stopping') return;
    update({ status: 'stopping', elapsedMs: Math.max(0, now() - startedAt), reason });
    clearTimers();
    const token = generation;
    stopDeadline = setTimeoutFn(() => { if (!disposed && token === generation && state.status === 'stopping') fail('녹화 파일 마무리가 완료되지 않았습니다. 새 녹화를 시작하기 전에 브라우저 상태를 확인하세요.'); }, 10000);
    try { if (recorder?.state !== 'inactive') recorder.stop(); else finish(token); }
    catch { fail('녹화를 정상 종료하지 못했습니다.'); }
    releaseStream();
  }
  async function start() {
    if (disposed || ['requesting', 'recording', 'stopping'].includes(state.status)) return;
    if (typeof mediaDevices?.getDisplayMedia !== 'function' || !Recorder) { fail('이 브라우저에서는 실제 탭 녹화를 지원하지 않습니다. Chrome에서 앱을 열어 다시 시도하세요.'); return; }
    const mimeType = chooseRecordingMime(Recorder);
    if (!mimeType) { fail('이 브라우저에서 지원하는 녹화 코덱이 없습니다.'); return; }
    const token = ++generation;
    revokeResult(); chunks = []; state = idleRecording(); update({ status: 'requesting', mimeType });
    let requestedStream;
    try {
      // Called directly from the click handler, before any other await: retains user activation.
      requestedStream = await mediaDevices.getDisplayMedia(TAB_CAPTURE_OPTIONS);
      if (disposed || token !== generation) { stopTracks(requestedStream); return; }
      const tracks = requestedStream.getVideoTracks(), settings = tracks[0]?.getSettings() || {};
      if (tracks.length !== 1 || settings.displaySurface !== 'browser') {
        stopTracks(requestedStream);
        fail('브라우저 탭만 녹화할 수 있습니다. 창·전체 모니터·확인할 수 없는 대상은 저장하지 않았습니다.'); return;
      }
      if (requestedStream.getAudioTracks().length) { stopTracks(requestedStream); fail('예상하지 않은 오디오 트랙이 있어 녹화를 중단했습니다. 마이크와 시스템 오디오는 녹음하지 않습니다.'); return; }
      if (tracks[0].readyState === 'ended') { stopTracks(requestedStream); fail('선택한 탭 공유가 녹화 시작 전에 종료되었습니다.'); return; }
      stream = requestedStream;
      recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: 16000000 });
      recorder.ondataavailable = event => {
        if (disposed || token !== generation || !['recording', 'stopping'].includes(state.status)) return;
        if (event.data?.size) { chunks.push(event.data); update({ bytes: state.bytes + event.data.size }); }
      };
      recorder.onerror = () => { if (!disposed && token === generation) fail('브라우저 녹화 중 오류가 발생했습니다. 캡처를 중단하고 리소스를 해제했습니다.'); };
      recorder.onstop = () => { if (disposed || token !== generation) return; if (state.status === 'recording') update({ elapsedMs: Math.max(0, now() - startedAt), reason: 'sharing-ended' }); finish(token); };
      endedHandler = () => stop('sharing-ended');
      tracks[0].addEventListener('ended', endedHandler, { once: true });
      startedAt = now();
      update({ status: 'recording', settings: {
        displaySurface: settings.displaySurface,
        width: Number.isFinite(settings.width) ? settings.width : null,
        height: Number.isFinite(settings.height) ? settings.height : null,
        frameRate: Number.isFinite(settings.frameRate) ? settings.frameRate : null,
      } });
      recorder.start(1000);
      if (state.status !== 'recording') return;
      ticker = setIntervalFn(() => { if (!disposed && token === generation && state.status === 'recording') update({ elapsedMs: Math.max(0, now() - startedAt) }); }, 500);
      deadline = setTimeoutFn(() => stop('time-limit'), durationLimit);
    } catch (error) {
      stopTracks(requestedStream);
      if (!disposed && token === generation) fail(permissionError(error));
    }
  }
  function dispose() {
    disposed = true; generation++; clearTimers(); releaseRecorder();
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
    releaseStream(); recorder = null; chunks = []; revokeResult();
  }
  return { start, stop, dispose, getState: () => ({ ...state }) };
}

const time = ms => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export default function DemoRecorder({ className = '', maxDurationMs = 600000 }) {
  const controller = useRef(null);
  const [state, setState] = useState(idleRecording), [panelOpen, setPanelOpen] = useState(false);
  const [savedPath, setSavedPath] = useState(''), [saveError, setSaveError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => {
    const value = createTabRecorder({ onUpdate: setState, maxDurationMs, onReady: async blob => {
      setSaving(true);
      setSaveError('');
      try {
        const response = await fetch('/api/demo/tab-video', { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob });
        if (!response.ok) throw new Error(`로컬 저장 실패 (${response.status})`);
        const result = await response.json();
        setSavedPath(result.path);
      } catch (error) { setSaveError(error.message || '로컬 저장 실패'); }
      finally { setSaving(false); }
    } });
    controller.current = value;
    return () => { controller.current = null; value.dispose(); };
  }, [maxDurationMs]);
  const active = ['requesting', 'recording', 'stopping'].includes(state.status);
  function start() { setSavedPath(''); setSaveError(''); setPanelOpen(true); void controller.current?.start(); }
  const labels = { requesting: '브라우저에서 앱 탭을 선택하세요', recording: '실제 탭 녹화 중', stopping: '영상 파일 마무리 중', ready: '영상 다운로드 준비', error: '녹화가 시작되지 않았거나 중단됨' };
  return <div className={`demo-recorder ${className}`} data-recording-state={state.status}>
    <button type="button" className="demo-recorder-trigger" aria-label="전체 화면 데모 녹화" onClick={() => state.status === 'idle' ? start() : setPanelOpen(open => !open)}>
      {state.status === 'recording' ? <Circle size={16} className="demo-recorder-live-dot" /> : <Video size={16} />}
      <span>{state.status === 'recording' ? `녹화 중 ${time(state.elapsedMs)}` : state.status === 'ready' ? '녹화 영상 다운로드' : '탭 데모 녹화'}</span>
    </button>
    {panelOpen && <section className="demo-recorder-panel" aria-label="실제 탭 데모 녹화 상태">
      <header><div><small>LOCAL TAB RECORDING</small><h3>{labels[state.status] || '탭 데모 녹화'}</h3></div>{!active && <button type="button" className="demo-recorder-close" aria-label="녹화 상태 패널 닫기" onClick={() => setPanelOpen(false)}><X size={16} /></button>}</header>
      <p className="demo-recorder-disclosure">현재 Event Twin 탭을 직접 선택하세요. 다른 탭·개인정보가 없는지 확인한 뒤 공유합니다. 마이크·시스템 소리는 녹음하지 않습니다.</p>
      {state.status === 'requesting' && <p role="status">브라우저 선택창에서 Event Twin 탭을 선택하세요. 창이나 전체 화면은 허용하지 않습니다.</p>}
      {state.error && <p className="demo-recorder-error" role="alert"><AlertTriangle size={16} />{state.error}</p>}
      {saveError && <p className="demo-recorder-error" role="alert">{saveError}</p>}
      {state.settings && <dl className="demo-recorder-stats"><div><dt>경과</dt><dd>{time(state.elapsedMs)}</dd></div><div><dt>캡처 해상도</dt><dd>{state.settings.width && state.settings.height ? `${state.settings.width} × ${state.settings.height}` : '브라우저 정보 없음'}</dd></div><div><dt>브라우저 FPS 설정</dt><dd>{state.settings.frameRate === null ? '미제공' : `${Number(state.settings.frameRate.toFixed(2))} fps`}</dd></div><div><dt>수집된 영상</dt><dd>{(state.bytes / 1024 / 1024).toFixed(1)} MB</dd></div></dl>}
      {state.settings && <p className="demo-recorder-note">FPS는 브라우저가 보고한 설정값이며 실제 렌더링·저장 프레임 보장이 아닙니다. 원본 프레임을 직접 기록하며 보간하지 않습니다. 목표 비트레이트 16 Mbps · 최대 10분.</p>}
      {state.reason === 'sharing-ended' && <p role="status">탭 공유가 종료되어 녹화를 마쳤습니다.</p>}
      {state.reason === 'time-limit' && <p role="status">최대 녹화 시간에 도달해 자동 종료했습니다.</p>}
      <div className="demo-recorder-actions">
        {state.status === 'recording' && <button type="button" className="btn" aria-label="탭 데모 녹화 종료" onClick={() => controller.current?.stop()}><Square size={14} />녹화 종료</button>}
        {state.status === 'stopping' && <button type="button" className="btn" disabled>파일 만드는 중…</button>}
        {state.url && <a className="btn primary" href={state.url} download={state.filename} aria-label="실제 탭 녹화 영상 다운로드"><Download size={15} />영상 다운로드</a>}
        {!active && <button type="button" className="btn" onClick={start}>{state.status === 'ready' ? '새 녹화' : '다시 시작'}</button>}
      </div>
      {saving && <p className="demo-recorder-note" role="status">로컬 파일로 저장하는 중…</p>}
      {savedPath && <p className="demo-recorder-note" role="status">로컬 저장 완료 · {savedPath}</p>}
      {state.status === 'ready' && !savedPath && !saving && <p className="demo-recorder-note">로컬 저장이 안 되었다면 새 녹화나 새로고침 전에 다운로드하세요.</p>}
    </section>}
  </div>;
}
