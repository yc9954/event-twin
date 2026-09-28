import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/http.mjs';
import { createDomain, createProject } from '../server/domain.mjs';
import { initializeDemoProject } from '../server/demo-project.mjs';
import { generateCandidates, runBatch } from '../shared/simulation.mjs';
import { analyzeArea } from '../server/research.mjs';
import { runAgent, localCommands } from '../server/agent.mjs';
const domain = createDomain({ generateCandidates, runBatch, analyzeArea });

test('demo computes a self-contained synthetic project without approval, people, or model calls', () => {
  const a = initializeDemoProject(createProject('예시 비즈니스'), domain);
  const b = initializeDemoProject(createProject('두 번째 예시'), domain);
  assert.notEqual(a.id, b.id);
  assert.equal(a.demo.synthetic, true);
  assert.equal(a.space.confirmed, true);
  assert.equal(a.candidates.length, 16);
  assert.equal(a.simulation.results.length, 16);
  assert.equal(a.simulation.inputRevision, a.inputRevision);
  assert.ok(a.research.facilities.length > 0);
  assert.equal(a.approval, null);
  assert.equal(a.crm.deployment, null);
  assert.deepEqual(a.crm.people, []);
  assert.deepEqual(a.messages, []);
  a.space.width = 30;
  assert.equal(b.space.width, 24);
  assert.deepEqual(domain.context(a).demo, { template: 'seongsu-business-v1', synthetic: true });
});

test('unconfirmed generation and retry guide to space card without failed tool receipts', async () => {
  const project = createProject();
  for (const message of ['확인한 공간 조건으로 16개 후보 안을 생성해줘.', '다시', '시뮬레이션 실행']) {
    const result = await runAgent({ project, message, executeTool: () => assert.fail('must not execute') });
    assert.deepEqual(result.steps, []);
    assert.match(result.reply, /공간 설정 카드/);
    assert.equal(project.space.confirmed, false);
  }
});

test('chat can propose all space parameters but only the owner confirms', async () => {
  const project = createProject();
  const command = '30×20m 중정 높이 4m 부스 4개 인력 8명';
  assert.equal(localCommands(command).length, 1);
  await runAgent({ project, message: command, executeTool: (n, a) => domain.executeTool(project, n, a) });
  assert.equal(project.space.width, 30);
  assert.equal(project.space.family, 'courtyard');
  assert.equal(project.space.staff, 8);
  assert.equal(project.space.confirmed, false);
  domain.applyAction(project, 'UPDATE_SPACE', { confirmed: true });
  const result = await runAgent({ project, message: '16개 안 생성', executeTool: (n, a) => domain.executeTool(project, n, a) });
  assert.equal(result.steps[0].status, 'complete');
  assert.equal(project.candidates.length, 16);
});

test('HTTP demo creation persists independent results, validates template, and preserves blank behavior', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'business-onboarding-'));
  const app = await createAppServer({ dataDir: dir, port: 0, scheduler: false });
  const address = await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}/api/projects`;
  const create = body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await create({ name: '예시', template: 'demo' });
  assert.equal(response.status, 201);
  const { project } = await response.json();
  const stored = (await (await fetch(base + '/' + project.id)).json()).project;
  assert.equal(stored.simulation.results.length, 16);
  const blank = (await (await create({ name: '직접 시작', template: 'blank' })).json()).project;
  assert.equal(blank.space.confirmed, false);
  assert.equal(blank.simulation, null);
  assert.equal((await create({ name: 'bad', template: 'owner-project-id' })).status, 400);
});
