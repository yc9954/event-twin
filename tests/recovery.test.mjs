import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/http.mjs';

test('lost replies at planning, deployment and adoption recover without duplicate effects', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'event-twin-recovery-'));
  let app;
  let url;
  let project;
  async function start() {
    app = await createAppServer({ dataDir, port: 0, scheduler: false });
    const address = await app.listen();
    url = `http://127.0.0.1:${address.port}`;
  }
  async function request(path, body) {
    const response = await fetch(url + path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function refresh() {
    const response = await request(`/api/projects/${project.id}`);
    assert.equal(response.status, 200);
    project = response.data.project;
  }
  async function action(type, payload = {}) {
    const response = await request(`/api/projects/${project.id}/actions`, {
      type, payload, expectedVersion: project.version,
    });
    assert.equal(response.status, 200, `${type}: ${JSON.stringify(response.data)}`);
    project = response.data.project;
    return response.data;
  }
  // A client that loses a successful response still knows its old version. It
  // retries once with that version, observes 409, then fetches committed state.
  async function loseReplyAndRecover(type, payload = {}) {
    const version = project.version;
    const path = `/api/projects/${project.id}/actions`;
    const body = { type, payload, expectedVersion: version };
    const committed = await request(path, body);
    assert.equal(committed.status, 200, `${type}: ${JSON.stringify(committed.data)}`);
    const retry = await request(path, body);
    assert.equal(retry.status, 409, `${type} replay must not commit twice`);
    assert.equal(retry.data.code, 'VERSION_CONFLICT');
    await refresh();
    assert.deepEqual(project, committed.data.project);
    assert.equal(project.version, version + 1);
  }
  const auditCount = (type) => project.audit.filter(entry => entry.action === type).length;

  try {
    await start();
    const created = await request('/api/projects', { name: '중단 복구 테스트 — 합성 행사' });
    assert.equal(created.status, 201);
    project = created.data.project;
    await action('UPDATE_SPACE', { confirmed: true });

    await loseReplyAndRecover('GENERATE_CANDIDATES');
    assert.equal(project.candidates.length, 16);
    assert.equal(auditCount('GENERATE_CANDIDATES'), 1);
    await loseReplyAndRecover('RUN_SIMULATION');
    assert.equal(project.simulation.results.length, 16);
    assert.equal(auditCount('RUN_SIMULATION'), 1);

    await action('APPROVE_PLAN', { candidateId: project.simulation.recommendedId });
    await action('BUILD_CRM');
    await loseReplyAndRecover('DEPLOY_CRM');
    const deploymentId = project.crm.deployment.id;
    assert.equal(auditCount('DEPLOY_CRM'), 1);

    // A new-version retry is also harmless for the same approval and schema.
    const same = await action('DEPLOY_CRM');
    assert.equal(same.noChange, true);
    assert.equal(project.crm.deployment.id, deploymentId);
    assert.equal(auditCount('DEPLOY_CRM'), 1);

    await app.close();
    app = null;
    await start();
    await refresh();
    assert.equal(project.crm.deployment.id, deploymentId);
    await loseReplyAndRecover('ADD_PERSON', { name: '합성 참가자' });
    assert.equal(project.crm.people.length, 1);
    assert.equal(project.crm.registrations.length, 1);
    assert.equal(auditCount('ADD_PERSON'), 1);

    const startAt = Date.parse(project.crm.deployment.appliedAt);
    await action('ADD_OBSERVATION', {
      visitors: 300, completed: 120, waitP90: 20, consents: 60,
      cost: 1000000, completeness: 0.98,
      notes: '합성 관측 · 실제 행사 아님',
      windowStart: new Date(startAt).toISOString(),
      windowEnd: new Date(startAt + 1000).toISOString(),
    });
    await action('RUN_LOOP');
    const proposalId = project.loop.proposals.at(-1).id;
    await loseReplyAndRecover('APPLY_PROPOSAL', { proposalId });
    assert.equal(project.loop.proposals.at(-1).status, 'applied');
    assert.equal(project.crm.deployment.id, deploymentId);
    assert.equal(project.crm.people.length, 1);
    assert.equal(auditCount('APPLY_PROPOSAL'), 1);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
