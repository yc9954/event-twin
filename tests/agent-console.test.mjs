import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { agentBlueprint } from '../shared/agent-blueprint.mjs';
import { agentTools, localCommands, sanitizeAgentEvent } from '../server/agent.mjs';

const compiled = await build({ entryPoints: [new URL('../client/AgentConsole.jsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react'], jsx: 'automatic', loader: { '.css': 'empty' } });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { AgentRunTrace, AgentInspector, normalizeAgentTrace, agentToolCatalog, agentLifecycle, deploymentRelation } = mod.exports;
const renderTrace = props => renderToStaticMarkup(React.createElement(AgentRunTrace, props));
const project = { inputRevision: 3, space: { confirmed: false }, candidates: [], crm: {} };
const at = second => `2026-09-28T01:00:0${second}.000Z`;

test('live and saved fallback records clearly identify Claude rather than NVIDIA', () => {
  const receipt = { from: 'nvidia', to: 'anthropic', model: 'claude-sonnet-4-6', reason: 'MODEL_REQUEST_FAILED', round: 2 };
  const live = renderTrace({ mode: 'model', events: [sanitizeAgentEvent({ type: 'model.fallback', ...receipt })], active: true });
  assert.match(live, /NVIDIA → Claude fallback/);
  const saved = renderTrace({ mode: 'model', modelContext: { inputRevision: 1, fallback: receipt } });
  assert.match(saved, /Claude fallback 응답/);
  assert.match(saved, /claude-sonnet-4-6/);
  assert.match(saved, /완료한 도구는 재실행하지 않았습니다/);
});

test('real server sanitizer and rendered web trace share the same event contract', () => {
  const stepId = '00000000-1111-2222-3333-444444444444';
  const receipts = [
    sanitizeAgentEvent({ type: 'request.accepted', mode: 'local' }),
    sanitizeAgentEvent({ type: 'tool.started', name: 'propose_space', stepId, inputSummary: { width: 24, depth: 18, secret: 'not-for-ui' } }),
    sanitizeAgentEvent({ type: 'tool.completed', name: 'propose_space', stepId }),
  ];
  const rows = normalizeAgentTrace([], receipts);
  assert.equal(rows.filter(row => row.kind === 'tool').length, 1);
  assert.equal(rows.find(row => row.kind === 'tool').status, 'complete');
  assert.equal(rows.find(row => row.kind === 'tool').stepId, stepId);
  const html = renderTrace({ events: receipts, active: true });
  assert.match(html, /공간 초안/);
  assert.match(html, /1개 도구 기록/);
  assert.doesNotMatch(html, /not-for-ui/);
});
const events = [
  { type: 'request.accepted', requestId: 'r1', sequence: 1, at: at(0), committed: false },
  { type: 'tool.started', requestId: 'r1', sequence: 2, at: at(1), committed: false, stepId: 's1', name: 'analyze_area', inputSummary: { radius: 500 } },
  { type: 'tool.completed', requestId: 'r1', sequence: 3, at: at(2), committed: false, stepId: 's1', name: 'analyze_area', status: 'complete' },
];
function buttons(element) {
  if (Array.isArray(element)) return element.flatMap(buttons);
  if (!React.isValidElement(element)) return [];
  return [...(element.type === 'button' ? [element] : []), ...buttons(element.props.children)];
}
function text(element) {
  if (typeof element === 'string') return element;
  if (Array.isArray(element)) return element.map(text).join('');
  return React.isValidElement(element) ? text(element.props.children) : '';
}

test('central catalog exactly matches the eight allowed agent tools and supported local prompts', () => {
  const catalog = agentToolCatalog();
  assert.equal(catalog.length, 8);
  assert.deepEqual(catalog.map(t => t.name), agentTools.map(t => t.name));
  for (const tool of catalog) {
    assert.equal(tool.label, agentBlueprint.tools.find(t => t.name === tool.name).label);
    if (tool.prompt) assert.equal(localCommands(tool.prompt)[0]?.[0], tool.name, tool.prompt);
  }
  assert.equal(catalog.find(t => t.name === 'update_assumptions').prompt, null);
});

test('inspector tool buttons only populate a prompt or navigate; they never execute a tool', () => {
  const prompts = [], routes = [];
  const tree = AgentInspector({ project, onPrompt: value => prompts.push(value), navigate: value => routes.push(value) });
  const actions = buttons(tree);
  assert.equal(prompts.length, 0);
  assert.equal(routes.length, 0);
  for (const button of actions) button.props.onClick();
  assert.deepEqual(prompts, agentToolCatalog().filter(t => t.prompt).map(t => t.prompt));
  assert.deepEqual(routes, ['space']);
});

test('approval review is offered only after simulation and before owner approval', () => {
  const routes = [], fixture = { ...project, simulation: { inputRevision: 3, results: [{}] } };
  const tree = AgentInspector({ project: fixture, navigate: value => routes.push(value) });
  const review = buttons(tree).find(button => text(button) === '승인 검토');
  assert.ok(review);
  review.props.onClick();
  assert.deepEqual(routes, ['compare']);
  assert.ok(!buttons(AgentInspector({ project, navigate() {} })).some(button => text(button) === '승인 검토'));
  assert.ok(!buttons(AgentInspector({ project: { ...fixture, approval: { inputRevision: 3 } }, navigate() {} })).some(button => text(button) === '승인 검토'));
});

test('lifecycle readiness reflects actual input revisions, not a fabricated execution plan', () => {
  assert.equal(agentLifecycle(project).filter(row => row.status === 'complete').length, 0);
  const rows = agentLifecycle({ ...project, research: { inputRevision: 2 }, space: { confirmed: true }, candidates: [{ id: 'A' }], simulation: { inputRevision: 3, results: [{}] }, crm: { deployment: { inputRevision: 2 } } });
  assert.equal(rows.find(row => row.id === 'research').status, 'unconfirmed');
  assert.equal(rows.find(row => row.id === 'simulation').status, 'complete');
  assert.equal(rows.find(row => row.id === 'approval').status, 'pending');
  assert.equal(rows.find(row => row.id === 'deployment').status, 'unconfirmed');
});

test('deployment readiness compares the approved schema, not merely a matching input revision', () => {
  const deployment = { inputRevision: 3, candidateId: 'A', approvalId: 'APP-old', schema: { id: 'SCHEMA-old' } };
  const fixture = { ...project, selectedId: 'A', approval: null, crm: { deployment, schema: null } };
  assert.equal(deploymentRelation(fixture).current, false);
  assert.match(agentLifecycle(fixture).find(item => item.id === 'deployment').detail, /현재 설계 재검토 필요/);
  assert.equal(agentLifecycle(fixture).find(item => item.id === 'deployment').status, 'unconfirmed');
  fixture.approval = { id: 'APP-current', inputRevision: 3, candidateId: 'A' };
  fixture.crm.schema = { id: 'SCHEMA-current', approvalId: 'APP-current' };
  assert.equal(deploymentRelation(fixture).current, false);
  deployment.approvalId = 'APP-current';
  deployment.schema.id = 'SCHEMA-current';
  assert.equal(deploymentRelation(fixture).current, true);
  assert.equal(agentLifecycle(fixture).find(item => item.id === 'deployment').status, 'complete');
});

test('dot-named streaming events merge by step ID and remain chronological', () => {
  const rows = normalizeAgentTrace([], events);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'run_started');
  assert.equal(rows[1].name, 'analyze_area');
  assert.equal(rows[1].status, 'complete');
  assert.deepEqual(rows[1].input, { radius: 500 });
  assert.equal(rows[1].inputIsSummary, true);
  assert.equal(rows[1].startedAt, at(1));
  assert.equal(rows[1].finishedAt, at(2));
  assert.ok(!Object.hasOwn(rows[1], 'output'));
});

test('terminal committed response upgrades summaries to real saved input and output without duplicate steps', () => {
  const saved = { id: 's1', name: 'analyze_area', input: { lat: 37.54 }, output: { count: 12 }, status: 'complete', startedAt: at(1), finishedAt: at(2) };
  const complete = [...events, { type: 'response.completed', at: at(3), status: 200, committed: true, data: { steps: [saved] } }];
  const rows = normalizeAgentTrace([saved], complete), tools = rows.filter(row => row.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].output, { count: 12 });
  assert.equal(tools[0].inputIsSummary, false);
  const html = renderTrace({ events: complete });
  assert.match(html, /요청 저장 완료/);
  assert.match(html, /&quot;count&quot;: 12/);
  assert.doesNotMatch(html, /미저장/);
});

test('failed transaction distinguishes tool execution from saved changes', () => {
  const failed = [...events, { type: 'response.failed', at: at(3), committed: false, status: 409, error: '프로젝트 버전 충돌' }];
  const html = renderTrace({ events: failed, active: false });
  assert.match(html, /실패 · 미저장/);
  assert.match(html, /실행됨 · 미저장/);
  assert.match(html, /변경 사항은 저장되지 않았습니다/);
  assert.match(html, /프로젝트 버전 충돌/);
});

test('stream interruption never claims rollback or success when commit is unknown', () => {
  const html = renderTrace({ events, error: { message: '연결 중단', code: 'STREAM_INTERRUPTED', committed: null } });
  assert.match(html, /저장 여부 미확인/);
  assert.match(html, /프로젝트 상태를 새로 확인/);
  assert.doesNotMatch(html, /실행됨 · 미저장|실패 · 미저장|요청 저장 완료/);
});

test('legacy underscore events, nested payloads and repeated tool calls remain distinct', () => {
  const rows = normalizeAgentTrace([], [
    { type: 'tool_started', data: { stepId: 'a', name: 'get_project', input: {} }, at: at(0) },
    { type: 'tool_completed', stepId: 'a', name: 'get_project', output: { n: 1 }, at: at(1) },
    { type: 'tool_started', stepId: 'b', name: 'get_project', at: at(2) },
    { type: 'tool_failed', stepId: 'b', name: 'get_project', error: '오류', at: at(3) },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.status), ['complete', 'failed']);
});

test('empty trace creates no fake tools; model awaiting and payload escaping are supported', () => {
  assert.equal(renderTrace({}), '');
  const active = renderTrace({ active: true });
  assert.match(active, /0개 도구 기록/);
  assert.doesNotMatch(active, /agent-trace-item/);
  assert.match(renderTrace({ events: [{ type: 'model.awaiting', at: at(1) }], active: true }), /모델 응답 대기/);
  const html = renderTrace({ steps: [{ name: 'get_project', status: 'failed', input: '<script>oops()</script>', error: '실패' }] });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('saved model context and public intermediate messages survive as inspectable UI without private reasoning claims', () => {
  const html = renderTrace({ mode: 'model', modelContext: { inputRevision: 3, historyMessages: 2, availableTools: 8, selectedImages: 0 }, modelActivity: [{ round: 1, text: '## 위치를 살핍니다.\n- **근거** 확인', toolNames: ['analyze_area'] }] });
  assert.match(html, /입력 r3/);
  assert.match(html, /동의된 이전 대화 2건/);
  assert.match(html, /analyze_area/);
  assert.match(html, /<h2>위치를 살핍니다\.<\/h2>/);
  assert.match(html, /<strong>근거<\/strong>/);
  assert.match(html, /비공개 추론 원문은 제공되지 않습니다/);
});

test('nullable or malformed imported model activity cannot crash the execution record', () => {
  assert.match(renderTrace({ mode: 'model', modelContext: {}, modelActivity: null }), /비공개 추론 원문은 제공되지 않습니다/);
  assert.doesNotThrow(() => renderTrace({ mode: 'model', modelContext: {}, modelActivity: [{ round: 1, toolNames: 'not-an-array', text: 'ignored' }] }));
});

test('runtime summary consumes actual health schema without claiming verified provider or active isolation', () => {
  const runtime = {
    mode: 'local-direct', blueprint: { id: 'event-twin-web', version: '1.0.0' },
    sandbox: { connected: false, provider: 'OpenShell', status: 'not-connected' },
    inference: { provider: 'OpenAI', model: 'configured-model', configured: true, verified: false },
    contextHook: 'before_prompt_build', policy: agentBlueprint.policy, upstream: agentBlueprint.upstream,
    limits: agentBlueprint.limits,
  };
  const html = renderToStaticMarkup(React.createElement(AgentInspector, { project, runtime, health: { modelConfigured: true } }));
  for (const expected of ['AGENT CONTROL', '로컬 직접 실행', 'OpenShell', '미연결', '키 설정됨 · 호출 미검증', 'configured-model', 'before_prompt_build', 'event-twin-web', 'runtime-context.ts']) assert.ok(html.includes(expected));
  assert.doesNotMatch(html, /호출 확인됨|샌드박스 활성/);
  assert.match(html, /격리된 샌드박스가 아닙니다/);
});

test('pending inspector disables actions and reports model awaiting without executing anything', () => {
  const tree = AgentInspector({ project, pending: '실행 중', events: [{ type: 'model.awaiting' }], navigate() {}, onPrompt() {} });
  assert.ok(buttons(tree).every(button => button.props.disabled === true));
  assert.match(renderToStaticMarkup(tree), /모델 응답 대기/);
});

test('agent console surface styles remain scoped and provide real internal padding', async () => {
  const css = await readFile(new URL('../client/agent-console.css', import.meta.url), 'utf8');
  assert.match(css, /\.agent-console-section \{ padding: 16px 18px;/);
  assert.match(css, /\.agent-payload pre[^}]*padding: 14px;/);
  assert.doesNotMatch(css, /(?:^|\n)(?:body|\.sidebar|\.brief-workspace|\.panel|button)\s*\{/);
});
