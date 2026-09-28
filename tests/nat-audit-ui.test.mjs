import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { natAuditView } from '../client/nat-audit-view.mjs';

const project = { id: 'EVT-test', version: 8, inputRevision: 2 };
const receipt = { projectId: project.id, projectVersion: 8, inputRevision: 2, status: 'audited', candidateCount: 16, feasibleCount: 5, recommendedId: 'B' };

test('NAT audit UI distinguishes audited, not_run, stale and invalid receipts', () => {
  assert.deepEqual(natAuditView(project, receipt, null).status, 'audited');
  assert.match(natAuditView(project, receipt, null).detail, /5\/16안 · 추천 B/);
  assert.equal(natAuditView(project, { ...receipt, status: 'not_run', issueCodes: ['NO_SIMULATION'] }, null).status, 'not_run');
  assert.equal(natAuditView(project, { ...receipt, status: 'stale', issueCodes: ['ASSUMPTIONS_CHANGED'] }, null).status, 'stale');
  assert.equal(natAuditView(project, { ...receipt, status: 'invalid', issueCodes: ['FEASIBILITY_CONTRADICTION'] }, null).status, 'invalid');
  assert.equal(natAuditView(project, { ...receipt, candidateCount: 15 }, null).status, 'invalid');
});

test('a previous receipt cannot be shown as current after a project edit', () => {
  assert.equal(natAuditView({ ...project, version: 9 }, receipt, null).status, 'stale');
  assert.equal(natAuditView({ ...project, inputRevision: 3 }, receipt, null).status, 'stale');
});

test('unavailable NAT is not presented as a successful audit', () => {
  assert.equal(natAuditView(project, null, null).status, 'idle');
  assert.equal(natAuditView(project, null, null, true).status, 'running');
  assert.equal(natAuditView(project, receipt, { status: 503 }).status, 'unavailable');
  assert.equal(natAuditView(project, receipt, { status: 409 }).status, 'stale');
});

test('comparison UI uses read-only project audit route and keeps its caveat visible', async () => {
  const api = await readFile(new URL('../client/api.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../client/App.jsx', import.meta.url), 'utf8');
  assert.match(api, /natAudit:\s*\(id\)\s*=>\s*request\(`\/api\/projects\/\$\{encodeURIComponent\(id\)\}\/nat-audit`\)/);
  assert.match(app, /api\.natAudit\(project\.id\)/);
  assert.match(app, /예측 모델이나 독립적인 추론 결과가 아닙니다/);
});
