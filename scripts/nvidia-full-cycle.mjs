// Live, synthetic hybrid end-to-end check: NVIDIA inference plus deterministic
// local tools. Nothing is written to a real project or sent to a contact.
// Run: node --env-file-if-exists=.env scripts/nvidia-full-cycle.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/http.mjs";

if (process.env.MODEL_PROVIDER !== "nvidia" || !process.env.NVIDIA_API_KEY) {
  throw new Error("MODEL_PROVIDER=nvidia와 NVIDIA_API_KEY가 설정된 환경에서 실행하세요.");
}

const dataDir = await mkdtemp(join(tmpdir(), "event-twin-nvidia-cycle-"));
const app = await createAppServer({ dataDir, port: 0, scheduler: false });
const address = await app.listen();
const origin = `http://127.0.0.1:${address.port}`;
let project;
const completedTools = [];
const localTools = [];

async function request(path, body) {
  const response = await fetch(origin + path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${value.code || value.error || "request failed"}`);
  }
  return value;
}

async function action(type, payload = {}) {
  const value = await request(`/api/projects/${project.id}/actions`, {
    type, payload, expectedVersion: project.version,
  });
  project = value.project;
  return value.result;
}

async function modelTool(connectionId, name, message) {
  const value = await request(`/api/projects/${project.id}/chat`, {
    message,
    useModel: true,
    imageIds: [],
    expectedConnectionId: connectionId,
    expectedVersion: project.version,
  });
  project = value.project;
  const steps = value.steps;
  assert.ok(steps.some((step) => step.name === name && step.status === "complete"),
    `Hosted model did not complete ${name}: ${steps.map((step) => `${step.name}:${step.status}`).join(", ")}; reply=${String(value.reply || "").slice(0, 500)}`);
  completedTools.push(...steps.map((step) => `${step.name}:${step.status}`));
}

async function localTool(name, message) {
  const value = await request(`/api/projects/${project.id}/chat`, {
    message, useModel: false, imageIds: [], expectedVersion: project.version,
  });
  project = value.project;
  assert.ok(value.steps.some((step) => step.name === name && step.status === "complete"),
    `Local tool did not complete ${name}`);
  localTools.push(name);
}

try {
  const health = await request("/api/health");
  assert.equal(health.provider.provider, "nvidia");
  assert.equal(health.provider.configured, true);
  const connectionId = health.provider.connectionId;
  project = (await request("/api/projects", {
    name: "NVIDIA 실연동 QA · 합성 행사 (실제 행사 아님)",
  })).project;

  await modelTool(connectionId, "get_project", "프로젝트 상태 조회");

  await action("UPDATE_SPACE", { confirmed: true });
  await localTool("generate_candidates", "16개 안 생성해줘");
  assert.equal(project.candidates.length, 16);

  await localTool("run_simulation", "시뮬레이션 실행해줘");
  assert.equal(project.simulation.results.length, 16);
  const candidateId = project.simulation.recommendedId;
  assert.ok(candidateId);

  await action("APPROVE_PLAN", { candidateId });
  await localTool("build_crm", "CRM 구축해줘");
  assert.ok(project.crm.schema.zones.length > 0);
  assert.ok(project.crm.schema.slots.length > 0);

  await action("DEPLOY_CRM");
  assert.equal(project.crm.deployment.externallyDeployed, false);
  await action("ADD_PERSON", {
    name: "합성 QA 참가자", email: "qa@example.invalid", marketingConsent: false,
  });
  const personId = project.crm.people[0].id;
  const registrationId = project.crm.registrations[0].id;
  await action("SET_CONSENT", { personId, granted: true });
  await action("UPDATE_REGISTRATION", {
    registrationId, status: "completed", zoneId: project.crm.deployment.schema.zones[0].id,
  });

  const start = Date.parse(project.crm.deployment.appliedAt);
  await action("ADD_OBSERVATION", {
    visitors: 300, completed: 120, waitP90: 20, consents: 60,
    cost: 1000000, completeness: 0.98,
    notes: "합성 QA 관측값 · 실제 행사 데이터 아님",
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(start + 1000).toISOString(),
  });
  await action("RUN_LOOP");
  assert.equal(project.loop.proposals.length, 1);
  await localTool("review_operations", "운영 현황 조회해줘");

  console.log(JSON.stringify({
    ok: true,
    provider: health.provider.provider,
    model: health.provider.model,
    modelCalls: 1,
    completedTools,
    localTools,
    candidateCount: project.candidates.length,
    resultCount: project.simulation.results.length,
    approval: Boolean(project.approval),
    crmZones: project.crm.schema.zones.length,
    crmSlots: project.crm.schema.slots.length,
    registrationCount: project.crm.registrations.length,
    observationCount: project.observations.length,
    proposalCount: project.loop.proposals.length,
    externallyDeployed: project.crm.deployment.externallyDeployed,
    data: "synthetic, temporary, deleted after run",
  }, null, 2));
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
