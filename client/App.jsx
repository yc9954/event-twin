import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Box, Users, Plus, ChevronRight, ChevronDown, Check, ArrowUp, ArrowUpRight, Play, Pause, Settings2, RefreshCw, Download, MapPin, SlidersHorizontal, Layers, ImagePlus, Upload, X, Search, CircleCheck, AlertTriangle, ShieldCheck, Database, Activity, FlaskConical, Sparkles, ClipboardList, Pin, Menu, CheckCheck, Clock, ExternalLink, Bot, FileText } from 'lucide-react';
import { api, parsePeopleCSV } from './api.js';
import Scene from './Scene.jsx';
import ScenePlayer from './ScenePlayer.jsx';
import MarkdownBody from './MarkdownBody.jsx';
import DemoRecorder from './DemoRecorder.jsx';
import MarketMap from './MarketMap.jsx';
import IntegrationSettings from './IntegrationSettings.jsx';
import { AgentInspector, AgentRunTrace, deploymentRelation } from './AgentConsole.jsx';
import { natAuditView } from './nat-audit-view.mjs';
import './brief-layout.css';
import './agent-workspace.css';
import './scene-playback.css';

const fmt = (n, digits = 0) => Number.isFinite(Number(n)) ? Number(n).toLocaleString('ko-KR', { maximumFractionDigits: digits }) : '—';
const won = n => `${fmt(n)}원`;
const date = value => value ? new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const localDateTime = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23); };
export function initialObservationWindow(deployment, nowMs = Date.now()) {
  const appliedAt = Date.parse(deployment?.appliedAt || '');
  return {
    windowStart: localDateTime(Math.max(nowMs - 60 * 60 * 1000, Number.isFinite(appliedAt) ? appliedAt : -Infinity)),
    windowEnd: localDateTime(nowMs),
  };
}
const statusNames = { registered: '등록', checked_in: '체크인', waiting: '대기', active: '체험 중', completed: '완료' };
const familyNames = { gallery: '갤러리', courtyard: '중정형', forum: '복층 포럼', festival: '야외 페스티벌' };
const workspaces = [
  { id: 'brief', name: 'Business Brief', sub: '에이전트 · 목표 · 상권', icon: MessageSquare, sections: [{ id: 'chat', label: '에이전트와 계획' }, { id: 'market', label: '주변 상권 · 리서치' }] },
  { id: 'design', name: '설계·실험', sub: '공간 · 여러 안 · 의사결정', icon: Box, sections: [{ id: 'space', label: '공간과 실험 조건' }, { id: 'compare', label: '16개 안 비교' }] },
  { id: 'crm', name: '운영·CRM', sub: '구축 · 참가자 · 개선 루프', icon: Users, sections: [{ id: 'build', label: 'CRM 빌드 · 배포' }, { id: 'people', label: '참가자 · 현장 운영' }, { id: 'performance', label: '성과 · 개선 가설' }] },
];

function Button({ children, icon: Icon, primary, quiet, danger, className = '', ...props }) {
  return <button {...props} className={`btn ${primary ? 'primary' : ''} ${quiet ? 'quiet' : ''} ${danger ? 'danger' : ''} ${className}`}>{Icon && <Icon size={15} />}<span>{children}</span></button>;
}
function Badge({ children, tone = '' }) { return <span className={`badge ${tone}`}>{children}</span>; }
function Empty({ icon: Icon = Database, title, children, action }) { return <div className="empty"><Icon size={28} strokeWidth={1.3} /><h3>{title}</h3><p>{children}</p>{action}</div>; }
function Panel({ title, eyebrow, action, children, className = '' }) { return <section className={`panel ${className}`}><header className="panel-head"><div>{eyebrow && <small className="eyebrow">{eyebrow}</small>}<h2>{title}</h2></div>{action}</header>{children}</section>; }
function Stat({ label, value, foot }) { return <div className="stat"><span>{label}</span><strong>{value}</strong>{foot && <small>{foot}</small>}</div>; }
function Modal({ title, onClose, children, wide, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><header><h2>{title}</h2><button className="icon-btn" aria-label="닫기" onClick={onClose}><X size={20} /></button></header>{children}</dialog>;
}
function Field({ label, help, children, className = '' }) { return <label className={`field ${className}`}><span>{label}</span>{children}{help && <small>{help}</small>}</label>; }
function Numeric({ label, name, values, setValues, min = 0, max, help }) {
  const integer = ['booths', 'staff', 'variant', 'visitors', 'durationMinutes', 'budget', 'minConsent', 'seed', 'replications', 'completed', 'consents', 'cost'].includes(name);
  return <Field label={label} help={help}><input required type="number" name={name} min={min} max={max} step={integer ? 1 : 'any'} value={values[name] ?? ''} onChange={e => setValues(s => ({ ...s, [name]: e.target.value }))} /></Field>;
}
export default function App() {
  const [projects, setProjects] = useState([]), [project, setProject] = useState(null), [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(''), [notice, setNotice] = useState(null);
  const [section, setSection] = useState('chat'), [modal, setModal] = useState(null), [sidebar, setSidebar] = useState(false);
  const [mobileNav, setMobileNav] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const projectRef = useRef(null), busy = useRef(false), loadToken = useRef(0);
  const menuButtonRef = useRef(null), sidebarRef = useRef(null), openedMobileNav = useRef(false);
  const workspace = workspaces.find(w => w.sections.some(s => s.id === section));
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => { setMobileNav(query.matches); if (!query.matches) setSidebar(false); };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobileNav) { openedMobileNav.current = false; return; }
    if (sidebar) {
      openedMobileNav.current = true;
      sidebarRef.current?.querySelector('select:not(:disabled), nav button:not(:disabled), .sidebar-bottom button:not(:disabled)')?.focus();
    } else if (openedMobileNav.current) {
      openedMobileNav.current = false;
      menuButtonRef.current?.focus();
    }
  }, [mobileNav, sidebar]);
  const accept = p => { projectRef.current = p; setProject(p); if (p?.id) localStorage.setItem('event-twin-project', p.id); };
  const refreshList = async () => { const data = await api.projects(); setProjects(data.projects); };
  async function load(id) {
    const token = ++loadToken.current;
    setLoading(true);
    try { const { project: p } = await api.project(id); if (loadToken.current === token) accept(p); }
    catch (err) { if (loadToken.current === token) setNotice({ error: true, text: err.message }); }
    finally { if (loadToken.current === token) setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [h, list] = await Promise.all([api.health(), api.projects()]);
        if (!active) return;
        setHealth(h); setProjects(list.projects);
        const saved = localStorage.getItem('event-twin-project');
        const id = list.projects.find(p => p.id === saved)?.id || list.projects[0]?.id;
        if (id) { const { project: p } = await api.project(id); if (active) accept(p); }
      } catch (err) { if (active) setNotice({ error: true, text: err.message }); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);
  async function mutate(label, action, success = '') {
    if (busy.current) return null;
    busy.current = true; setPending(label); setNotice(null);
    try {
      const data = await action(projectRef.current);
      if (data.project) accept(data.project);
      if (success) setNotice({ text: success });
      await refreshList().catch(() => {});
      return data;
    } catch (err) {
      if (err.code === 'MODEL_CONNECTION_CHANGED') {
        try { setHealth(await api.health()); } catch {}
      }
      if (err.status === 409 && err.code === 'VERSION_CONFLICT' && projectRef.current) {
        try { const data = await api.project(projectRef.current.id); accept(data.project); } catch {}
        setNotice({ error: true, text: '다른 창 또는 개선 루프가 데이터를 변경했습니다. 최신 상태를 불러왔습니다. 변경 내용을 확인하고 다시 실행해 주세요.' });
      } else setNotice({ error: true, text: err.status === 429 && err.code?.startsWith('MODEL_') ? `모델 API 크레딧 또는 요청 한도 문제입니다. 로컬 도구 모드를 이용하거나 API 계정을 확인해 주세요. ${err.message}` : err.message });
      return null;
    } finally { busy.current = false; setPending(''); }
  }
  const act = (type, payload = {}, message = '') => mutate(type, p => api.action(p.id, type, payload, p.version), message);
  const navigate = next => { setSection(next); setSidebar(false); };
  async function create(e) { e.preventDefault(); const name = new FormData(e.currentTarget).get('name'); const data = await mutate('프로젝트 만들기', () => api.create(name), '새 프로젝트가 생성되었습니다.'); if (data) { setModal(null); navigate('chat'); } }
  async function upload(file) {
    if (!file) return null;
    const maxBytes = health?.access?.uploadImageMaxBytes || 5 * 1024 * 1024;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > maxBytes) { setNotice({ error: true, text: `${maxBytes / 1024 / 1024}MB 이하 PNG, JPEG, WebP 파일만 업로드할 수 있습니다.` }); return null; }
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => null);
    if (!data) { setNotice({ error: true, text: '사진 파일을 읽지 못했습니다.' }); return null; }
    return mutate('사진 업로드', p => api.upload(p.id, { name: file.name, mime: file.type, data }, p.version), '사진을 로컬에 저장했습니다. 모델 전송은 별도 선택이 필요합니다.');
  }
  const refreshMap = values => mutate('실제 지도 시설 갱신', p => api.refreshMap(p.id, values, p.version), '실제 OSM 시설을 조회하고 수집 시점과 함께 저장했습니다.');
  const context = { project, act, pending, navigate, upload, setNotice, refreshMap, uploadMaxMB: (health?.access?.uploadImageMaxBytes || 5 * 1024 * 1024) / 1024 / 1024 };
  return <div className="app-shell">
    <aside id="workspace-sidebar" ref={sidebarRef} className={`sidebar ${sidebar ? 'open' : ''}`} inert={mobileNav && !sidebar} aria-hidden={mobileNav && !sidebar ? true : undefined} onKeyDown={e => { if (mobileNav && e.key === 'Escape') setSidebar(false); }}>
      <div className="brand"><span className="brand-mark"><i /><i /><i /></span><div>EVENT TWIN<small>OFFLINE EXPERIENCE OS</small></div></div>
      <div className="project-picker"><label htmlFor="project-picker">프로젝트</label><div><select id="project-picker" aria-label="프로젝트 선택" value={project?.id || ''} disabled={!!pending || loading} onChange={e => load(e.target.value)}><option value="" disabled>프로젝트 선택</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className="icon-btn" aria-label="프로젝트 만들기" disabled={!!pending} onClick={() => setModal('create')}><Plus size={17} /></button></div></div>
      <div className="tabs-label"><span>WORKSPACES</span><span>3 / 3</span></div>
      <nav aria-label="워크스페이스">{workspaces.map(w => <div key={w.id} className={`workspace-nav ${workspace.id === w.id ? 'active' : ''}`}><button onClick={() => navigate(w.sections[0].id)}><w.icon size={20} strokeWidth={1.6} /><span><strong>{w.name}</strong><small>{w.sub}</small></span><Pin size={12} className={w.id === 'brief' ? 'pinned' : ''} /></button>{workspace.id === w.id && <div className="subnav">{w.sections.map(s => <button className={section === s.id ? 'selected' : ''} key={s.id} onClick={() => navigate(s.id)}><i />{s.label}</button>)}</div>}</div>)}</nav>
      <div className="sidebar-bottom">{!health?.access && <DemoRecorder />}<div className="save-state"><i /> {health?.runtime?.sandbox?.connected ? 'NEMOCLAW PILOT' : 'LOCAL PILOT'} <span>SQLite</span></div><button onClick={() => setModal('audit')} disabled={!project}><ClipboardList size={16} /> 변경 기록 <span>{project?.audit?.length || 0}</span></button>{project && <a href={`/api/projects/${project.id}/export`} download><Download size={16} /> 프로젝트 내보내기</a>}<button onClick={() => setModal('settings')}><Settings2 size={16} /> 모델 · 연결 설정</button>{health?.access?.authenticated && <form method="post" action="/api/auth/logout"><button type="submit"><ShieldCheck size={16} /> 로그아웃</button></form>}<div className="owner"><span>ET</span><div>Event Twin<small>{health?.access?.mode==='public-demo'?'심사 체험 워크스페이스':'오너 전용 워크스페이스'}</small></div><ShieldCheck size={17} /></div></div>
    </aside>
    {sidebar && <button className="sidebar-shade" aria-label="메뉴 닫기" onClick={() => setSidebar(false)} />}
    <div className="main-shell"><header className="green-header"><div><button ref={menuButtonRef} className="icon-btn mobile-menu" onClick={() => setSidebar(s => !s)} aria-label="메뉴" aria-controls="workspace-sidebar" aria-expanded={mobileNav && sidebar}><Menu size={19} /></button><span>Event Twin Agent Workspace</span></div><div className="header-status"><span className={`connection-dot ${health ? '' : 'offline'}`} />{health?.modelConfigured ? `API 키 설정됨 · ${health.model}` : '로컬 도구 모드'}<button className="icon-btn" aria-label="모델 연결 설정" onClick={() => setModal('settings')}><Settings2 size={17} /></button></div></header>
      <div className="breadcrumb"><span><workspace.icon size={15} />{workspace.name}<ChevronRight size={13} />{workspace.sections.find(s => s.id === section)?.label}</span><span>{project?.name || '시작하기'}{project && <Badge>r{project.inputRevision} · v{project.version}</Badge>}<button className="icon-btn" title="서버에서 새로고침" aria-label="프로젝트 새로고침" disabled={!project || !!pending || loading} onClick={() => load(project.id)}><RefreshCw size={14} /></button></span></div>
      {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <AlertTriangle size={17} /> : <CircleCheck size={17} />}<span>{notice.text}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
      {health?.access?.mode==='public-demo' && <div className="demo-banner"><span>PUBLIC DEMO</span> 로그인 없이 전체 흐름 체험 · 브라우저별 작업 분리 · 실제 고객 개인정보는 입력하지 마세요. 쿠키 만료 후에는 내보낸 기록을 보관하세요.</div>}
      {pending && <div className="pending-bar" role="status"><span /> 저장 · 실행 중… <small>{pending}</small></div>}
      <main className="workspace-content" aria-busy={!!pending || loading}>
        {loading ? <Empty icon={RefreshCw} title="프로젝트를 불러오는 중" /> : !project ? <div className="welcome"><div className="eyebrow">PLAN · EXPERIMENT · OPERATE</div><h1>행사를 시작하기 전에,<br />가능성을 먼저 검증하세요.</h1><p>공간을 이해하고, 16개 안을 비교하고,<br />선택한 설계를 실제 운영 CRM으로 연결합니다.</p><Button primary icon={Plus} onClick={() => setModal('create')}>첫 프로젝트 만들기</Button><div className="welcome-flow"><span><MessageSquare /> Business Brief</span><ChevronRight /><span><Box /> 설계·실험</span><ChevronRight /><span><Users /> 운영·CRM</span></div></div> : <React.Fragment key={project.id}>
          {section === 'chat' && <Brief {...context} health={health} mutate={mutate} />}
          {section === 'market' && <Market {...context} />}
          {section === 'space' && <Space {...context} />}
          {section === 'compare' && <Compare {...context} />}
          {section === 'build' && <BuildCRM {...context} />}
          {section === 'people' && <People {...context} />}
          {section === 'performance' && <Performance {...context} />}
        </React.Fragment>}
      </main>
    </div>
    {modal === 'create' && <Modal title="새 행사 프로젝트" onClose={() => !pending && setModal(null)}><form onSubmit={create}><Field label="프로젝트 이름"><input name="name" placeholder="예: 성수 브랜드 경험 행사" required maxLength={120} autoFocus /></Field><p className="help">참가자·관측 데이터 없이 빈 프로젝트로 시작합니다. 초기 수치는 변경 가능한 실험 가정입니다.</p><div className="form-actions"><Button disabled={!!pending} primary icon={Plus}>프로젝트 만들기</Button></div></form></Modal>}
    {modal === 'settings' && <Modal title="모델 · 연결 설정" onClose={() => setModal(null)}><IntegrationSettings health={health} onHealth={setHealth} /></Modal>}
    {modal === 'audit' && <Modal title="변경 기록" wide onClose={() => setModal(null)}><div className="audit-list">{project?.audit?.length ? [...project.audit].reverse().map((item, i) => <details key={item.id || i}><summary><Activity size={14} /><strong>{item.type || item.action || '기록'}</strong><span>{date(item.createdAt || item.at || item.timestamp)}</span></summary><pre>{JSON.stringify(item, null, 2)}</pre></details>) : <Empty title="아직 변경 기록이 없습니다." />}</div></Modal>}
  </div>;
}

function PageHeading({ eyebrow, title, children, action }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{children}</p></div>{action}</div>; }

export function Brief({ project, act, pending, navigate, health, mutate, upload, refreshMap }) {
  const [draft, setDraft] = useState(''), [useModel, setUseModel] = useState(false), [imageIds, setImageIds] = useState([]), [imageConsent, setImageConsent] = useState(false), [showGoal, setShowGoal] = useState(false), [artifactView, setArtifactView] = useState('control');
  const [runEvents, setRunEvents] = useState([]), [streamedRounds, setStreamedRounds] = useState({}), [submitted, setSubmitted] = useState(''), [runFailed, setRunFailed] = useState(false), [runIssue, setRunIssue] = useState(null);
  const fileInput = useRef(), bottom = useRef(), followOutput = useRef(true);
  const supportsImages = health?.provider?.supportsImages !== false;
  useEffect(() => {setUseModel(false);setImageIds([]);setImageConsent(false);},[health?.provider?.connectionId]);
  const running = pending === '에이전트 실행';
  useEffect(() => { const history = bottom.current?.parentElement; if (followOutput.current) history?.scrollTo({ top: history.scrollHeight }); }, [project.messages.length, runEvents.length, streamedRounds, submitted]);
  async function send(e) {
    e?.preventDefault(); if (!draft.trim() || pending) return;
    if (useModel && imageIds.length > 0 && (!imageConsent || !supportsImages)) return;
    followOutput.current = true; setRunEvents([]); setStreamedRounds({}); setSubmitted(draft.trim()); setRunFailed(false); setRunIssue(null); setArtifactView('control');
    const data = await mutate('에이전트 실행', async p => {
      try { return await api.chat(p.id, draft.trim(), p.version, useModel, useModel ? imageIds : [], event => {
        if (event.type === 'response.delta' && Number.isInteger(event.round) && typeof event.text === 'string')
          setStreamedRounds(rounds => ({ ...rounds, [event.round]: ((rounds[event.round] || '') + event.text).slice(0, 40000) }));
        else setRunEvents(events => [...events, event].slice(-80));
      }, health?.provider?.connectionId); }
      catch (error) { setRunIssue({ message: error.message, code: error.code, committed: error.committed }); throw error; }
    });
    if (data) { setDraft(''); setImageIds([]); setImageConsent(false); setSubmitted(''); setStreamedRounds({}); }
    else setRunFailed(true);
  }
  const shortcuts = [{ label: '주변 상권 분석', text: '현재 위치 주변 상권과 접근성을 분석해줘.' }, { label: '16개 안 생성', text: '확인한 공간 조건으로 16개 후보 안을 생성해줘.' }, { label: '시뮬레이션 실행', text: '현재 실험 조건으로 모든 후보를 시뮬레이션해줘.' }, { label: '운영 데이터 검토', text: '운영 현황 조회' }];
  const research = project.research?.inputRevision === project.inputRevision ? project.research : null;
  const nearestStation = research?.stations?.[0];
  const deploymentInfo = deploymentRelation(project);
  const latestRound = [...runEvents].reverse().find(event => event.type === 'model.awaiting')?.round || 1;
  return <section className="brief-page agent-mode">
    <PageHeading eyebrow="BUSINESS BRIEF / AGENT SESSION" title="목표를 전달하고, 실행을 지휘하세요." action={<Button icon={FileText} disabled={!!pending} onClick={() => setShowGoal(s => !s)}>{showGoal ? '목표 편집 닫기' : '목표 편집'}</Button>}>대화 → 도구 실행 → 결과 검토. 운영에 반영할 결정은 오너가 승인합니다.</PageHeading>
    {showGoal && <BriefForm key={`${project.id}-${project.inputRevision}`} project={project} act={act} pending={pending} onDone={() => setShowGoal(false)} />}
    <details className="brief-project-context"><summary><FileText size={14} /><strong>행사 목표 · 조건</strong><span>{project.brief.location} · {fmt(project.space.width * project.space.depth)}㎡ · 가정 {fmt(project.assumptions.visitors)}명</span><ChevronDown size={14} /></summary><div><p>{project.brief.goal || '아직 목표를 설정하지 않았습니다.'}</p><span><Box size={14} /> {fmt(project.space.width)} × {fmt(project.space.depth)}m <Badge tone={project.space.confirmed ? 'good' : 'warn'}>{project.space.confirmed ? '치수 확인' : '미확인'}</Badge></span><span><Users size={14} /> 가정 방문객 {fmt(project.assumptions.visitors)}명</span></div></details>
    <div className="brief-layout brief-workspace"><section className="chat-panel" aria-label="Business Brief 에이전트 대화"><div className="chat-title"><span><Bot size={17} /> Event Twin Agent <small>SESSION / r{project.inputRevision}</small></span><Badge>{useModel ? '모델 도구 선택' : '로컬 명령'}</Badge></div>
      <div className="agent-session-strip"><span><i className={running ? 'working' : ''} />{running ? '요청 처리 중' : '요청 대기'}</span><span><ShieldCheck size={13} /> 승인 경계 적용</span><span>8 TOOLS</span></div>
      <div className="chat-history" aria-label="대화 및 실행 기록" onScroll={event => { const el = event.currentTarget; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>{!project.messages.length && !submitted && <div className="chat-intro"><span className="agent-avatar"><Bot size={22} /></span><small className="eyebrow">YOUR EVENT, ONE CONVERSATION</small><h2>어떤 결정을<br />함께 검증할까요?</h2><p>장소를 이해하고, 운영안을 실험하고,<br />승인한 안을 CRM으로 연결합니다.</p><div className="prompt-grid">{shortcuts.map(s => <button key={s.label} disabled={!!pending} onClick={() => setDraft(s.text)}>{s.label}<ArrowUpRight size={14} /></button>)}</div></div>}
      {project.messages.map((m, i) => <article key={m.id || i} className={`message ${m.role === 'user' ? 'user' : 'assistant'}`}><span className="message-avatar">{m.role === 'user' ? '나' : <Bot size={19} />}</span><div><div className="message-meta">{m.role === 'user' ? '비즈니스 오너' : 'Event Twin Agent'}<small>{m.role !== 'user' && <span>{m.mode === 'local' ? 'LOCAL TOOL' : m.mode ? 'MODEL' : '저장 기록'} · </span>}{date(m.createdAt || m.at)}</small></div><AgentRunTrace steps={m.steps || m.toolCalls || []} mode={m.mode || 'local'} modelContext={m.modelContext} modelActivity={m.modelActivity} /><div className={`message-text${m.role === 'user' ? '' : ' markdown-message'}`}>{m.role === 'user' ? (typeof m.content === 'string' ? m.content : m.text || JSON.stringify(m.content)) : <MarkdownBody text={typeof m.content === 'string' ? m.content : m.text || JSON.stringify(m.content)} />}</div></div></article>)}
      {submitted && <><article className="message user pending-user"><span className="message-avatar">나</span><div><div className="message-meta">비즈니스 오너<small>{runFailed ? '미저장 요청' : '전송 중'}</small></div><div className="message-text">{submitted}</div></div></article><article className="message assistant live-run"><span className="message-avatar"><Bot size={19} /></span><div><div className="message-meta">Event Twin Agent<small>{runFailed ? '실패 · 미저장' : useModel ? 'MODEL · 실시간' : 'LOCAL TOOL · 실행 중'}</small></div><AgentRunTrace events={runEvents} active={running} error={runFailed ? runIssue || '요청이 완료되지 않았습니다. 서버 상태를 확인해 주세요.' : null} mode={useModel ? 'model' : 'local'} />{useModel && <div className={`message-text markdown-message live-answer ${runFailed ? 'uncommitted' : ''}`} role="status" aria-live="polite"><small>{runFailed ? '임시 출력 · 저장되지 않음' : `모델 공개 출력 · ${latestRound}번째 응답 · 저장 전`}</small>{Object.keys(streamedRounds).filter(key => Number(key) < latestRound && streamedRounds[key]).map(key => <details key={key} className="interim-model-output"><summary>{key}번째 모델 중간 메시지</summary><MarkdownBody text={streamedRounds[key]} /></details>)}<MarkdownBody text={streamedRounds[latestRound] || (running ? '모델 응답을 기다리는 중…' : '공개 답변 없음')} /></div>}</div></article></>}
      <div ref={bottom} /></div>
      <form className="composer" onSubmit={send}>
        {project.attachments.length > 0 && <details className="attachment-picker"><summary><ImagePlus size={14} /> 저장한 사진 {project.attachments.length}개 · 최대 3장 전송 선택</summary>{!supportsImages && <p className="help">현재 NVIDIA/NIM 연결은 사진·도구 동시 입력을 지원하지 않습니다. 사진은 로컬에만 보관됩니다.</p>}<div className="attachment-list">{project.attachments.map(a => <label key={a.id}><img src={`/api/projects/${project.id}/uploads/${a.id}`} alt={a.name || '공간 사진'} /><span>{a.name}</span><input type="checkbox" checked={imageIds.includes(a.id)} disabled={!useModel || !supportsImages || !!pending || (imageIds.length >= 3 && !imageIds.includes(a.id))} onChange={e => { setImageIds(s => e.target.checked ? [...s, a.id] : s.filter(id => id !== a.id)); setImageConsent(false); }} /></label>)}</div></details>}
        <textarea maxLength={6000} aria-label="에이전트에게 메시지" placeholder={useModel ? '목표와 제약을 전달하세요. 에이전트가 필요한 도구를 선택합니다.' : '예: 주변 상권 분석해줘 · 자유 대화는 모델 사용을 켜주세요'} value={draft} onChange={e => setDraft(e.target.value)} disabled={!!pending} rows={3} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }} />
        {useModel && imageIds.length > 0 && <label className="check-row consent"><input type="checkbox" checked={imageConsent} onChange={e => setImageConsent(e.target.checked)} /> 선택한 사진 {imageIds.length}개를 모델 API에 전송하는 데 동의합니다.</label>}
        {health?.modelConfigured && <p className="composer-disclosure" id="model-data-disclosure">모델 사용 시 내 입력, 행사 목표·위치·공간·실험·최근 관측 등의 프로젝트 요약, 같은 모델 연결에서 이전에 동의해 전송한 대화 최대 8건이 외부 모델 API로 전달됩니다. 도구 실행 결과도 이어지는 호출에 포함될 수 있습니다. CRM 참가자 연락처 필드는 제외하지만, 목표나 대화에 직접 적은 개인정보는 포함될 수 있습니다. 사진은 별도 선택·동의한 것만 전송합니다.</p>}
        <div className="composer-actions"><div><input type="file" ref={fileInput} accept="image/png,image/jpeg,image/webp" hidden onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} /><button type="button" className="icon-btn" title="공간 사진 로컬 업로드" aria-label="공간 사진 업로드" disabled={!!pending} onClick={() => fileInput.current.click()}><ImagePlus size={19} /></button><label className="check-row"><input type="checkbox" aria-describedby={health?.modelConfigured ? 'model-data-disclosure' : undefined} checked={useModel} disabled={!health?.modelConfigured || !!pending} onChange={e => { setUseModel(e.target.checked); setImageConsent(false); }} /> 모델 사용 · 맥락 전송 동의</label></div><Button primary icon={ArrowUp} disabled={!draft.trim() || !!pending || (useModel && imageIds.length > 0 && !imageConsent)}>전송</Button></div>
        <small className="composer-note">{useModel ? '사진 치수 추정은 실측 확인이 필요합니다. 선택하지 않은 사진은 전송하지 않습니다.' : '외부 모델 전송 없음 · 지원하지 않는 요청은 실행하지 않음'}</small>
      </form>
    </section><section className="brief-artifact" aria-label="지도와 에이전트 도구 결과">
      <header className="brief-result-header"><div><small>EXECUTION CONTEXT</small><h2><Activity size={17} /> 실행 컨트롤</h2></div><Badge>{health?.runtime?.sandbox?.connected ? '런타임 연결 보고됨' : '로컬 런타임'}</Badge></header>
      <div className="brief-result-switch"><div role="tablist" aria-label="도구 결과 보기">{[['control', '작업 · 도구'], ['map', '지도'], ['research', '분석 근거']].map(([id, label]) => <button type="button" role="tab" id={`brief-${id}-tab`} key={id} aria-selected={artifactView === id} aria-controls={`brief-${id}-result`} onClick={() => setArtifactView(id)}>{label}</button>)}</div></div>
      <div className="brief-artifact-content">
        <div id="brief-control-result" role="tabpanel" aria-labelledby="brief-control-tab" className="brief-artifact-view" hidden={artifactView !== 'control'}><AgentInspector project={project} health={health} pending={pending} navigate={navigate} onPrompt={text => { if (!pending) { setDraft(text); setRunFailed(false); setSubmitted(''); } }} events={running ? runEvents : []} runtime={health?.runtime} /></div>
        <div id="brief-map-result" role="tabpanel" aria-labelledby="brief-map-tab" className="brief-artifact-view" hidden={artifactView !== 'map'}><div className="agent-map-action"><span>{research ? `입력 r${research.inputRevision}` : project.research ? '입력이 변경됨 · 재분석 필요' : '현재 위치 · 분석 전'}</span><Button primary icon={Sparkles} disabled={!!pending} onClick={() => act('RUN_RESEARCH', {}, '저장된 지리 데이터로 분석했습니다. 최신 조회는 지도 시설 갱신을 사용하세요.')}>{research ? '저장 자료 재분석' : '저장 자료 분석'}</Button></div><MarketMap project={project} pending={pending} onRefresh={refreshMap} onLocationChange={value => { if (!pending) act('UPDATE_BRIEF', value, '분석 위치를 저장했습니다.'); }} />
          <div className="brief-map-location"><MapPin size={13} /><span>{project.brief.location} · {fmt(project.brief.lat, 6)}, {fmt(project.brief.lng, 6)}</span></div>
          {research ? <div className="brief-map-evidence"><div><small>{research.coverage?.complete ? '500m 등록 시설' : '수집 범위 내 등록 시설'}</small><strong>{fmt(research.facilities?.length || 0)}개</strong></div><div><small>수집된 역 중 최근접 · 직선거리</small><strong>{nearestStation ? `${nearestStation.name} · ${fmt(nearestStation.distance)}m` : '확인된 역 없음'}</strong></div></div> : <p className="brief-result-note">지도를 확대·이동하며 위치를 확인하세요. 분석을 실행하면 수집 범위와 시설·역까지의 거리 계산 결과가 저장됩니다.</p>}
        </div>
        <div id="brief-research-result" role="tabpanel" aria-labelledby="brief-research-tab" className="brief-artifact-view brief-research-view" hidden={artifactView !== 'research'}>{research ? <ResearchResult research={research} /> : <Empty icon={MapPin} title={project.research ? '현재 입력으로 다시 분석해 주세요.' : '아직 저장된 분석 결과가 없습니다.'}>상권·접근성 분석을 실행하거나 에이전트에게 요청하세요. 외부 API 없이 로컬 OSM 스냅샷과 현재 가정을 계산합니다.</Empty>}</div>
      </div>
      <div className="brief-next-actions"><button className="next-action" onClick={() => navigate('space')}><Box size={16} /><span>공간과 제약<small>사진 · 실측 치수</small></span><ChevronRight size={14} /></button><button className="next-action" onClick={() => navigate('compare')}><Layers size={16} /><span>여러 안 비교<small>{project.candidates.length}개 · {project.simulation ? '계산 완료' : '실험 전'}</small></span><ChevronRight size={14} /></button><button className="next-action" onClick={() => navigate('build')}><Database size={16} /><span>CRM 빌드<small>{deploymentInfo.exists ? deploymentInfo.label : project.approval ? '승인안 준비됨' : '최적안 승인 필요'}</small></span><ChevronRight size={14} /></button></div>
      <p className="brief-evidence-warning"><ShieldCheck size={14} /><span>실행 기록은 실제 도구 입출력입니다. 로컬 명령은 모델 판단이 아니며, 실험은 미보정 가정 기반입니다.</span></p>
    </section></div>
  </section>;
}

function BriefForm({ project, act, pending, onDone }) {
  const [values, setValues] = useState({ name: project.name, ...project.brief });
  async function submit(e) { e.preventDefault(); if (await act('UPDATE_BRIEF', values, '행사 목표를 저장했습니다.')) onDone?.(); }
  return <form className="panel brief-form" onSubmit={submit}><div className="form-grid"><Field label="행사 이름"><input required maxLength={120} value={values.name} onChange={e => setValues(s => ({ ...s, name: e.target.value }))} /></Field><Field label="지역 · 장소" help="장소 이름은 좌표를 자동 변경하지 않습니다. 지도에서 실제 좌표를 확인하세요."><input required value={values.location} onChange={e => setValues(s => ({ ...s, location: e.target.value }))} /></Field><Field label="핵심 목표" className="span-two"><textarea required rows={2} value={values.goal} onChange={e => setValues(s => ({ ...s, goal: e.target.value }))} /></Field></div><div className="form-actions"><Button primary disabled={!!pending} icon={Check}>목표 저장</Button></div></form>;
}

function Market({ project, act, pending, refreshMap }) {
  return <><PageHeading eyebrow="BUSINESS INTELLIGENCE / GEOGRAPHIC TOOLS" title="실제 장소에서 시작하는 계획" action={<Button primary icon={Sparkles} disabled={!!pending} onClick={() => act('RUN_RESEARCH', {}, '저장된 지리 데이터로 분석했습니다. 최신 조회는 지도 시설 갱신을 사용하세요.')}>저장 자료 재분석</Button>}>실제 OSM 도로·건물·시설과 지리 계산을 사용합니다. 매출·유동인구 추정과 구분합니다.</PageHeading><div className="market-layout"><Panel title="실제 장소 · 지도 출처" action={<Badge>OpenStreetMap</Badge>}><MarketMap project={project} pending={pending} onRefresh={refreshMap} onLocationChange={(value, lng) => { if (!pending) act('UPDATE_BRIEF', typeof value === 'object' ? value : { lat: value, lng }, '분석 위치를 저장했습니다.'); }} /><div className="map-caption">선택 위치 {fmt(project.brief.lat, 6)}, {fmt(project.brief.lng, 6)} · 배경 지형은 성수동 스냅샷 / 최신 시설은 별도 조회</div></Panel><Panel title="에이전트 리서치 결과" eyebrow="EVIDENCE · NOT A FORECAST">{project.research ? <ResearchResult research={project.research} /> : <Empty icon={MapPin} title="현재 위치를 분석해 보세요.">인근 시설, 접근성, 운영 가정을 도구 결과로 확인할 수 있습니다.</Empty>}<div className="callout"><AlertTriangle size={18} /><p>OSM 시설 등록은 현재 영업 여부를 보증하지 않습니다. 직선거리는 도보 경로가 아니며, 실제 유동인구·매출 데이터는 연결되지 않았습니다.</p></div></Panel></div></>;
}
function ResearchResult({ research }) {
  const status = { complete: '계산 완료', assumption: '입력 가정', limited: '제한 있음', unavailable: '미연결' };
  return <div className="research-results"><div className="research-summary"><span>{date(research.createdAt)}</span><Badge>{research.radius || 500}m 반경</Badge></div>{research.tools?.map((tool, index) => <article className="research-tool" key={tool.id}><header><span className="tool-number">{String(index + 1).padStart(2, '0')}</span><h3>{tool.name}</h3><Badge tone={tool.status === 'complete' ? 'good' : tool.status === 'unavailable' ? 'warn' : ''}>{status[tool.status] || tool.status}</Badge></header><p>{tool.summary}</p><small>{tool.basis}</small><details><summary>입력 · 계산 근거 보기</summary><pre>{JSON.stringify(tool.data, null, 2)}</pre></details></article>)}{research.stations?.length > 0 && <details><summary>실제 역까지 직선거리</summary>{research.stations.map(station => <p key={station.name}>{station.name} · {fmt(station.distance)}m</p>)}</details>}<details><summary>분석 원본 · 출처 확인</summary><pre>{JSON.stringify(research, null, 2)}</pre></details></div>;
}

function Space({ project, act, pending, upload, navigate, uploadMaxMB = 5 }) {
  const [space, setSpace] = useState(project.space), [assumptions, setAssumptions] = useState(project.assumptions), [view, setView] = useState('perspective');
  const [moving, setMoving] = useState(true);
  useEffect(() => { setSpace(project.space); setAssumptions(project.assumptions); }, [project.inputRevision]);
  const file = useRef();
  const candidate = useMemo(() => project.candidates[0] || { id: 'preview', name: '공간 입력 미리보기', family: project.space.family, variant: project.space.variant || 0, booths: project.space.booths, staff: project.space.staff, space: project.space }, [project.space, project.candidates]);
  async function saveSpace(e) { e.preventDefault(); await act('UPDATE_SPACE', { ...space, width: Number(space.width), depth: Number(space.depth), height: Number(space.height), booths: Number(space.booths), staff: Number(space.staff), variant: Number(space.variant || 0) }, '공간 입력을 저장했습니다. 기존 실험·승인은 새 조건으로 다시 검증해야 합니다.'); }
  async function saveAssumptions(e) { e.preventDefault(); const next = Object.fromEntries(Object.entries(assumptions).map(([k, v]) => [k, Number(v)])); await act('UPDATE_ASSUMPTIONS', next, '실험 조건을 저장했습니다.'); }
  return <><PageHeading eyebrow="DESIGN & EXPERIMENT / INPUT REVISION" title="공간을 수치로 이해합니다." action={<Badge tone={project.space.confirmed ? 'good' : 'warn'}>{project.space.confirmed ? '실측 치수 확인됨' : '사용자 치수 확인 필요'}</Badge>}>사진은 맥락으로, 실측 수치는 기준으로. 변경 사항은 새 실험 리비전으로 저장됩니다.</PageHeading>
    <div className="space-layout"><Panel title="공간 모델" action={<div className="space-view-controls"><div className="segmented">{[['perspective', '전체'], ['top', '평면'], ['entry', '입구']].map(([v, label]) => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{label}</button>)}</div><Button quiet icon={moving ? Pause : Play} aria-pressed={moving} onClick={() => setMoving(value => !value)}>{moving ? '모션 일시정지' : '모션 재생'}</Button></div>}><div className="large-scene"><Scene candidate={candidate} view={view} moving={moving} className="space-render" /><div className="scene-caption"><Badge>PARAMETRIC WHITE MODEL</Badge><span>{fmt(project.space.width)} × {fmt(project.space.depth)} × {fmt(project.space.height, 1)}m</span></div></div><p className="help padded">수치 기반 매개변수 모델입니다. 사진의 정밀 3D 복원이나 구조·피난 안전 검증이 아닙니다. 대화와 입력 폼으로 조정합니다.</p></Panel>
      <Panel title="실측 치수 · 공간 설정" eyebrow={`INPUT r${project.inputRevision}`}><form onSubmit={saveSpace}><fieldset disabled={!!pending}><div className="form-grid"><Numeric label="가로 (m)" name="width" values={space} setValues={setSpace} min={8} max={100} /><Numeric label="세로 (m)" name="depth" values={space} setValues={setSpace} min={8} max={100} /><Numeric label="높이 (m)" name="height" values={space} setValues={setSpace} min={2.2} max={12} /><Field label="기본 공간 형태"><select value={space.family} onChange={e => setSpace(s => ({ ...s, family: e.target.value }))}>{Object.entries(familyNames).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></Field><Numeric label="기본 체험 부스" name="booths" values={space} setValues={setSpace} min={1} max={12} /><Numeric label="운영 인력" name="staff" values={space} setValues={setSpace} min={1} max={30} /></div><label className="check-row confirmation"><input type="checkbox" checked={!!space.confirmed} onChange={e => setSpace(s => ({ ...s, confirmed: e.target.checked }))} /> 이 치수가 실측 또는 도면의 기준값임을 확인합니다.</label><div className="form-actions"><Button primary icon={Check}>공간 저장</Button></div></fieldset></form></Panel></div>
    <Panel title="공간 사진" action={<><input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} /><Button icon={Upload} disabled={!!pending} onClick={() => file.current.click()}>사진 업로드</Button></>}><div className="photos">{project.attachments.length ? project.attachments.map(a => <figure key={a.id}><img src={`/api/projects/${project.id}/uploads/${a.id}`} alt={a.name} /><figcaption>{a.name}</figcaption></figure>) : <p className="help">현장 사진·도면을 워크스페이스에 저장하세요. 모델에 보내려면 Business Brief에서 사진을 선택하고 전송에 동의하세요. 최대 {uploadMaxMB}MB.</p>}</div></Panel>
    <Panel title="모든 안에 동일하게 적용할 실험 조건" eyebrow="PAIRED SEED / REPRODUCIBLE EXPERIMENT"><form onSubmit={saveAssumptions}><fieldset disabled={!!pending}><div className="form-grid four"><Numeric label="총 방문객 (명)" name="visitors" values={assumptions} setValues={setAssumptions} min={1} max={10000} /><Numeric label="행사 시간 (분)" name="durationMinutes" values={assumptions} setValues={setAssumptions} min={30} max={1440} /><Numeric label="평균 체험 시간 (분)" name="serviceMinutes" values={assumptions} setValues={setAssumptions} min={0.5} max={60} /><Numeric label="피크 도착 배율" name="arrivalPeak" values={assumptions} setValues={setAssumptions} min={0.1} max={5} /><Numeric label="대기 허용 (분)" name="patienceMinutes" values={assumptions} setValues={setAssumptions} min={1} max={180} /><Numeric label="마케팅 동의 가정 (0–1)" name="consentRate" values={assumptions} setValues={setAssumptions} min={0} max={1} /><Numeric label="총 예산 (원)" name="budget" values={assumptions} setValues={setAssumptions} min={100000} /><Numeric label="최소 완료율 (%)" name="minCompletionRate" values={assumptions} setValues={setAssumptions} min={0} max={100} /><Numeric label="최대 P90 대기 (분)" name="maxWaitMinutes" values={assumptions} setValues={setAssumptions} min={0} max={180} /><Numeric label="최소 동의 인원 (명)" name="minConsent" values={assumptions} setValues={setAssumptions} min={0} /><Numeric label="공통 시드" name="seed" values={assumptions} setValues={setAssumptions} min={0} max={2147483647} /><Numeric label="반복 실험 횟수" name="replications" values={assumptions} setValues={setAssumptions} min={2} max={30} /></div><div className="form-actions"><span className="help">가정 변경 시 기존 후보·계산·승인은 무효화됩니다. 배포된 CRM은 보존됩니다.</span><Button icon={Check}>실험 조건 저장</Button></div></fieldset></form></Panel>
    <div className="bottom-action"><div><h3>이제 16개 배치 안을 만들 수 있습니다.</h3><p>{project.space.confirmed ? '현재 저장된 치수와 조건으로 다양한 공간 구성을 생성합니다.' : '실측 치수를 확인하고 공간을 먼저 저장하세요.'}</p></div><Button primary icon={Layers} disabled={!!pending || !project.space.confirmed} onClick={async () => { if (await act('GENERATE_CANDIDATES', {}, '16개 후보 공간을 생성했습니다.')) navigate('compare'); }}>16개 안 생성</Button></div>
  </>;
}

function Compare({ project, act, pending, navigate }) {
  const [detail, setDetail] = useState(null), [moving, setMoving] = useState(true), [onlyFeasible, setOnlyFeasible] = useState(false), [view, setView] = useState('perspective');
  const [natAudit, setNatAudit] = useState(null), [natAuditError, setNatAuditError] = useState(null), [natAuditLoading, setNatAuditLoading] = useState(false);
  const auditView = natAuditView(project, natAudit, natAuditError, natAuditLoading);
  async function runNatAudit() {
    if (natAuditLoading || pending) return;
    setNatAuditLoading(true); setNatAuditError(null); setNatAudit(null);
    try { const { natAudit: receipt } = await api.natAudit(project.id); setNatAudit(receipt); }
    catch (error) { setNatAuditError(error); }
    finally { setNatAuditLoading(false); }
  }
  const results = new Map((project.simulation?.results || []).map(r => [r.candidateId, r]));
  const candidates = project.candidates.filter(c => !onlyFeasible || results.get(c.id)?.feasible);
  const selected = project.candidates.find(c => c.id === project.selectedId), selectedResult = results.get(project.selectedId);
  const detailed = project.candidates.find(c => c.id === detail), detailedResult = results.get(detail);
  const feasibleCount = [...results.values()].filter(r => r.feasible).length;
  return <><PageHeading eyebrow="DESIGN & EXPERIMENT / BATCH COMPARISON" title="같은 조건, 열여섯 개의 가능성." action={<Badge tone={project.simulation ? 'good' : ''}>{project.simulation ? '실험 완료' : '실험 전'}</Badge>}>동일한 방문 가정·시드로 반복 비교합니다. 움직이는 사람은 절차적 시각화이며, 실제 예측 궤적이 아닙니다.</PageHeading>
    {!project.candidates.length ? <Empty icon={Layers} title="아직 후보 안이 없습니다." action={<Button primary icon={Box} onClick={() => navigate('space')}>공간과 실험 조건 확인</Button>}>실측 치수를 확인한 후 16개의 공간 안을 생성하세요.</Empty> : <>
      <div className="compare-toolbar"><div><Button primary icon={Play} disabled={!!pending} onClick={() => act('RUN_SIMULATION', {}, '모든 후보의 반복 실험 계산을 완료했습니다.')}>{project.simulation ? '16개 안 다시 실험' : '16개 안 동시 실험'}</Button><Button quiet icon={moving ? Pause : Play} onClick={() => setMoving(s => !s)}>{moving ? '모션 일시정지' : '모션 재생'}</Button><div className="segmented">{[['perspective', '3D'], ['top', '평면']].map(([v, label]) => <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{label}</button>)}</div></div><label className="check-row"><input type="checkbox" checked={onlyFeasible} disabled={!project.simulation} onChange={e => setOnlyFeasible(e.target.checked)} /> 제약 통과만 {project.simulation && `(${feasibleCount})`}</label></div>
      <section className={`nat-audit nat-audit-${auditView.status}`} aria-label="NeMo Agent Toolkit 실험 검수"><div className="nat-audit-main"><span className="eyebrow">NEMO AGENT TOOLKIT / READ-ONLY AUDIT</span><div className="nat-audit-state" role="status" aria-live="polite"><ShieldCheck size={17} /><strong>{auditView.title}</strong><span>{auditView.detail}</span></div><p>NAT는 저장된 시뮬레이션 결과를 읽어 검수합니다. 예측 모델이나 독립적인 추론 결과가 아닙니다.</p></div><Button icon={RefreshCw} disabled={!!pending || natAuditLoading} onClick={runNatAudit}>{natAuditLoading ? '검수 중…' : 'NAT 결과 검수'}</Button></section>
      <div className="experiment-meta"><span><FlaskConical size={14} />방문 {fmt(project.assumptions.visitors)}명 · {project.assumptions.durationMinutes}분 · {project.assumptions.replications}회 반복 · 시드 {project.assumptions.seed}</span><span>허용 대기 ≤ {project.assumptions.maxWaitMinutes}분 · 예산 ≤ {won(project.assumptions.budget)}</span></div>
      {project.simulation && !feasibleCount && <div className="notice error"><AlertTriangle size={18} /><span>현재 조건을 모두 충족하는 안이 없습니다. 상세 사유를 확인하고 공간 또는 가정을 수정한 후 재실험하세요.</span></div>}
      <div className="candidate-grid">{candidates.map(c => { const r = results.get(c.id), isSelected = c.id === project.selectedId, recommended = c.id === project.simulation?.recommendedId; return <article className={`candidate ${isSelected ? 'selected' : ''}`} key={c.id}><header><span className="candidate-id">{c.id}</span><div><h3>{c.name}</h3><small>{c.familyName || familyNames[c.family] || c.family}</small></div>{recommended && <Badge tone="good">추천</Badge>}</header><button className="candidate-visual" aria-label={`${c.id}안 상세 보기`} onClick={() => setDetail(c.id)}><Scene candidate={c} view={view} moving={moving} /><span>{c.booths}부스 · {c.staff}명 · {fmt(c.space?.width * c.space?.depth)}㎡</span></button><div className="candidate-kpis"><div><small>체험 완료</small><strong>{r ? fmt(r.completed) : '—'}<em>명</em></strong></div><div><small>완료율</small><strong>{r ? fmt(r.rate, 1) : '—'}<em>%</em></strong></div></div><div className="candidate-secondary"><span>P90 대기 <b>{r ? fmt(r.waitP90, 1) : '—'}분</b></span><span>비용 <b>{r ? fmt(r.cost / 10000) : '—'}만원</b></span></div><footer><span className={`candidate-state ${r?.feasible ? 'pass' : ''}`}>{r ? (r.feasible ? '제약 통과' : '제약 미충족') : '계산 대기'}</span><div><button aria-label={`${c.id}안 상세`} onClick={() => setDetail(c.id)}>상세</button><button className={isSelected ? 'chosen' : ''} disabled={!!pending} onClick={() => act('SELECT_CANDIDATE', { candidateId: c.id })}>{isSelected ? <><Check size={12} />선택됨</> : '선택'}</button></div></footer></article>; })}</div>
      {!candidates.length && <Empty title="제약을 통과한 안이 없습니다.">필터를 해제해서 모든 안의 상세 결과를 확인하세요.</Empty>}
      <div className="decision-bar"><div><span className="eyebrow">OWNER DECISION</span><h3>{selected ? `${selected.id} · ${selected.name}` : '검토할 안을 선택하세요.'}</h3><p>{selectedResult ? `완료 ${fmt(selectedResult.completed)}명 · 동의 ${fmt(selectedResult.consents)}명 · ${selectedResult.feasible ? '모든 제약 통과' : selectedResult.reasons.join(' · ')}` : '선택한 안을 실험하고 제약 통과 여부를 확인하세요.'}</p></div><div>{project.approval && <Badge tone="good"><ShieldCheck size={13} /> 승인됨</Badge>}<Button primary icon={ShieldCheck} disabled={!!pending || !selectedResult?.feasible || !!project.approval} onClick={() => act('APPROVE_PLAN', { candidateId: project.selectedId }, '선택한 안을 승인했습니다. 승인 스냅샷으로 CRM을 빌드할 수 있습니다.')}>선택안 승인</Button>{project.approval && <Button icon={ArrowUpRight} onClick={() => navigate('build')}>CRM 빌드로</Button>}</div></div>
      <p className="help">계산 엔진: {project.simulation?.method || '반복 대기열 실험'} · 보정 전 가정 기반 계산이며 실제 성과 보장이 아닙니다. CRM 배포는 명시적 승인 이후에만 가능합니다.</p>
    </>}
    {detailed && <Modal title={`${detailed.id} · ${detailed.name}`} wide className="scene-detail-modal" onClose={() => setDetail(null)}><ScenePlayer candidate={detailed} />{detailedResult ? <><div className="stats-grid four"><Stat label="체험 완료" value={`${fmt(detailedResult.completed)}명`} foot={`완료율 10–90 분위수 ${fmt(detailedResult.range?.low, 1)}–${fmt(detailedResult.range?.high, 1)}%`} /><Stat label="P90 대기" value={`${fmt(detailedResult.waitP90, 1)}분`} /><Stat label="총비용" value={won(detailedResult.cost)} /><Stat label="동의 인원" value={`${fmt(detailedResult.consents)}명`} foot={`이탈 ${fmt(detailedResult.abandoned)}명`} /></div><h3 className="detail-heading">제약 평가</h3>{detailedResult.feasible ? <Badge tone="good">모든 제약 통과</Badge> : <ul className="reason-list">{detailedResult.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}<Timeline data={detailedResult.timeline || []} /><details className="raw-detail"><summary>반복 결과 원본 확인</summary><pre>{JSON.stringify(detailedResult, null, 2)}</pre></details></> : <p className="help">아직 계산하지 않은 후보 공간입니다. 16개 안 동시 실험을 실행하세요.</p>}<div className="form-actions"><Button primary disabled={!!pending} onClick={async () => { if (await act('SELECT_CANDIDATE', { candidateId: detailed.id })) setDetail(null); }}>이 안 선택</Button></div></Modal>}
  </>;
}

function Timeline({ data }) {
  if (!data.length) return null;
  const maxX = Math.max(1, ...data.map(d => d.minute)), maxY = Math.max(1, ...data.map(d => Math.max(d.completed || 0, d.waiting || 0)));
  const path = key => data.map((d, i) => `${i ? 'L' : 'M'}${40 + d.minute / maxX * 700},${170 - (d[key] || 0) / maxY * 140}`).join(' ');
  return <div className="timeline"><h3>시간별 계산 결과</h3><svg viewBox="0 0 780 205" role="img" aria-label="시간별 누적 완료 및 대기 인원 그래프"><path d="M40 20V170H745" stroke="#dbe0e6" fill="none" /><path d={path('completed')} fill="none" stroke="#76b900" strokeWidth="3" /><path d={path('waiting')} fill="none" stroke="#b49156" strokeWidth="2" /><text x="4" y="31">{fmt(maxY)}</text><text x="25" y="174">0</text><text x="40" y="194">0분</text><text x="706" y="194">{maxX}분</text></svg><div className="chart-legend"><span><i />누적 완료</span><span><i className="amber" />대기</span></div></div>;
}

function BuildCRM({ project, act, pending, navigate }) {
  const schema = project.crm.schema, deployment = project.crm.deployment;
  const deploymentInfo = deploymentRelation(project);
  const displayed = schema || deployment?.schema;
  const alreadyApplied = !!schema && deployment?.schema?.id === schema.id;
  const zones = displayed?.zones || [], slots = displayed?.slots || [];
  const zoneNames = new Map(zones.map(zone => [zone.id, zone.name]));
  const previewSlots = [...slots].sort((a, b) => a.startMinute - b.startMinute || a.zoneId.localeCompare(b.zoneId)).slice(0, 12);
  const views = {
    '등록자': { icon: Users, description: '연락처·등록 상태·마케팅 동의를 한 곳에서 관리합니다.' },
    '현장 체크인': { icon: CheckCheck, description: '방문 확인을 기록하고 다음 체험 단계로 연결합니다.' },
    '대기': { icon: Clock, description: '대기 중인 참가자를 필터링하고 담당 업무를 확인합니다.' },
    '체험 완료': { icon: CircleCheck, description: '완료 이력과 피드백 요청 검토 업무를 확인합니다.' },
  };
  const automations = {
    waiting: { title: '대기 발생 → 담당 업무 생성', description: '참가 상태가 대기로 바뀌면 내부 확인 업무를 생성합니다. 같은 등록의 열린 업무는 중복 생성하지 않습니다.', badge: '로컬 자동화' },
    completed: { title: '체험 완료 → 피드백 검토', description: '완료 시 담당자에게 피드백 요청 초안을 검토할 업무를 만듭니다. 메시지는 발송하지 않습니다.', badge: '로컬 자동화' },
    marketing: { title: '마케팅 동의 → 별도 이력 보관', description: '참가 등록과 분리해 동의·철회 이력을 저장합니다. 외부 발송은 연결되지 않았습니다.', badge: '발송 미연결' },
  };
  return <><PageHeading eyebrow="OPERATIONS / CRM BUILDER" title="승인한 경험을 운영 시스템으로." action={<Badge tone={deploymentInfo.exists ? deploymentInfo.current ? 'good' : 'warn' : ''}>{deploymentInfo.exists ? deploymentInfo.label : '배포 전'}</Badge>}>행사별 구조, 참가 신청, 동의, 체크인, 담당 업무를 승인 스냅샷에서 빌드합니다.</PageHeading><div className="build-flow"><div className={project.approval ? 'done' : ''}><ShieldCheck /><strong>01 · 설계 승인</strong><small>{project.approval ? '승인 스냅샷 저장됨' : '실험 제약 통과 후 오너 승인'}</small></div><ChevronRight /><div className={schema ? 'done' : ''}><Database /><strong>02 · CRM 빌드</strong><small>{schema ? '운영 스키마 생성됨' : '구역·인력·운영 구조 생성'}</small></div><ChevronRight /><div className={deploymentInfo.current ? 'done' : deployment ? 'prior-deployment' : ''}><Users /><strong>03 · 로컬 운영 시작</strong><small>{deploymentInfo.exists ? deploymentInfo.label : '검토 후 로컬 적용'}</small></div></div>
    <div className="build-actions"><Button icon={Database} primary disabled={!!pending || !project.approval} onClick={() => act('BUILD_CRM', {}, '승인 스냅샷에서 CRM 스키마를 빌드했습니다.')}>{schema ? 'CRM 다시 빌드' : 'CRM 빌드'}</Button><Button icon={alreadyApplied ? Check : Play} disabled={!!pending || !schema || !project.approval || alreadyApplied} onClick={() => act('DEPLOY_CRM', {}, 'CRM을 로컬 운영 환경에 적용했습니다. 외부 시스템에는 전송하지 않았습니다.')}>{alreadyApplied ? '현재 빌드 배포됨' : '로컬 CRM 배포'}</Button>{deployment && <Button icon={ArrowUpRight} onClick={() => navigate('people')}>참가자 관리 열기</Button>}</div>
    {(!project.approval || (deployment && !deploymentInfo.current)) && <div className="callout"><AlertTriangle size={18} /><p>{!project.approval && '현재 설계의 승인안이 필요합니다. '}{deployment && !deploymentInfo.current ? `${deploymentInfo.detail}. 참가자·업무 기록은 기존 배포에 계속 연결됩니다. 현재 설계로 교체하려면 새 승인·CRM 빌드·배포가 필요합니다.` : '먼저 여러 안을 실험하고 제약을 통과한 안을 승인하세요.'}</p><Button quiet onClick={() => navigate('compare')}>안 비교로</Button></div>}
    {displayed ? <>
      <div className="experiment-meta"><span><Database size={14} />{schema ? '검토 중인 운영 패키지' : '현재 배포를 유지 중인 운영 패키지'} · {displayed.candidateId}안 · 입력 r{displayed.inputRevision}</span><span>{date(displayed.createdAt)}</span></div>
      <div className="stats-grid four"><Stat label="체험 구역" value={`${fmt(zones.length)}개`} foot="승인한 공간 배치와 연결" /><Stat label="운영 슬롯" value={`${fmt(slots.length)}회`} foot={`평균 서비스 ${fmt(displayed.slotDurationMinutes, 2)}분 기준`} /><Stat label="동시 체험 용량" value={`${fmt(displayed.serviceStations)}명`} foot="실험의 구역별 용량 합계" /><Stat label="운영 인력" value={`${fmt(displayed.staff)}명`} foot={`접수 ${fmt(displayed.checkInStaff)} · 체험 ${fmt(displayed.serviceStaff)}`} /></div>
      <div className="crm-schema-grid">
        <Panel title="구역별 운영 구성" eyebrow="ZONES & CAPACITY" action={<Badge>{zones.length}개 구역</Badge>}><div className="table-scroll"><table><thead><tr><th>구역 이름</th><th>동시 정원</th><th>체험 인력</th></tr></thead><tbody>{zones.map(zone => <tr key={zone.id}><td>{zone.name}</td><td>{fmt(zone.capacity)}명</td><td>{fmt(zone.staff)}명</td></tr>)}</tbody></table></div><p className="help padded">체험 인력은 공용 운영 인력으로 배분됩니다. 접수 인력 {fmt(displayed.checkInStaff)}명은 별도입니다. 공간·피난 안전 검토를 대체하지 않습니다.</p></Panel>
        <Panel title="운영 슬롯 미리보기" eyebrow="EXPERIENCE SLOTS" action={<Badge>처음 {previewSlots.length} / {slots.length}회</Badge>}><div className="table-scroll"><table><thead><tr><th>시작–종료</th><th>체험 구역</th><th>정원</th></tr></thead><tbody>{previewSlots.map(slot => <tr key={slot.id}><td>{fmt(slot.startMinute, 2)}–{fmt(slot.endMinute, 2)}분</td><td>{zoneNames.get(slot.zoneId) || slot.zoneId}</td><td>{fmt(slot.capacity)}명</td></tr>)}</tbody></table></div><p className="help padded">행사 시작을 0분으로 표시합니다. 전체 {fmt(slots.length)}개 슬롯은 아래 원본에 보관됩니다. 예약 가능 용량은 실제 완료 예측과 다릅니다.</p></Panel>
        <Panel title="참가자 운영 뷰" eyebrow="CRM VIEWS" action={deployment && <Button quiet icon={ArrowUpRight} onClick={() => navigate('people')}>열기</Button>}><div className="schema-list">{displayed.views?.map(name => { const item = views[name], Icon = item?.icon || Users; return <div key={name}><strong><Icon size={13} /> {name}</strong><p className="help">{item?.description || name}</p></div>; })}</div></Panel>
        <Panel title="내부 자동화 · 승인 경계" eyebrow="LOCAL WORKFLOWS"><div className="schema-list">{displayed.automation?.map(rule => { const item = automations[rule.trigger]; return <div key={rule.trigger}><strong>{item?.title || rule.trigger} <Badge>{item?.badge || '검토 필요'}</Badge></strong><p className="help">{item?.description || rule.action}</p></div>; })}</div></Panel>
      </div>
      <details className="raw-detail"><summary>운영 패키지 원본 · 전체 슬롯 {fmt(slots.length)}개 · 승인 식별자</summary><pre>{JSON.stringify(displayed, null, 2)}</pre></details>
    </> : <Empty icon={Database} title="아직 CRM이 빌드되지 않았습니다.">단순 화면 미리보기가 아닙니다. 빌드 후 생성된 스키마가 참가자·업무 관리에 실제 적용됩니다.</Empty>}
    {deployment && <details className="raw-detail"><summary>현재 로컬 배포 기록 · {date(deployment.appliedAt)}</summary><pre>{JSON.stringify({ ...deployment, schema: { id: deployment.schema.id, inputRevision: deployment.schema.inputRevision, candidateId: deployment.schema.candidateId } }, null, 2)}</pre></details>}
    <div className="callout"><ShieldCheck size={18} /><p>이 배포는 로컬 SQLite 운영 시스템에만 적용됩니다. 이메일·문자 발송이나 외부 CRM 계정 변경은 수행하지 않습니다. 마케팅 동의는 참가 등록과 분리해 이력으로 보관합니다.</p></div>
  </>;
}

function People({ project, act, pending, setNotice, navigate }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [modal, setModal] = useState(null), [selectedId, setSelectedId] = useState(null), [rows, setRows] = useState(null), [sample, setSample] = useState(false);
  const file = useRef();
  const crm = project.crm, selected = crm.people.find(p => p.id === selectedId);
  const deploymentInfo = deploymentRelation(project);
  const registrations = new Map(crm.registrations.map(r => [r.personId, r]));
  const getConsent = id => { const events = crm.consents.filter(c => c.personId === id); return events.length ? !!events[events.length - 1].granted : false; };
  const people = crm.people.filter(p => `${p.name} ${p.email || ''} ${p.phone || ''}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || registrations.get(p.id)?.status === filter));
  async function add(e) { e.preventDefault(); const f = new FormData(e.currentTarget); const data = await act('ADD_PERSON', { name: f.get('name'), email: f.get('email'), phone: f.get('phone'), marketingConsent: f.get('marketingConsent') === 'on' }, '참가자를 등록했습니다.'); if (data) setModal(null); }
  async function readCSV(file) { if (!file) return; try { if (file.size > 1024 * 1024) throw new Error('CSV는 1MB 이하로 선택해 주세요.'); setRows(parsePeopleCSV(await file.text())); setSample(false); setModal('import'); } catch (e) { setNotice({ error: true, text: e.message }); } }
  const checkedIn = crm.registrations.filter(r => r.status !== 'registered').length, completed = crm.registrations.filter(r => r.status === 'completed').length;
  return <><PageHeading eyebrow="OPERATIONS / PEOPLE & ACTIVITIES" title="한 명의 경험도 놓치지 않도록." action={<div className="row-actions"><input hidden ref={file} type="file" accept=".csv,text/csv" onChange={e => { readCSV(e.target.files[0]); e.target.value = ''; }} /><Button icon={Upload} disabled={!!pending || !crm.deployment} onClick={() => file.current.click()}>CSV 가져오기</Button><Button primary icon={Plus} disabled={!!pending || !crm.deployment} onClick={() => setModal('add')}>참가자 등록</Button></div>}>실제 저장한 참가자·동의·체크인 기록만 표시합니다. 샘플은 별도로 태그됩니다.</PageHeading>
    {!crm.deployment && <Empty icon={Users} title="먼저 CRM을 로컬 배포하세요." action={<Button onClick={() => navigate('build')} primary>CRM 빌드로</Button>}>배포된 운영 구조에 참가자와 활동을 연결합니다.</Empty>}
    {deploymentInfo.exists && !deploymentInfo.current && <div className="callout" role="status"><AlertTriangle size={18} /><p>{deploymentInfo.detail}. 여기서 변경하는 참가자·업무는 현재 새 설계가 아닌 기존 로컬 CRM 배포에 기록됩니다.</p><Button quiet onClick={() => navigate('build')}>배포 상태 확인</Button></div>}
    <div className="stats-grid four"><Stat label="등록 참가자" value={`${fmt(crm.people.length)}명`} /><Stat label="체크인 이후" value={`${fmt(checkedIn)}명`} /><Stat label="체험 완료" value={`${fmt(completed)}명`} /><Stat label="마케팅 동의" value={`${fmt(crm.people.filter(p => getConsent(p.id)).length)}명`} /></div>
    <Panel title="참가자" action={<Badge>{people.length} records</Badge>}><div className="table-toolbar"><div className="search"><Search size={15} /><input placeholder="이름, 이메일, 전화번호 검색" aria-label="참가자 검색" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="참가 상태 필터" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">모든 상태</option>{Object.entries(statusNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div><div className="table-scroll"><table><thead><tr><th>이름</th><th>연락처</th><th>참가 상태</th><th>마케팅 동의</th><th>빠른 실행</th></tr></thead><tbody>{people.map(p => { const registration = registrations.get(p.id); return <tr key={p.id}><td><button className="person-name" onClick={() => setSelectedId(p.id)}><span className="avatar-small">{p.name?.slice(0, 1)}</span>{p.name}{(p.sample || p.source === 'sample' || p.tags?.includes('sample')) && <Badge>샘플</Badge>}</button></td><td><span>{p.email || '—'}</span><small>{p.phone}</small></td><td>{registration ? <select aria-label={`${p.name} 참가 상태`} disabled={!!pending} value={registration.status} onChange={e => act('UPDATE_REGISTRATION', { registrationId: registration.id, status: e.target.value })}>{Object.entries(statusNames).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : '미등록'}</td><td><label className="check-row"><input aria-label={`${p.name} 마케팅 동의`} type="checkbox" checked={getConsent(p.id)} disabled={!!pending} onChange={e => act('SET_CONSENT', { personId: p.id, granted: e.target.checked })} />{getConsent(p.id) ? '동의' : '미동의'}</label></td><td><Button quiet icon={CheckCheck} disabled={!!pending || !registration || registration.status !== 'registered'} onClick={() => act('UPDATE_REGISTRATION', { registrationId: registration.id, status: 'checked_in' })}>체크인</Button></td></tr>; })}</tbody></table>{!people.length && <Empty icon={Users} title={crm.people.length ? '검색 결과가 없습니다.' : '등록된 참가자가 없습니다.'}>오너가 입력하거나 가져온 참가자만 여기에 표시됩니다.</Empty>}</div></Panel>
    <Panel title="운영 업무" action={<Badge>{crm.tasks.filter(t => t.status !== 'done').length} open</Badge>}><div className="task-list">{crm.tasks.map(t => <label key={t.id}><input type="checkbox" checked={t.status === 'done'} disabled={!!pending} onChange={e => act('UPDATE_TASK', { taskId: t.id, status: e.target.checked ? 'done' : 'open' })} /><span className={t.status === 'done' ? 'complete' : ''}><strong>{t.title || t.name}</strong><small>{t.description || t.assignee || t.zoneId || ''}</small></span><Badge>{t.status === 'done' ? '완료' : '할 일'}</Badge></label>)}{!crm.tasks.length && <p className="help">CRM 배포 후 생성된 업무가 표시됩니다.</p>}</div></Panel>
    {modal === 'add' && <Modal title="참가자 등록" onClose={() => !pending && setModal(null)}><form onSubmit={add}><Field label="이름"><input name="name" required maxLength={100} autoFocus /></Field><Field label="이메일 (선택)"><input type="email" name="email" /></Field><Field label="전화번호 (선택)"><input type="tel" name="phone" /></Field><label className="check-row consent"><input type="checkbox" name="marketingConsent" /> 본인에게 받은 마케팅 동의를 기록합니다.</label><p className="help">체크하지 않아도 참가 등록은 가능합니다. 동의는 별도 이벤트로 저장합니다.</p><div className="form-actions"><Button primary icon={Plus} disabled={!!pending}>등록</Button></div></form></Modal>}
    {modal === 'import' && rows && <Modal title={`CSV 참가자 ${rows.length}명 검토`} wide onClose={() => !pending && setModal(null)}><p className="help">헤더: name, email, phone, marketingConsent · 동의는 true / 1 / yes / 동의만 인정합니다. 연락처 중복은 서버에서 제외합니다.</p><div className="table-scroll import-preview"><table><thead><tr><th>이름</th><th>이메일</th><th>전화번호</th><th>동의</th></tr></thead><tbody>{rows.slice(0, 20).map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.email}</td><td>{r.phone}</td><td>{r.marketingConsent ? '동의' : '미동의'}</td></tr>)}</tbody></table></div>{rows.length > 20 && <p className="help">앞 20행 미리보기 · 총 {rows.length}행을 가져옵니다.</p>}<label className="check-row consent"><input type="checkbox" checked={sample} onChange={e => setSample(e.target.checked)} /> 이 파일은 테스트용 샘플 데이터입니다.</label><div className="form-actions"><Button primary disabled={!!pending} icon={Upload} onClick={async () => { if (await act('IMPORT_PEOPLE', { rows, sample }, 'CSV 참가자 가져오기를 완료했습니다.')) { setModal(null); setRows(null); } }}>검토한 데이터 가져오기</Button></div></Modal>}
    {selected && <Modal title={selected.name} onClose={() => setSelectedId(null)}><div className="person-detail"><div className="context-row">이메일 <strong>{selected.email || '—'}</strong></div><div className="context-row">전화번호 <strong>{selected.phone || '—'}</strong></div><div className="context-row">참가 상태 <Badge>{statusNames[registrations.get(selected.id)?.status] || '미등록'}</Badge></div><h3>동의 이력</h3>{crm.consents.filter(c => c.personId === selected.id).map((c, i) => <p key={c.id || i}>{c.granted ? '동의' : '철회 / 미동의'} <small>{date(c.createdAt || c.at)}</small></p>)}<h3>활동 이력</h3>{crm.activities.filter(a => a.personId === selected.id || a.registrationId === registrations.get(selected.id)?.id).map((a, i) => <div key={a.id || i} className="activity-entry"><strong>{a.type || a.action}</strong><small>{date(a.createdAt || a.at)}</small><pre>{JSON.stringify(a, null, 2)}</pre></div>)}</div></Modal>}
  </>;
}

function Performance({ project, act, pending, navigate }) {
  const [showForm, setShowForm] = useState(false), [interval, setInterval] = useState(project.loop.intervalMinutes);
  useEffect(() => { setInterval(project.loop.intervalMinutes); }, [project.loop.intervalMinutes]);
  const observations = project.observations, last = observations.at(-1), proposals = project.loop.proposals || [];
  const clean = last && Number(last.completeness) >= 0.95 && Number(last.visitors) >= 30;
  const currentDeployment = project.crm.deployment?.inputRevision === project.inputRevision && project.crm.deployment?.candidateId === project.selectedId;
  const loopGate = !project.crm.deployment ? '먼저 CRM을 로컬 배포하세요.' : !last ? '관측 데이터를 먼저 기록하세요.' : !clean ? '오너 입력 완전성 95% 이상·방문자 30명 이상의 관측이 필요합니다. 수집 품질은 자동 검증되지 않습니다.' : !project.simulation || !currentDeployment || last.inputRevision !== project.inputRevision ? '현재 설계와 같은 리비전의 실험·배포·관측이 필요합니다.' : last.deploymentId !== project.crm.deployment.id || last.candidateId !== project.crm.deployment.candidateId ? '새 배포에 대한 관측이 필요합니다. 현재 운영안에서 다시 기록해 주세요.' : '';
  const intervalValid = Number.isInteger(Number(interval)) && Number(interval) >= 5 && Number(interval) <= 1440;
  return <><PageHeading eyebrow="OPERATIONS / OBSERVE · HYPOTHESIZE · COMPARE" title="현장 관측으로 다음 가설을 검토합니다." action={<Button primary icon={Plus} disabled={!!pending} onClick={() => setShowForm(s => !s)}>관측 데이터 기록</Button>}>오너 입력 관측값에 로컬 규칙을 적용해 변경 가설을 만들고, 미보정 시뮬레이션으로 비교합니다. 인과 추론이나 실제 성과 예측은 아닙니다.</PageHeading>
    {showForm && <ObservationForm deployment={project.crm.deployment} pending={pending} act={act} onDone={() => setShowForm(false)} />}
    <div className="stats-grid four"><Stat label="최근 관측 방문객" value={last ? `${fmt(last.visitors)}명` : '—'} /><Stat label="최근 관측 완료율" value={last ? `${fmt(last.visitors ? last.completed / last.visitors * 100 : 0, 1)}%` : '—'} /><Stat label="관측 P90 대기" value={last ? `${fmt(last.waitP90, 1)}분` : '—'} /><Stat label="자기신고 완전성" value={last ? `${fmt(last.completeness * 100)}%` : '—'} foot={last ? '오너 입력 커버리지 · 자동 검증 아님' : '아직 관측 데이터 없음'} /></div>
    <div className="performance-grid"><Panel title="관측 추이" eyebrow="OWNER-RECORDED DATA"><ObservationChart observations={observations} /><div className="table-scroll"><table><thead><tr><th>관측 구간</th><th>방문 / 완료</th><th>대기 P90</th><th>비용</th><th>자기신고 완전성</th></tr></thead><tbody>{[...observations].reverse().map((o, i) => <tr key={o.id || i}><td>{date(o.windowStart)}<small>~ {date(o.windowEnd)}</small></td><td>{fmt(o.visitors)} / {fmt(o.completed)}명</td><td>{fmt(o.waitP90, 1)}분</td><td>{won(o.cost)}</td><td><Badge tone={o.completeness >= 0.95 ? 'good' : 'warn'}>{fmt(o.completeness * 100)}%</Badge></td></tr>)}</tbody></table></div>{!observations.length && <Empty icon={Activity} title="아직 관측이 없습니다.">방문·완료·대기·동의·비용을 같은 관측 구간으로 기록하세요.</Empty>}</Panel>
      <Panel title="규칙 기반 개선 루프" eyebrow="UNCALIBRATED LOCAL RULES"><div className="loop-status"><span className={project.loop.enabled ? 'live-dot' : ''} />{project.loop.enabled ? '관측 기준 가설 생성 정책 켜짐' : '주기적 가설 계산 꺼짐'}<Badge>{project.loop.enabled ? 'ON' : 'OFF'}</Badge></div><p className="help">로컬 서버가 실행 중이고 관측 기준을 만족할 때만 주기적으로 규칙 기반 변경 가설을 계산합니다. 인과 분석·예측 검증은 아니며 외부 모델 호출·발송·승인·배포 없이 가설만 저장합니다.</p><Field label="가설 계산 간격 (분)"><input type="number" min="5" max="1440" value={interval} onChange={e => setInterval(e.target.value)} /></Field><div className="row-actions"><Button icon={project.loop.enabled ? Pause : Play} disabled={!!pending || !intervalValid || (!project.loop.enabled && !project.crm.deployment)} onClick={() => act('SET_LOOP_POLICY', { enabled: !project.loop.enabled, intervalMinutes: Number(interval) }, '규칙 기반 가설 계산 정책을 저장했습니다.')}>{project.loop.enabled ? '주기적 가설 계산 끄기' : '주기적 가설 계산 켜기'}</Button><Button quiet disabled={!!pending} onClick={() => act('SET_LOOP_POLICY', { enabled: project.loop.enabled, intervalMinutes: Number(interval) }, '가설 계산 간격을 저장했습니다.')}>간격 저장</Button></div><hr /><div className="context-row"><Clock size={14} />최근 가설 계산 {date(project.loop.lastRunAt)}</div><Button primary icon={Sparkles} disabled={!!pending || !!loopGate} onClick={() => act('RUN_LOOP', {}, '현재 관측에 로컬 규칙을 적용해 변경 가설을 계산했습니다. 오너 입력값과 미보정 비교 결과를 검토해 주세요.')}>지금 가설 계산</Button><p className={`help ${last && !clean ? 'warning-text' : ''}`}>{loopGate || "입력 문턱 충족 · 미보정 가설만 생성하며 자동 배포하지 않습니다."}</p></Panel></div>
    <Panel title="규칙 기반 변경 가설" eyebrow="HYPOTHESIS → OWNER REVIEW" action={<Badge>{proposals.length} hypotheses</Badge>}><div className="proposal-list">{[...proposals].reverse().map((p, i) => <article key={p.id || i}><div><Badge tone={p.status === 'applied' || p.appliedAt ? 'good' : ''}>{p.status === 'applied' || p.appliedAt ? '채택됨' : p.status || '검토 대기'}</Badge><small>{date(p.createdAt || p.at)}</small></div><h3>{p.title || p.summary || `변경 가설 ${proposals.length - i}`}</h3>{p.hypothesis && <p>{p.hypothesis}</p>}{p.reason && <p>{p.reason}</p>}{p.description && <p>{p.description}</p>}<details><summary>변경 조건 · 미보정 계산 근거</summary><pre>{JSON.stringify(p, null, 2)}</pre></details><Button icon={Check} disabled={!!pending || !p.id || !!p.appliedAt || p.status === 'applied' || p.status !== "pending"} onClick={async () => { if (await act('APPLY_PROPOSAL', { proposalId: p.id }, '가설 조건을 채택했습니다. 새 안을 생성·실험한 뒤 다시 승인해 주세요. 기존 CRM 배포는 보존됩니다.')) navigate('space'); }}>가설 채택 · 재실험 준비</Button></article>)}</div>{!proposals.length && <Empty icon={Sparkles} title="아직 변경 가설이 없습니다.">관측을 기록한 후 규칙 기반 가설 계산을 실행하세요. 가설은 검증된 개선 효과가 아니며 자동 배포되지 않습니다.</Empty>}</Panel>
    <div className="callout"><ShieldCheck size={18} /><p>오너 입력 관측 → 자기신고 완전성 문턱 → 로컬 규칙 기반 가설 → 미보정 비교 → 오너 채택·재실험·승인 → CRM 갱신. 채택만으로 운영 중인 CRM이나 고객 동의가 변경되지 않습니다.</p></div>
  </>;
}

function ObservationForm({ deployment, act, pending, onDone }) {
  const [values, setValues] = useState(() => ({ visitors: '', completed: '', waitP90: '', consents: '', cost: '', completeness: '', notes: '', ...initialObservationWindow(deployment) }));
  async function submit(e) { e.preventDefault(); const data = { ...values, ...Object.fromEntries(['visitors', 'completed', 'waitP90', 'consents', 'cost', 'completeness'].map(k => [k, Number(values[k])])), windowStart: new Date(values.windowStart).toISOString(), windowEnd: new Date(values.windowEnd).toISOString() }; if (await act('ADD_OBSERVATION', data, '현장 관측을 저장했습니다.')) onDone(); }
  return <Panel title="현장 관측 기록"><form onSubmit={submit}><fieldset disabled={!!pending}><p className="help observation-time-help">시작 시각은 기본적으로 최근 1시간과 현재 CRM 배포 시각 중 늦은 때입니다. 더 이른 과거 관측은 저장할 수 있지만 현재 배포의 성과로 연결되지 않습니다.</p><div className="form-grid four"><Field label="관측 시작"><input required type="datetime-local" step="0.001" value={values.windowStart} onChange={e => setValues(s => ({ ...s, windowStart: e.target.value }))} /></Field><Field label="관측 종료"><input required type="datetime-local" step="0.001" value={values.windowEnd} onChange={e => setValues(s => ({ ...s, windowEnd: e.target.value }))} /></Field><Numeric label="방문객 (명)" name="visitors" values={values} setValues={setValues} /><Numeric label="체험 완료 (명)" name="completed" values={values} setValues={setValues} /><Numeric label="대기 P90 (분)" name="waitP90" values={values} setValues={setValues} /><Numeric label="마케팅 동의 (명)" name="consents" values={values} setValues={setValues} /><Numeric label="해당 구간 비용 (원)" name="cost" values={values} setValues={setValues} /><Numeric label="자기신고 완전성 (0–1)" name="completeness" values={values} setValues={setValues} max={1} help="오너가 입력한 관측 커버리지 · 시스템이 수집 품질을 검증하지 않음" /><Field className="span-all" label="근거 · 특이사항"><textarea value={values.notes} rows={2} onChange={e => setValues(s => ({ ...s, notes: e.target.value }))} placeholder="입장 카운터·체험 기록 등 수집 근거와 누락 사항" /></Field></div><div className="form-actions"><Button primary icon={Check}>관측 저장</Button></div></fieldset></form></Panel>;
}
function ObservationChart({ observations }) {
  if (!observations.length) return null;
  const recent = observations.slice(-12), max = Math.max(1, ...recent.map(o => o.visitors)), w = 660 / recent.length;
  return <div className="observation-chart"><svg viewBox="0 0 740 220" role="img" aria-label="최근 관측의 방문객과 완료 인원"><path d="M42 20V180H720" stroke="#dbe0e6" fill="none" />{recent.map((o, i) => <g key={o.id || i}><rect x={52 + i * w} y={180 - o.visitors / max * 150} width={Math.min(24, w * 0.3)} height={o.visitors / max * 150} fill="#d8e5c5" /><rect x={54 + i * w + Math.min(24, w * 0.3)} y={180 - o.completed / max * 150} width={Math.min(24, w * 0.3)} height={o.completed / max * 150} fill="#76b900" /><text x={52 + i * w} y="202">{i + 1}</text></g>)}<text x="2" y="35">{fmt(max)}</text><text x="20" y="181">0</text></svg><div className="chart-legend"><span><i className="pale" />방문</span><span><i />완료</span><small>가로축: 최근 관측 순서</small></div></div>;
}
