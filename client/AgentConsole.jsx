import React from 'react';
import { Activity, ArrowUpRight, Bot, Box, Check, ChevronDown, Circle, ClipboardList, Database, FileText, FlaskConical, Layers, LoaderCircle, MapPin, ShieldCheck, Terminal, TriangleAlert, Users } from 'lucide-react';
import { agentBlueprint } from '../shared/agent-blueprint.mjs';
import MarkdownBody from './MarkdownBody.jsx';
import './agent-console.css';

const TOOL_LABELS = Object.fromEntries(agentBlueprint.tools.map(tool => [tool.name, tool.label]));
const EVENT_LABELS = { run_started: '요청 접수', model_started: '모델 요청 시작', run_failed: '실행 실패', run_completed: '실행 완료' };
const EVENT_TYPES = { 'request.accepted': 'run_started', 'model.awaiting': 'model_started', 'tool.started': 'tool_started', 'tool.completed': 'tool_completed', 'tool.failed': 'tool_failed', 'response.completed': 'run_completed', 'response.failed': 'run_failed' };
const eventType = event => EVENT_TYPES[event?.type || event?.event] || event?.type || event?.event;
const statusText = { running: '실행 중', complete: '완료', failed: '실패', pending: '대기', recorded: '기록' };
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const textValue = value => typeof value === 'string' ? value : value?.message || '';
const named = value => typeof value === 'string' ? value : value?.name || '';
function state(value) {
  if (['running', 'started', 'in_progress'].includes(value)) return 'running';
  if (['complete', 'completed', 'success', 'succeeded'].includes(value)) return 'complete';
  if (['failed', 'error'].includes(value)) return 'failed';
  if (['pending', 'queued'].includes(value)) return 'pending';
  return 'recorded';
}
function millis(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}
function time(value) {
  const n = millis(value);
  return n === null ? null : new Date(n).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function json(value) {
  if (typeof value === 'string') return value;
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_, v) => {
      if (typeof v === 'bigint') return String(v);
      if (v && typeof v === 'object') { if (seen.has(v)) return '[순환 참조]'; seen.add(v); }
      return v;
    }, 2) ?? '기록 없음';
  } catch { return '출력을 표시할 수 없습니다.'; }
}

/** Merge streamed tool events with saved steps without inventing planned actions. */
export function normalizeAgentTrace(steps = [], events = []) {
  const rows = [], byId = new Map();
  let sequence = 0;
  function add(row) { row.order = sequence++; rows.push(row); if (row.stepId) byId.set(row.stepId, row); return row; }
  for (const source of Array.isArray(events) ? events : []) {
    if (!source || typeof source !== 'object') continue;
    if (source.type === 'response.delta') continue;
    const detail = { ...asObject(source.data), ...asObject(source.step), ...source };
    const type = eventType(source) || detail.type;
    const at = detail.timestamp ?? detail.at ?? detail.createdAt;
    if (['tool_started', 'tool_completed', 'tool_failed'].includes(type)) {
      const name = named(detail.name || detail.tool || detail.toolName);
      const id = detail.stepId || detail.toolCallId || detail.callId || source.step?.id || detail.id;
      let row = id ? byId.get(id) : null;
      if (!row && type !== 'tool_started') row = [...rows].reverse().find(r => r.kind === 'tool' && r.name === name && r.status === 'running' && (!id || !r.stepId));
      if (!row) row = add({ kind: 'tool', key: `event-${sequence}`, stepId: id, name, status: 'recorded', at });
      if (!row.stepId && id) { row.stepId = id; byId.set(id, row); }
      if (name) row.name = name;
      if (own(detail, 'input')) row.input = detail.input;
      else if (own(detail, 'inputSummary')) { row.input = detail.inputSummary; row.inputIsSummary = true; }
      else if (own(detail, 'arguments')) row.input = detail.arguments;
      else if (own(detail, 'args')) row.input = detail.args;
      if (own(detail, 'output')) row.output = detail.output;
      else if (own(detail, 'result')) row.output = detail.result;
      if (own(detail, 'error')) row.error = textValue(detail.error) || json(detail.error);
      row.status = type === 'tool_started' ? 'running' : type === 'tool_failed' ? 'failed' : 'complete';
      if (detail.startedAt || type === 'tool_started') row.startedAt = detail.startedAt ?? at;
      if (type !== 'tool_started') row.finishedAt = detail.finishedAt ?? at;
    } else {
      add({ kind: 'event', key: `event-${sequence}`, type: type || 'event', name: source.type === 'model.awaiting' ? `${detail.round || 1}번째 모델 응답 대기 · 프로젝트 맥락 확인` : source.type === 'response.completed' && source.committed === true ? '요청 저장 완료' : EVENT_LABELS[type] || named(detail.name) || '실행 이벤트', at,
        status: type === 'run_failed' ? 'failed' : type === 'run_completed' ? 'complete' : type === 'run_started' || type === 'model_started' ? 'running' : state(detail.status),
        context: source.type === 'model.awaiting' ? { inputRevision: detail.inputRevision, historyMessages: detail.historyMessages, availableTools: detail.availableTools, selectedImages: detail.selectedImages } : null,
        error: own(detail, 'error') ? textValue(detail.error) || json(detail.error) : undefined });
    }
  }
  const terminalSteps = (Array.isArray(events) ? events : []).filter(event => eventType(event) === 'run_completed' && event?.committed === true).flatMap(event => Array.isArray(event.data?.steps) ? event.data.steps : []);
  for (const source of [...terminalSteps, ...(Array.isArray(steps) ? steps : [])]) {
    if (!source || typeof source !== 'object') continue;
    const name = named(source.name || source.tool || source.toolName), id = source.stepId || source.id || source.callId;
    let row = id ? byId.get(id) : null;
    if (!row && source.startedAt) row = rows.find(r => r.kind === 'tool' && r.name === name && r.startedAt === source.startedAt);
    if (!row) row = add({ kind: 'tool', key: `step-${sequence}`, stepId: id, name, status: 'recorded', at: source.startedAt ?? source.createdAt });
    if (name) row.name = name;
    if (own(source, 'status')) row.status = state(source.status);
    for (const k of ['input', 'output', 'startedAt', 'finishedAt']) if (own(source, k)) row[k] = source[k];
    if (own(source, 'input')) row.inputIsSummary = false;
    if (!own(source, 'input') && own(source, 'arguments')) row.input = source.arguments;
    if (!own(source, 'output') && own(source, 'result')) row.output = source.result;
    if (own(source, 'error')) row.error = textValue(source.error) || json(source.error);
  }
  return rows.sort((a, b) => {
    const at = millis(a.startedAt ?? a.at), bt = millis(b.startedAt ?? b.at);
    return at !== null && bt !== null ? at - bt || a.order - b.order : a.order - b.order;
  });
}

function StateMark({ status }) {
  const Icon = status === 'complete' ? Check : status === 'failed' ? TriangleAlert : status === 'running' ? LoaderCircle : Circle;
  return <Icon size={14} className={`agent-state-mark ${status}`} aria-hidden="true" />;
}
function TraceStep({ row, index, rolledBack }) {
  const start = time(row.startedAt ?? row.at), end = time(row.finishedAt);
  const duration = millis(row.finishedAt) !== null && millis(row.startedAt) !== null ? millis(row.finishedAt) - millis(row.startedAt) : null;
  if (row.kind === 'event') return <li className={`agent-event-line ${row.status}`}><StateMark status={row.status} /><span>{row.name}</span>{time(row.at) && <time>{time(row.at)}</time>}{row.context && <p>입력 r{row.context.inputRevision ?? '—'} · 동의된 이전 대화 {row.context.historyMessages ?? 0}건 · 허용 도구 {row.context.availableTools ?? 8}개 · 선택 사진 {row.context.selectedImages ?? 0}장</p>}{row.error && <p>{row.error}</p>}</li>;
  return <li className="agent-trace-item"><details open={row.status === 'running' || row.status === 'failed'}><summary><StateMark status={row.status} /><span className="agent-tool-heading"><strong>{TOOL_LABELS[row.name] || row.name || `도구 기록 ${index + 1}`}</strong>{row.name && <code>{row.name}</code>}</span><span className={`agent-run-badge ${rolledBack && row.status === 'complete' ? 'unconfirmed' : row.status}`}>{rolledBack && row.status === 'complete' ? '실행됨 · 미저장' : statusText[row.status] || '기록'}</span><ChevronDown size={13} /></summary><div className="agent-trace-detail">
    <div className="agent-step-time">{start ? <span>시작 {start}</span> : <span>시작 시각 미기록</span>}{end && <span>종료 {end}</span>}{duration !== null && duration >= 0 && <span>{duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}초`}</span>}</div>
    <div className="agent-payload"><h4>{row.inputIsSummary ? '입력 요약' : '입력'}</h4><pre>{own(row, 'input') ? json(row.input) : '입력이 기록되지 않았습니다.'}</pre></div>
    {row.error && <div className="agent-trace-error" role="alert"><TriangleAlert size={14} /><span>{row.error}</span></div>}
    <div className="agent-payload"><h4>출력</h4><pre>{own(row, 'output') ? json(row.output) : row.status === 'running' ? '도구 응답 대기 중' : '출력이 기록되지 않았습니다.'}</pre></div>
  </div></details></li>;
}

export function AgentRunTrace({ steps = [], events = [], active = false, error = null, mode = 'local', modelContext = null, modelActivity = [] }) {
  const rows = normalizeAgentTrace(steps, events);
  if (!rows.length && !active && !error && !modelContext) return null;
  const failed = Boolean(error) || rows.some(r => r.status === 'failed');
  const finished = rows.some(r => r.type === 'run_completed') || (rows.some(r => r.kind === 'tool') && rows.filter(r => r.kind === 'tool').every(r => r.status === 'complete'));
  const status = active ? 'running' : failed ? 'failed' : finished || modelContext ? 'complete' : 'recorded';
  const terminals = (Array.isArray(events) ? events : []).filter(event => ['run_failed', 'run_completed'].includes(eventType(event)));
  const terminal = terminals.at(-1);
  const rolledBack = terminal?.committed === false || error?.committed === false;
  const unknownCommit = error?.code === 'STREAM_INTERRUPTED' || (own(error, 'committed') && error.committed === null);
  return <section className="agent-run-trace" aria-label="에이전트 실행 기록" aria-busy={active}><header><span><Activity size={15} />실행 맥락 · 도구</span><span className={`agent-run-badge ${unknownCommit ? 'unconfirmed' : status}`}>{unknownCommit ? '저장 여부 미확인' : rolledBack ? '실패 · 미저장' : statusText[status]}</span></header><div className="agent-trace-context"><span>{['local', 'local-direct'].includes(mode) ? '로컬 도구 모드' : '모델 · 도구 모드'}</span><span>{rows.filter(r => r.kind === 'tool').length}개 도구 기록</span></div>
    {modelContext && <div className="agent-model-context">입력 r{modelContext.inputRevision ?? '—'} · 동의된 이전 대화 {modelContext.historyMessages ?? 0}건 · 허용 도구 {modelContext.availableTools ?? 8}개 · 선택 사진 {modelContext.selectedImages ?? 0}장</div>}
    {!['local', 'local-direct'].includes(mode) && <p className="agent-reasoning-note">공개된 모델 메시지와 실제 도구 실행만 표시합니다. 비공개 추론 원문은 제공되지 않습니다.</p>}
    {(Array.isArray(modelActivity) ? modelActivity : []).filter(item => Array.isArray(item?.toolNames) && item.toolNames.length && typeof item.text === 'string').map((item, index) => <details className="agent-interim-record" key={`${item.round}-${index}`}><summary>{item.round}번째 모델 중간 메시지 · {item.toolNames.join(', ')}</summary><MarkdownBody text={item.text} /></details>)}
    {rolledBack && <p className="agent-commit-note">이번 요청의 도구 실행과 변경 저장은 다릅니다. 트랜잭션이 실패하여 변경 사항은 저장되지 않았습니다.</p>}
    {unknownCommit && <p className="agent-commit-note">연결이 중단되어 변경 저장 여부를 확인할 수 없습니다. 프로젝트 상태를 새로 확인하세요. 자동으로 재실행하지 않습니다.</p>}
    {rows.length ? <ol className="agent-trace-list">{rows.map((row, i) => <TraceStep key={row.key} row={row} index={i} rolledBack={rolledBack} />)}</ol> : <p className="agent-trace-empty">{active ? '요청 처리 중입니다. 아직 도구 실행 기록이 수신되지 않았습니다.' : '기록된 도구 실행이 없습니다.'}</p>}
    {error && <div className="agent-trace-error" role="alert"><TriangleAlert size={15} /><span>{textValue(error) || json(error)}</span></div>}
  </section>;
}

export function agentToolCatalog() {
  const presentation = {
    get_project: { icon: FileText, note: '목표·공간·실험·승인 상태를 조회합니다.' },
    analyze_area: { icon: MapPin, note: '로컬 OSM 위치와 직선거리를 계산합니다. 유동인구·매출 추정이 아닙니다.' },
    propose_space: { icon: Box, note: '전송 전 예시 수치를 실제 조건으로 수정하세요. 공간 변경은 치수 재확인을 요구하고 기존 비교·승인을 무효화합니다.' },
    update_assumptions: { icon: Users, note: '실험 조건 화면에서 명시적으로 변경할 수 있습니다. 변경 시 기존 비교·승인은 무효화됩니다.' },
    generate_candidates: { icon: Layers, note: '실측 치수가 확인된 공간으로 16개 후보를 생성합니다.' },
    run_simulation: { icon: FlaskConical, note: '저장된 후보를 동일한 조건으로 계산합니다. 실제 행동 예측이 아닙니다.' },
    build_crm: { icon: Database, note: '오너가 승인한 안으로 CRM 구조를 만듭니다. 배포·외부 발송은 하지 않습니다.' },
    review_operations: { icon: ClipboardList, prompt: '운영 현황 조회', note: '오너 입력 관측·자기신고 완전성, 업무와 규칙 기반 변경 가설 상태를 읽기 전용으로 조회합니다. 새 가설은 생성하지 않습니다.' },
  };
  const permissions = { read: '조회', write: '프로젝트 변경', 'approved-write': '승인 후 생성' };
  return agentBlueprint.tools.map(tool => ({ ...tool, ...presentation[tool.name], permission: permissions[tool.access] || tool.access }));
}

/** A preserved local deployment is not necessarily the currently approved design. */
export function deploymentRelation(project = {}) {
  const deployment = project.crm?.deployment;
  if (!deployment) return { exists: false, current: false, label: '배포 전', detail: '배포 기록 없음' };
  const approval = project.approval, schema = project.crm?.schema;
  const current = Boolean(
    approval?.id && schema?.id &&
    deployment.inputRevision === project.inputRevision &&
    deployment.candidateId === project.selectedId &&
    deployment.approvalId === approval.id &&
    approval.candidateId === project.selectedId &&
    schema.approvalId === approval.id &&
    deployment.schema?.id === schema.id
  );
  return {
    exists: true,
    current,
    label: current ? '현재 승인안 로컬 운영 중' : '이전 승인안 로컬 운영 중',
    detail: current
      ? `배포 ${deployment.candidateId}안 · 입력 r${deployment.inputRevision}`
      : `기존 배포 ${deployment.candidateId || '—'}안 · 입력 r${deployment.inputRevision ?? '—'} 보존 · 현재 설계 재검토 필요`,
  };
}

export function agentLifecycle(project = {}) {
  const revision = project.inputRevision;
  const current = record => Boolean(record) && record.inputRevision === revision && revision != null;
  const summary = (record, empty, ready) => !record ? { status: 'pending', detail: empty } : current(record) ? { status: 'complete', detail: ready } : { status: 'unconfirmed', detail: '기존 기록 · 현재 입력과 다름' };
  const candidates = Array.isArray(project.candidates) ? project.candidates.length : 0;
  const deployment = deploymentRelation(project);
  return [
    { id: 'research', label: '주변 근거', ...summary(project.research, '분석 전', '현재 입력 분석됨') },
    { id: 'space', label: project.demo?.synthetic ? '예시 공간 기준' : '실측 치수', status: project.space?.confirmed ? 'complete' : 'unconfirmed', detail: project.space?.confirmed ? project.demo?.synthetic ? '합성 조건 준비됨' : '오너 확인됨' : '오너 확인 필요' },
    { id: 'candidates', label: '후보 공간', status: candidates ? 'complete' : 'pending', detail: candidates ? `${candidates}개 생성됨` : '후보 없음' },
    { id: 'simulation', label: '비교 실험', ...summary(project.simulation, '실험 전', `${project.simulation?.results?.length || 0}개 결과 저장됨`) },
    { id: 'approval', label: '선택안 승인', ...summary(project.approval, '오너 승인 전', `${project.approval?.candidateId || '선택안'} 승인됨`) },
    { id: 'crm', label: 'CRM 구조', ...summary(project.crm?.schema, '빌드 전', '승인안 구조 생성됨') },
    { id: 'deployment', label: 'CRM 운영', status: !deployment.exists ? 'pending' : deployment.current ? 'complete' : 'unconfirmed', detail: deployment.detail },
  ];
}

function RuntimeSummary({ health, runtime }) {
  const info = asObject(runtime || health?.runtime), execution = asObject(info.execution);
  const path = execution.mode || info.mode || info.kind || 'local-direct';
  const provider = asObject(info.inference || info.provider), shell = asObject(info.sandbox || info.openShell || info.openshell);
  const configured = health?.modelConfigured === true || provider.configured === true;
  const verified = provider.verified === true;
  const blueprint = info.blueprint, policy = info.policy, hooks = info.hooks || info.contextHook;
  const label = value => typeof value === 'string' ? value : value?.name || value?.id || value?.status || '정보 없음';
  return <section className="agent-console-section agent-runtime"><h3><Terminal size={15} />실행 환경</h3><dl>
    <div><dt>실행 경로</dt><dd>{path === 'local-direct' || path === 'local' ? '로컬 직접 실행' : path === 'nemoclaw-openshell' ? 'NemoClaw 샌드박스' : String(path)}<small>{shell.name || (path === 'local-direct' || path === 'local' ? 'local-direct' : '서버 보고값')}</small></dd></div>
    <div><dt>OpenShell</dt><dd className={shell.status === 'process-confirmed' ? 'agent-confirmed' : 'agent-unconfirmed'}>{shell.status === 'process-confirmed' ? '샌드박스 프로세스 확인' : shell.connected === true ? '연결 보고됨 · 격리 미검증' : '미연결'}</dd></div>
    <div><dt>모델 제공자</dt><dd className={verified ? 'agent-confirmed' : 'agent-unconfirmed'}>{verified ? '호출 확인됨' : provider.lastCheck?.status === 'failed' ? '실제 호출 실패' : configured ? '키 설정됨 · 호출 미검증' : health?.modelConfigured === false || provider.configured === false ? 'API 키 미설정' : '설정 상태 미확인'}{provider.provider && <small>{provider.provider}</small>}{(provider.model || health?.model) && <small>{provider.model || health.model}</small>}{provider.lastCheck?.code && <small>{provider.lastCheck.code}</small>}</dd></div>
  </dl><p className="agent-runtime-note">{shell.status === 'process-confirmed' ? 'NemoClaw 인스턴스에서 실행 중입니다. 모델 호출과 도구 실행 기록을 대화에서 확인할 수 있습니다.' : '로컬 직접 실행은 격리된 샌드박스가 아닙니다. 모델 요청은 대화창에서 명시적으로 선택합니다.'}</p>
    <details className="agent-runtime-detail"><summary>구성 · 정책 · 실행 훅<ChevronDown size={13} /></summary><dl><div><dt>Blueprint</dt><dd>{blueprint ? label(blueprint) : '연결 정보 없음'}{blueprint?.version && <small>v{blueprint.version}</small>}</dd></div><div><dt>Policy</dt><dd>{Array.isArray(policy?.ownerOnly) ? `오너 전용 ${policy.ownerOnly.length}개 작업` : policy ? label(policy) : '별도 정책 연결 정보 없음'}{policy?.arbitraryShell === false && <small>임의 셸 도구 금지</small>}{policy?.arbitraryNetwork === false && <small>임의 네트워크 도구 금지</small>}</dd></div><div><dt>Hooks</dt><dd>{Array.isArray(hooks) ? hooks.length ? hooks.map(label).join(' · ') : '등록 없음' : hooks ? label(hooks) : '등록 정보 없음'}</dd></div>{info.upstream?.module && <div><dt>참고 모듈</dt><dd>{info.upstream.module}{info.upstream.integration && <small>{info.upstream.integration}</small>}</dd></div>}{info.limits && <div><dt>실행 한도</dt><dd>{info.limits.rounds != null && <span>모델 {info.limits.rounds}회</span>}{info.limits.toolCalls != null && <small>도구 {info.limits.toolCalls}회</small>}</dd></div>}</dl><p>선택안 승인·CRM 배포·외부 발송은 자동 도구 실행에 포함되지 않습니다. 애플리케이션의 도구 허용목록은 OS·네트워크 격리를 뜻하지 않습니다.</p></details>
  </section>;
}

export function AgentInspector({ project = {}, health, pending, navigate, onPrompt, events = [], runtime }) {
  const lifecycle = agentLifecycle(project), tools = agentToolCatalog(project);
  const latest = Array.isArray(events) ? events.at(-1) : null;
  const latestType = eventType(latest);
  const eventStatus = pending ? 'running' : latestType === 'run_failed' ? 'failed' : latestType === 'run_completed' ? 'complete' : 'recorded';
  const canReview = Boolean(project.simulation) && !project.approval;
  return <aside className="agent-inspector" aria-label="에이전트 제어 패널"><header className="agent-inspector-header"><span><Bot size={18} /><strong>AGENT CONTROL</strong></span><span className={`agent-run-badge ${eventStatus}`}>{pending ? latestType === 'model_started' ? '모델 응답 대기' : '실행 중' : latest ? statusText[eventStatus] : '대기'}</span></header>
    <section className="agent-console-section"><h3><Activity size={15} />프로젝트 준비 상태</h3><ol className="agent-lifecycle">{lifecycle.map(item => <li key={item.id}><StateMark status={item.status} /><span>{item.label}</span><small className={item.status === 'unconfirmed' ? 'agent-unconfirmed' : ''}>{item.detail}</small></li>)}</ol>{canReview && <button type="button" className="agent-review-button" disabled={!!pending || typeof navigate !== 'function'} onClick={() => navigate?.('compare')}><ShieldCheck size={15} />승인 검토<ArrowUpRight size={14} /></button>}</section>
    <section className="agent-console-section agent-tool-catalog"><h3><Layers size={15} />사용 가능한 도구<span>{tools.length}</span></h3><p>요청 문구만 채우거나 입력 화면을 엽니다. 도구는 자동 실행하지 않습니다.</p><div>{tools.map(tool => <details key={tool.name}><summary><tool.icon size={14} /><span>{tool.label}</span><small>{tool.permission}</small><ChevronDown size={12} /></summary><div><code>{tool.name}</code><p>{tool.note}</p>{tool.prompt ? <button type="button" disabled={!!pending || typeof onPrompt !== 'function'} onClick={() => onPrompt?.(tool.prompt)}>{tool.prompt}<ArrowUpRight size={13} /></button> : <button type="button" disabled={!!pending || typeof navigate !== 'function'} onClick={() => navigate?.('space')}>실험 조건에서 편집<ArrowUpRight size={13} /></button>}</div></details>)}</div></section>
    <RuntimeSummary health={health} runtime={runtime} />
  </aside>;
}
