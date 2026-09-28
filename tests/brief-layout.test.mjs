import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createProject } from '../server/domain.mjs';
import { analyzeArea } from '../server/research.mjs';

const appSource = await readFile(new URL('../client/App.jsx', import.meta.url), 'utf8');
const compiled = await build({
  stdin: {
    contents: `${appSource}\nexport { BriefForm as BriefFormForTest, BuildCRM as BuildCRMForTest, People as PeopleForTest, ObservationForm as ObservationFormForTest, Performance as PerformanceForTest };`,
    resolveDir: fileURLToPath(new URL('../client/', import.meta.url)),
    sourcefile: 'App.jsx', loader: 'jsx',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react'], jsx: 'automatic', loader: { '.css': 'empty' },
});
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const { Brief, BriefFormForTest, BuildCRMForTest, PeopleForTest, ObservationFormForTest, PerformanceForTest, initialObservationWindow } = compiledModule.exports;
function render(project = createProject('Brief 회귀 테스트'), extras = {}) {
  const unexpectedAction = () => { throw new Error('Rendering must not invoke an API or mutation.'); };
  return renderToStaticMarkup(React.createElement(Brief, {
    project, pending: '', health: { modelConfigured: true },
    act: unexpectedAction, mutate: unexpectedAction, upload: unexpectedAction,
    navigate: unexpectedAction, ...extras,
  }));
}

test('Brief leads with agent control while retaining real map evidence and shortcuts', () => {
  const html = render();
  assert.match(html, /brief-layout brief-workspace/);
  assert.ok(html.indexOf('Business Brief 에이전트 대화') < html.indexOf('지도와 에이전트 도구 결과'));
  assert.match(html, /성수동 실제 지도/);
  assert.match(html, /© OpenStreetMap contributors/);
  assert.match(html, /id="brief-control-tab" aria-selected="true"/);
  assert.match(html, /id="brief-map-result"[^>]* hidden=""/);
  assert.match(html, /id="brief-research-result"[^>]* hidden=""/);
  for (const label of ['목표 편집', '주변 상권 분석', '16개 안 생성', '시뮬레이션 실행', '운영 데이터 검토', '공간과 제약', '여러 안 비교', 'CRM 빌드']) assert.ok(html.includes(label));
  assert.match(html, /<details class="brief-project-context"><summary>/);
});

test('first conversation offers real space fields before candidate execution', () => {
  const html = render();
  assert.match(html, /needs-space/);
  assert.match(html, /aria-label="대화에서 공간 설정"/);
  for (const label of ['공간 구조', '가로 (m)', '세로 (m)', '높이 (m)', '운영 인력 (명)', '체험·서비스 구역 (개)', '공간 확인 · 저장', '채팅 입력 예시']) assert.ok(html.includes(label));
  assert.match(html, /class="btn primary" disabled=""/);
});

test('prepared demo shows provenance and next actions without asking for measured demo dimensions', () => {
  const project = createProject('예시 비즈니스');
  project.demo = { synthetic: true };
  project.space.confirmed = true;
  const html = render(project, { health: { modelConfigured: true, provider: { provider: 'nvidia', connectionId: 'test' } } });
  assert.match(html, /예시 비즈니스 · 합성 입력/);
  assert.match(html, /NVIDIA 에이전트/);
  assert.match(html, /맥락 전송에 동의하고 에이전트 켜기/);
  assert.doesNotMatch(html, /aria-label="대화에서 공간 설정"/);
  assert.match(html, /공간 조건 검토/);
});

test('Brief keeps model opt-in and image selection disabled by default, without rendering side effects', () => {
  const project = createProject('사진 테스트');
  project.attachments = [{ id: 'photo-1', name: '실측 공간.jpg' }];
  const html = render(project);
  assert.match(html, /외부 모델 전송 없음/);
  assert.match(html, /실측 공간.jpg/);
  assert.match(html, /<input type="checkbox" disabled=""\/>/);
  assert.doesNotMatch(html, /checked=""[^>]*\/>(?: 모델 사용)/);
  assert.match(html, /aria-label="공간 사진 업로드"/);
});

test('model consent discloses project context, same-connection history, tool results and optional photos', () => {
  const html = render();
  for (const phrase of ['비즈니스 목표·위치·공간·실험·최근 관측', '이전에 동의해 전송한 대화 최대 8건', '도구 실행 결과', 'CRM 고객 연락처 필드는 제외', '목표나 대화에 직접 적은 개인정보', '사진은 별도 선택·동의']) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /id="model-data-disclosure"/);
  assert.match(html, /aria-describedby="model-data-disclosure"/);
  assert.match(html, /모델 사용 · 맥락 전송 동의/);
  assert.doesNotMatch(html, /텍스트와 선택한 사진만 전송/);
});

test('Brief renders saved research evidence only for the current input revision', () => {
  const project = createProject('리서치 테스트');
  project.research = analyzeArea(project);
  project.research.tools[0].summary = '현재 입력에 연결된 분석 근거';
  assert.match(render(project), /현재 입력에 연결된 분석 근거/);
  project.research.inputRevision -= 1;
  const stale = render(project);
  assert.doesNotMatch(stale, /현재 입력에 연결된 분석 근거/);
  assert.match(stale, /입력이 변경됨 · 재분석 필요/);
});

test('Brief keeps mutation controls disabled while a request is pending', () => {
  const html = render(undefined, { pending: '저장 중' });
  assert.match(html, /disabled="" class="btn primary[^"]*"[^>]*>[\s\S]*?상권·접근성 분석/);
  assert.match(html, /aria-label="에이전트에게 메시지"[^>]*disabled=""/);
  assert.match(html, /aria-label="공간 사진 업로드" disabled=""/);
});

test('Agent Brief prioritizes conversation without changing storyboard sidebar widths', async () => {
  const css = await readFile(new URL('../client/brief-layout.css', import.meta.url), 'utf8');
  assert.match(css, /\.brief-artifact-view\[hidden\] \{ display: none; \}/);
  const agentCss = await readFile(new URL('../client/agent-workspace.css', import.meta.url), 'utf8');
  assert.match(agentCss, /grid-template-columns: minmax\(0, 1\.35fr\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(agentCss, /--sidebar-width:|\.sidebar\s*\{/);
  assert.match(agentCss, /@media \(max-width: 900px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(agentCss, /\.brief-page\.agent-mode \.chat-panel \{ overflow: hidden; \}/);
  assert.match(agentCss, /\.brief-page\.agent-mode \.chat-history \{[^}]*min-height: 96px;/);
  assert.match(agentCss, /\.brief-page\.agent-mode \.composer \{[^}]*flex: 0 1 auto; overflow-y: auto;/);
  const source = await readFile(new URL('../client/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /if \(useModel && imageIds\.length > 0 && \(!imageConsent \|\| !supportsImages\)\) return;/);
  assert.match(source, /disabled=\{!useModel \|\| !supportsImages/);
});

test('Brief goal form keeps its labeled fields and disables save while pending', () => {
  const project = createProject('목표 여백 테스트');
  const html = renderToStaticMarkup(React.createElement(BriefFormForTest, {
    project, pending: '저장 중', act: () => assert.fail('SSR must not submit the goal form'),
  }));
  assert.match(html, /<form class="panel brief-form">/);
  for (const label of ['비즈니스 이름', '지역 · 장소', '핵심 목표', '목표 저장']) assert.ok(html.includes(label));
  assert.equal((html.match(/<input /g) || []).length, 2);
  assert.equal((html.match(/<textarea /g) || []).length, 1);
  assert.match(html, /<button disabled="" class="btn primary/);
});

test('Brief goal form padding targets the panel itself and stacks fields on narrow screens', async () => {
  const css = await readFile(new URL('../client/brief-layout.css', import.meta.url), 'utf8');
  assert.match(css, /\.brief-page \.panel\.brief-form\s*\{\s*padding: 19px;/);
  assert.match(css, /\.brief-page \.brief-form > \.form-grid\s*\{\s*gap: 16px 18px;/);
  assert.match(css, /\.brief-page \.brief-form > \.form-actions\s*\{\s*margin-top: 18px;/);
  const narrow = css.slice(css.lastIndexOf('@media (max-width: 760px)'));
  assert.match(narrow, /\.brief-page \.panel\.brief-form\s*\{\s*padding: 18px;/);
  assert.match(narrow, /\.brief-page \.brief-form > \.form-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(narrow, /\.brief-page \.brief-form \.span-two\s*\{\s*grid-column: auto;/);
  assert.match(narrow, /\.brief-page \.brief-form > \.form-actions > \.btn\s*\{\s*width: 100%;/);
});

test('saved assistant Markdown renders as semantic content inside a padded chat message', async () => {
  const project = createProject('Markdown 답변');
  project.messages.push({ id: 'answer-1', role: 'assistant', mode: 'model', content: '# 도구 호출 현황\n\n- `get_project`: **읽기 전용** 조회\n- 두 번째 항목\n\n<script>alert(1)</script>\n<svg onload="alert(1)"></svg>\n\n![remote](https://example.com/a.png)\n\n[unsafe](javascript:alert(1)) [data](data:text/html,bad)' });
  const html = render(project);
  assert.match(html, /class="message-text markdown-message"><div class="markdown-body"><h1>도구 호출 현황<\/h1>/);
  assert.match(html, /<li><code>get_project<\/code>: <strong>읽기 전용<\/strong> 조회<\/li>/);
  const markdown = html.match(/<div class="markdown-body">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(markdown);
  assert.doesNotMatch(markdown, /<script>|<svg |<img |href="(?:javascript|data):/i);
  const css = await readFile(new URL('../client/agent-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.assistant \.message-text\.markdown-message \{[^}]*padding: 14px 16px;/);
  assert.match(css, /\.markdown-body pre \{[^}]*overflow: auto;/);
});

test('observation defaults begin no earlier than CRM deployment and retain millisecond precision', () => {
  const now = Date.parse('2026-09-28T08:00:00.123Z');
  const recent = Date.parse('2026-09-28T07:59:30.456Z');
  const recentDefaults = initialObservationWindow({ appliedAt: new Date(recent).toISOString() }, now);
  assert.equal(new Date(recentDefaults.windowStart).getTime(), recent);
  assert.equal(new Date(recentDefaults.windowEnd).getTime(), now);
  const oldDefaults = initialObservationWindow({ appliedAt: '2026-09-27T08:00:00.000Z' }, now);
  assert.equal(new Date(oldDefaults.windowStart).getTime(), now - 3600000);
  assert.equal(new Date(initialObservationWindow(null, now).windowStart).getTime(), now - 3600000);
  const html = renderToStaticMarkup(React.createElement(ObservationFormForTest, { deployment: { appliedAt: new Date(Date.now() - 30000).toISOString() }, pending: '', act: () => assert.fail('SSR must not save') }));
  assert.equal((html.match(/step="0\.001"/g) || []).length, 2);
  assert.match(html, /자기신고 완전성/);
  assert.match(html, /현재 배포의 성과로 연결되지 않습니다/);
});

test('performance copy identifies uncalibrated local rules and owner-entered completeness', () => {
  const project = createProject('규칙 루프 문구');
  project.loop.enabled = true;
  const html = renderToStaticMarkup(React.createElement(PerformanceForTest, { project, pending: '', act: () => assert.fail('SSR must not run') }));
  for (const phrase of ['규칙 기반 개선 루프', '관측 기준 가설 생성', '자기신고 완전성', '미보정 시뮬레이션', '인과 분석·예측 검증은 아니며']) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html, /자율 연구 정책|서버 실행 중 주기적으로 연구/);
});

test('preserved CRM deployment is visibly separated from a new unapproved design', () => {
  const project = createProject('이전 배포 보존');
  project.crm.deployment = {
    id: 'D-old', inputRevision: project.inputRevision - 1, approvalId: 'A-old', candidateId: 'B',
    schema: { id: 'S-old', inputRevision: project.inputRevision - 1, candidateId: 'B', zones: [], slots: [], views: [], automation: [] },
  };
  const props = { project, act: () => assert.fail('SSR must not mutate'), pending: '', navigate: () => assert.fail('SSR must not navigate'), setNotice: () => {} };
  const brief = render(project);
  const build = renderToStaticMarkup(React.createElement(BuildCRMForTest, props));
  const people = renderToStaticMarkup(React.createElement(PeopleForTest, props));
  for (const html of [brief, build, people]) assert.match(html, /이전 승인안 로컬 운영 중|기존 배포 B안/);
  assert.match(build, /현재 설계 재검토 필요/);
  assert.match(build, /prior-deployment/);
  assert.match(people, /기존 로컬 CRM 배포에 기록됩니다/);
  assert.doesNotMatch(build, /현재 승인안 로컬 운영 중/);
});
