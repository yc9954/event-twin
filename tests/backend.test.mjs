import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createProject, createDomain } from "../server/domain.mjs";
import { createStore } from "../server/store.mjs";
import { createAppServer, validateUpload } from "../server/http.mjs";

const dependencies = {
  generateCandidates: (space) =>
    Array.from({ length: 16 }, (_, i) => ({
      id: String.fromCharCode(65 + i),
      name: `후보 ${i}`,
      family: "gallery",
      familyName: "갤러리",
      variant: i % 4,
      booths: space.booths,
      staff: space.staff,
      space: structuredClone(space),
      scene: { width: space.width, depth: space.depth, stops: [] },
    })),
  runBatch: (candidates, assumptions) => ({
    method: "test-computed-queue",
    seed: assumptions.seed,
    replications: assumptions.replications,
    results: candidates.map((candidate, i) => ({
      candidateId: candidate.id,
      completed: 900 + Math.round(50 / assumptions.serviceMinutes),
      rate: 80,
      waitP90: 3,
      cost: i === 15 ? 90000000 : 30000000,
      consents: 500,
      abandoned: 100,
      range: { low: 78, high: 82 },
      feasible: i !== 15,
      reasons: i === 15 ? ["예산 초과"] : [],
      timeline: [],
      geometry: {
        checkInStaff: 1,
        serviceStaff: candidate.staff - 1,
        serviceStations: candidate.booths * 3,
        zoneCapacities: Array.from(
          { length: candidate.booths },
          (_, index) => ({ zone: index + 1, capacity: 3 }),
        ),
      },
    })),
    recommendedId: "A",
  }),
  analyzeArea: (project) => ({
    source: "test-osm",
    coordinate: [project.brief.lng, project.brief.lat],
    tools: [],
    facilities: [],
  }),
  runAgent: async ({ executeTool }) => ({
    reply: "상권 분석 완료",
    steps: [
      {
        name: "analyze_area",
        status: "complete",
        output: await executeTool("analyze_area", {}),
      },
    ],
  }),
};
const domain = createDomain(dependencies);
const act = (project, type, payload = {}, options) =>
  domain.applyAction(project, type, payload, options);
function ready({ deploy = true } = {}) {
  const project = createProject("테스트 행사");
  act(project, "UPDATE_SPACE", { confirmed: true });
  act(project, "GENERATE_CANDIDATES");
  act(project, "RUN_SIMULATION");
  act(project, "APPROVE_PLAN", { candidateId: "A" });
  if (deploy) {
    act(project, "BUILD_CRM");
    act(project, "DEPLOY_CRM");
    // Most fixtures use a fixed September 20 observation window. The test
    // deployment must predate it to model a real post-deployment observation.
    project.crm.deployment.appliedAt = "2026-09-19T00:00:00.000Z";
  }
  return project;
}
const observation = (extra = {}) => ({
  visitors: 100,
  completed: 65,
  waitP90: 18,
  consents: 42,
  cost: 3000000,
  completeness: 0.98,
  notes: "현장 수기 입력",
  windowStart: "2026-09-20T03:00:00Z",
  windowEnd: "2026-09-20T05:00:00Z",
  ...extra,
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfP8AAAAASUVORK5CYII=",
  "base64",
);

async function apiFixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-backend-test-"));
  const app = await createAppServer({
    dataDir: join(dir, "data"),
    staticDir: join(dir, "public"),
    port: 0,
    scheduler: false,
    modelConfigured: false,
    dependencies,
    ...extra,
  });
  await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const connectionId = (await (await fetch(url + "/api/health")).json())
    .provider.connectionId;
  const request = async (path, body, headers = {}) => {
    if (body?.useModel === true && !Object.hasOwn(body, "expectedConnectionId"))
      body = { ...body, expectedConnectionId: connectionId };
    const response = await fetch(
      url + path,
      body === undefined
        ? { headers }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    return { status: response.status, data, response };
  };
  const created = await request("/api/projects", { name: "API 행사" });
  return { app, dir, url, request, project: created.data.project };
}

test("fresh project has no invented people, observations, approvals, or results", () => {
  const project = createProject();
  assert.equal(project.space.confirmed, false);
  assert.equal(project.crm.people.length, 0);
  assert.equal(project.observations.length, 0);
  assert.equal(project.simulation, null);
  assert.equal(project.approval, null);
  assert.equal(project.version, 1);
  assert.equal(project.inputRevision, 1);
});
test("dimensions must be owner-confirmed before generating sixteen candidates", () => {
  const project = createProject();
  assert.throws(() => act(project, "GENERATE_CANDIDATES"), /치수/);
  act(project, "UPDATE_SPACE", { width: 32, depth: 20, confirmed: true });
  act(project, "GENERATE_CANDIDATES");
  assert.equal(project.candidates.length, 16);
  assert.equal(project.candidates[0].space.width, 32);
});
test("simulation rejects duplicate or mismatched candidate results before saving", () => {
  for (const corrupt of [
    (batch) => { batch.results[15].candidateId = batch.results[0].candidateId; },
    (batch) => { batch.recommendedId = "MISSING"; },
    (batch) => { batch.results[0].feasible = false; },
    (batch) => { batch.results[0].cost = Number.NaN; },
    (batch) => { batch.results[0].rate = 101; },
  ]) {
    const broken = createDomain({
      ...dependencies,
      runBatch(candidates, assumptions) {
        const batch = dependencies.runBatch(candidates, assumptions);
        corrupt(batch);
        return batch;
      },
    });
    const project = createProject("잘못된 계산 결과");
    broken.applyAction(project, "UPDATE_SPACE", { confirmed: true });
    broken.applyAction(project, "GENERATE_CANDIDATES");
    const before = structuredClone(project);
    assert.throws(
      () => broken.applyAction(project, "RUN_SIMULATION"),
      /mismatched candidate results/,
    );
    assert.deepEqual(project, before);
  }
});
test("input changes invalidate computation/approval but preserve the deployed CRM snapshot and people", () => {
  const project = ready();
  act(project, "ADD_PERSON", { name: "실제 입력", marketingConsent: false });
  const deployment = structuredClone(project.crm.deployment),
    revision = project.inputRevision;
  act(project, "UPDATE_ASSUMPTIONS", { serviceMinutes: 5 });
  assert.equal(project.inputRevision, revision + 1);
  assert.equal(project.approval, null);
  assert.equal(project.simulation, null);
  assert.equal(project.candidates.length, 0);
  assert.deepEqual(project.crm.deployment, deployment);
  assert.equal(project.crm.people.length, 1);
  assert.equal(project.crm.schema, null);
});
test("saving an unchanged brief does not discard an approved plan", () => {
  const project = ready();
  const approval = structuredClone(project.approval);
  const deployment = structuredClone(project.crm.deployment);
  const inputRevision = project.inputRevision;
  act(project, "UPDATE_BRIEF", {
    name: project.name,
    goal: project.brief.goal,
    location: project.brief.location,
    lat: project.brief.lat,
    lng: project.brief.lng,
  });
  assert.equal(project.inputRevision, inputRevision);
  assert.deepEqual(project.approval, approval);
  assert.deepEqual(project.crm.deployment, deployment);
  act(project, "UPDATE_BRIEF", { goal: "새 목표" });
  assert.equal(project.inputRevision, inputRevision + 1);
  assert.equal(project.approval, null);
});
test("manual geometry change without confirmation requires a fresh measurement confirmation", () => {
  const project = ready();
  act(project, "UPDATE_SPACE", { width: 30 });
  assert.equal(project.space.confirmed, false);
});
test("space and assumption revisions clear input-dependent research before a new approval", () => {
  for (const [type, payload] of [
    ["UPDATE_SPACE", { width: 30, confirmed: true }],
    ["UPDATE_ASSUMPTIONS", { budget: 70000000 }],
  ]) {
    const project = ready();
    act(project, "RUN_RESEARCH");
    const priorResearch = structuredClone(project.research);
    assert.equal(priorResearch.inputRevision, project.inputRevision);
    act(project, type, payload);
    assert.equal(project.research, null);
    act(project, "GENERATE_CANDIDATES");
    act(project, "RUN_SIMULATION");
    act(project, "APPROVE_PLAN", { candidateId: "A" });
    assert.equal(project.approval.research, null);
    act(project, "RUN_RESEARCH");
    act(project, "APPROVE_PLAN", { candidateId: "A" });
    assert.equal(
      project.approval.research.inputRevision,
      project.inputRevision,
    );
    assert.notEqual(project.approval.research.id, priorResearch.id);
  }
});
test("approval excludes stale research in a previously persisted project", () => {
  const project = ready({ deploy: false });
  project.research = {
    id: "old-research",
    inputRevision: project.inputRevision - 1,
    tools: [],
  };
  act(project, "APPROVE_PLAN", { candidateId: "A" });
  assert.equal(project.approval.research, null);
});
test("unknown input fields, impossible ranges, and inconsistent assumptions are rejected atomically", () => {
  const project = createProject();
  const snapshot = structuredClone(project);
  for (const [type, payload] of [
    ["UPDATE_SPACE", { width: -3 }],
    ["UPDATE_SPACE", { hacked: true }],
    ["UPDATE_ASSUMPTIONS", { consentRate: 2 }],
    ["UPDATE_ASSUMPTIONS", { visitors: 100, minConsent: 200 }],
    ["UPDATE_BRIEF", { name: "변경 안 됨", lat: 999 }],
  ]) {
    assert.throws(() => act(project, type, payload));
    assert.deepEqual(project, snapshot);
  }
});
test("approval is rejected before running and for infeasible candidates", () => {
  assert.throws(
    () => act(createProject(), "APPROVE_PLAN", { candidateId: "A" }),
    /실험/,
  );
  const project = ready();
  assert.throws(
    () => act(project, "APPROVE_PLAN", { candidateId: "P" }),
    /제약/,
  );
});
test("approval captures immutable candidate, assumptions and geographic research references", () => {
  const project = ready({ deploy: false });
  act(project, "RUN_RESEARCH");
  act(project, "APPROVE_PLAN", { candidateId: "A" });
  const approval = structuredClone(project.approval);
  project.candidates[0].space.width = 88;
  project.research.source = "changed";
  assert.deepEqual(project.approval, approval);
});
test("candidate selection expires approval and CRM schema, unchanged selection does not", () => {
  const project = ready();
  const approval = structuredClone(project.approval);
  act(project, "SELECT_CANDIDATE", { candidateId: "A" });
  assert.deepEqual(project.approval, approval);
  act(project, "SELECT_CANDIDATE", { candidateId: "B" });
  assert.equal(project.approval, null);
  assert.equal(project.crm.schema, null);
});
test("CRM build and deployment require current owner approval", () => {
  assert.throws(() => act(createProject(), "BUILD_CRM"));
  const project = ready({ deploy: false });
  assert.throws(() => act(project, "DEPLOY_CRM"), /빌드/);
  act(project, "BUILD_CRM");
  act(project, "DEPLOY_CRM");
  assert.equal(
    project.crm.deployment.schema.zones.length,
    project.approval.candidate.booths,
  );
  assert.ok(project.crm.deployment.schema.slots.length > 0);
  assert.equal(project.crm.deployment.mode, "local-only");
  assert.equal(project.crm.deployment.externallyDeployed, false);
  assert.equal(
    project.crm.schema.zones.reduce((sum, zone) => sum + zone.staff, 0) +
      project.crm.schema.checkInStaff,
    project.crm.schema.staff,
  );
  assert.equal(
    project.crm.schema.slots[0].capacity,
    project.approval.metrics.geometry.zoneCapacities[0].capacity,
  );
  assert.equal(
    project.crm.schema.slots[0].endMinute -
      project.crm.schema.slots[0].startMinute,
    project.approval.assumptions.serviceMinutes,
  );
  assert.equal(
    project.crm.schema.slots.reduce((sum, slot) => sum + slot.capacity, 0),
    Math.floor(
      project.assumptions.durationMinutes / project.assumptions.serviceMinutes,
    ) * project.approval.metrics.geometry.serviceStations,
  );
});
test("same approval and CRM schema deployment retry has no domain side effects", () => {
  const project = ready();
  const { registration } = act(project, "ADD_PERSON", { name: "재배포 검수" });
  act(project, "ADD_OBSERVATION", observation());
  const { proposal } = act(project, "RUN_LOOP");
  const before = structuredClone(project);
  const repeated = act(project, "DEPLOY_CRM");
  assert.equal(repeated.id, before.crm.deployment.id);
  assert.deepEqual(project, before);
  assert.equal(project.crm.registrations[0].id, registration.id);
  assert.equal(project.loop.proposals[0].id, proposal.id);
  assert.equal(project.loop.proposals[0].status, "pending");
});
test("redeployment retains participant status but rebinds registrations to the active schema", () => {
  const project = ready();
  const firstDeployment = project.crm.deployment.id;
  const oldZone = project.crm.deployment.schema.zones[0].id;
  const { person, registration } = act(project, "ADD_PERSON", {
    name: "기존 참가자",
    email: "returning@example.com",
    marketingConsent: true,
  });
  act(project, "UPDATE_REGISTRATION", {
    registrationId: registration.id,
    status: "checked_in",
    zoneId: oldZone,
  });
  act(project, "SELECT_CANDIDATE", { candidateId: "B" });
  act(project, "APPROVE_PLAN", { candidateId: "B" });
  act(project, "BUILD_CRM");
  act(project, "DEPLOY_CRM");
  assert.notEqual(project.crm.deployment.id, firstDeployment);
  assert.equal(project.crm.registrations.length, 1);
  assert.equal(project.crm.registrations[0].deploymentId, project.crm.deployment.id);
  assert.equal(project.crm.registrations[0].zoneId, null);
  assert.equal(project.crm.registrations[0].status, "checked_in");
  assert.equal(project.crm.people[0].id, person.id);
  assert.equal(project.crm.consents.length, 1);
  const duplicate = act(project, "ADD_PERSON", {
    name: "재방문",
    email: "returning@example.com",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(project.crm.registrations.length, 1);
});
test("adding participant creates registration and append-only consent; duplicates do not change consent", () => {
  const project = ready();
  const added = act(project, "ADD_PERSON", {
    name: "방문객",
    email: "A@EXAMPLE.COM",
    marketingConsent: false,
  });
  const duplicate = act(project, "ADD_PERSON", {
    name: "중복",
    email: "a@example.com",
    marketingConsent: true,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(project.crm.people.length, 1);
  assert.equal(project.crm.registrations.length, 1);
  assert.equal(project.crm.consents.length, 1);
  assert.equal(project.crm.consents[0].granted, false);
  act(project, "SET_CONSENT", { personId: added.person.id, granted: true });
  act(project, "SET_CONSENT", { personId: added.person.id, granted: false });
  assert.equal(project.crm.consents.length, 3);
  assert.equal(project.crm.consents.at(-1).granted, false);
});
test("imports are bounded, deduplicated, sample-tagged and atomic when a row is invalid", () => {
  const project = ready();
  const result = act(project, "IMPORT_PEOPLE", {
    sample: true,
    rows: [
      { name: "예시", phone: "010-1234-5678" },
      { name: "동일 연락처", phone: "01012345678" },
    ],
  });
  assert.deepEqual(result, { added: 1, duplicates: 1 });
  assert.equal(project.crm.people[0].sample, true);
  const snapshot = structuredClone(project);
  assert.throws(() =>
    act(project, "IMPORT_PEOPLE", {
      rows: [{ name: "저장되면 안 됨" }, { name: "" }],
    }),
  );
  assert.deepEqual(project, snapshot);
  assert.throws(() =>
    act(project, "IMPORT_PEOPLE", { rows: Array(501).fill({ name: "N" }) }),
  );
});
test("checkin, waiting, completion, tasks and consent changes record actual local state", () => {
  const project = ready();
  const { registration } = act(project, "ADD_PERSON", {
    name: "방문객",
    marketingConsent: true,
  });
  act(project, "UPDATE_REGISTRATION", {
    registrationId: registration.id,
    status: "checked_in",
  });
  act(project, "UPDATE_REGISTRATION", {
    registrationId: registration.id,
    status: "waiting",
  });
  assert.equal(project.crm.tasks.length, 1);
  act(project, "UPDATE_REGISTRATION", {
    registrationId: registration.id,
    status: "waiting",
  });
  assert.equal(project.crm.tasks.length, 1);
  act(project, "UPDATE_REGISTRATION", {
    registrationId: registration.id,
    status: "completed",
    zoneId: project.crm.schema.zones[0].id,
  });
  assert.equal(project.crm.tasks.length, 2);
  act(project, "UPDATE_TASK", {
    taskId: project.crm.tasks[0].id,
    status: "done",
  });
  assert.equal(project.crm.tasks[0].status, "done");
  assert.throws(() =>
    act(project, "UPDATE_REGISTRATION", {
      registrationId: registration.id,
      status: "active",
      zoneId: "foreign-zone",
    }),
  );
});
test("observation counts, costs, completeness and time windows are validated", () => {
  const project = createProject();
  for (const extra of [
    { completed: 101 },
    { consents: 101 },
    { cost: 0.1 },
    { completeness: 90 },
    { windowStart: "bad" },
    { windowEnd: "2026-09-19T00:00:00Z" },
  ])
    assert.throws(() => act(project, "ADD_OBSERVATION", observation(extra)));
  act(project, "ADD_OBSERVATION", observation());
  assert.equal(project.observations[0].source, "owner-entered");
});
test("loop data-quality gate blocks missing and incomplete observations", () => {
  const project = ready();
  assert.throws(() => act(project, "RUN_LOOP"), /완전성/);
  act(project, "ADD_OBSERVATION", observation({ completeness: 0.6 }));
  assert.throws(() => act(project, "RUN_LOOP"), /완전성/);
});
test("loop refuses a high-quality observation whose window predates CRM deployment", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  project.crm.deployment.appliedAt = "2026-09-21T00:00:00.000Z";
  const before = structuredClone(project);
  assert.throws(
    () => act(project, "RUN_LOOP"),
    (error) => error.code === "STALE_DEPLOYMENT",
  );
  assert.deepEqual(project, before);
});
test("historical observations saved after deployment are not falsely bound to it", () => {
  const project = ready();
  project.crm.deployment.appliedAt = "2026-09-21T00:00:00.000Z";
  const saved = act(project, "ADD_OBSERVATION", observation());
  assert.equal(saved.deploymentId, null);
  assert.equal(saved.inputRevision, null);
  assert.equal(saved.candidateId, null);
  assert.throws(() => act(project, "RUN_LOOP"), (error) => error.code === "STALE_DEPLOYMENT");
});
test("local loop computes a changed-parameter comparison and only proposes owner review", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const oldApproval = structuredClone(project.approval),
    oldDeployment = structuredClone(project.crm.deployment);
  const { proposal } = act(project, "RUN_LOOP");
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.assumptions.serviceMinutes, 3.4);
  assert.notEqual(proposal.baseline.completed, proposal.alternative.completed);
  assert.deepEqual(project.approval, oldApproval);
  assert.deepEqual(project.crm.deployment, oldDeployment);
  const again = act(project, "RUN_LOOP");
  assert.equal(again.duplicate, true);
  assert.equal(project.loop.proposals.length, 1);
});
test("loop cannot use a newly selected unapproved candidate instead of the deployed one", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  act(project, "SELECT_CANDIDATE", { candidateId: "B" });
  assert.throws(
    () => act(project, "RUN_LOOP"),
    (error) => error.code === "STALE_DEPLOYMENT",
  );
});
test("loop rejects a reselected candidate after approval and schema were invalidated", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  act(project, "SELECT_CANDIDATE", { candidateId: "B" });
  act(project, "SELECT_CANDIDATE", { candidateId: "A" });
  assert.equal(project.approval, null);
  assert.equal(project.crm.schema, null);
  const before = structuredClone(project);
  assert.throws(() => act(project, "RUN_LOOP"), (error) => error.code === "STALE_DEPLOYMENT");
  assert.deepEqual(project, before);
});
test("loop rejects a deployed schema that does not match the current approved schema", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  project.crm.schema.id = "SCHEMA-OTHER";
  assert.throws(() => act(project, "RUN_LOOP"), (error) => error.code === "STALE_DEPLOYMENT");
});
test("observations bind to deployed schema and cannot be reused after redeployment", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const prior = structuredClone(project.observations[0]);
  assert.equal(prior.deploymentId, project.crm.deployment.id);
  assert.equal(prior.candidateId, project.crm.deployment.candidateId);
  assert.equal(prior.inputRevision, project.crm.deployment.inputRevision);
  act(project, "UPDATE_ASSUMPTIONS", { visitors: 1300 });
  act(project, "GENERATE_CANDIDATES");
  act(project, "RUN_SIMULATION");
  act(project, "APPROVE_PLAN", { candidateId: "A" });
  act(project, "BUILD_CRM");
  act(project, "DEPLOY_CRM");
  assert.throws(
    () => act(project, "RUN_LOOP"),
    (error) => error.code === "STALE_DEPLOYMENT",
  );
  project.crm.deployment.appliedAt = "2026-09-19T00:00:00.000Z";
  act(project, "ADD_OBSERVATION", observation());
  assert.ok(act(project, "RUN_LOOP").proposal);
});
test("observations recorded without a deployed CRM are explicitly unbound", () => {
  const project = createProject();
  act(project, "ADD_OBSERVATION", observation());
  assert.equal(project.observations[0].deploymentId, null);
  assert.equal(project.observations[0].candidateId, null);
  assert.equal(project.observations[0].inputRevision, null);
});
test("redeployment expires pending proposals and cannot adopt the old deployment's observation", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const { proposal } = act(project, "RUN_LOOP");
  const priorDeploymentId = project.crm.deployment.id;
  assert.equal(proposal.deploymentId, priorDeploymentId);
  act(project, "APPROVE_PLAN", { candidateId: "A" });
  act(project, "BUILD_CRM");
  act(project, "DEPLOY_CRM");
  assert.notEqual(project.crm.deployment.id, priorDeploymentId);
  assert.equal(project.loop.proposals[0].status, "stale");
  assert.equal(project.loop.proposals[0].staleReason, "deployment_changed");
  const snapshot = structuredClone(project);
  assert.throws(
    () => act(project, "APPLY_PROPOSAL", { proposalId: proposal.id }),
    (error) => error.code === "STALE_PROPOSAL",
  );
  assert.deepEqual(project, snapshot);

  // Simulate a pending proposal loaded from an older app version, which did not
  // expire proposals at redeployment or store a top-level deploymentId.
  project.loop.proposals[0].status = "pending";
  delete project.loop.proposals[0].deploymentId;
  const legacy = structuredClone(project);
  assert.throws(
    () => act(project, "APPLY_PROPOSAL", { proposalId: proposal.id }),
    (error) => error.code === "STALE_PROPOSAL",
  );
  assert.deepEqual(project, legacy);
  project.crm.deployment.appliedAt = "2026-09-19T00:00:00.000Z";
  act(project, "ADD_OBSERVATION", observation());
  const next = act(project, "RUN_LOOP").proposal;
  act(project, "APPLY_PROPOSAL", { proposalId: next.id });
  assert.equal(project.assumptions.serviceMinutes, 3.4);
});
test("new observation stales prior pending proposal and requires a fresh comparison", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const first = act(project, "RUN_LOOP").proposal;
  act(project, "ADD_OBSERVATION", observation({ waitP90: 4, completed: 80 }));
  assert.equal(project.loop.proposals[0].status, "stale");
  assert.equal(project.loop.proposals[0].staleReason, "new_observation");
  assert.throws(
    () => act(project, "APPLY_PROPOSAL", { proposalId: first.id }),
    (error) => error.code === "STALE_PROPOSAL",
  );
  const latest = act(project, "RUN_LOOP");
  assert.equal(latest.skipped, true);
  assert.equal(project.loop.proposals.length, 1);
});
test("proposal adoption rejects a different selected candidate without changing state", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const { proposal } = act(project, "RUN_LOOP");
  act(project, "SELECT_CANDIDATE", { candidateId: "B" });
  const snapshot = structuredClone(project);
  assert.throws(
    () => act(project, "APPLY_PROPOSAL", { proposalId: proposal.id }),
    (error) => error.code === "STALE_PROPOSAL",
  );
  assert.deepEqual(project, snapshot);
});
test("loop makes no arbitrary proposal when observed completion and wait meet goals", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation({ waitP90: 4, completed: 80 }));
  const result = act(project, "RUN_LOOP");
  assert.equal(result.skipped, true);
  assert.equal(project.loop.proposals.length, 0);
});
test("completion deviation proposes arrival distribution instead of always changing service time", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation({ waitP90: 4, completed: 20 }));
  const { proposal } = act(project, "RUN_LOOP");
  assert.equal(proposal.signal.kind, "completion");
  assert.equal(proposal.assumptions.serviceMinutes, undefined);
  assert.equal(proposal.assumptions.arrivalPeak, 1.13);
});
test("waiting status revisits do not create duplicate open tasks", () => {
  const project = ready();
  const { registration } = act(project, "ADD_PERSON", { name: "방문객" });
  for (const status of ["waiting", "registered", "waiting"])
    act(project, "UPDATE_REGISTRATION", {
      registrationId: registration.id,
      status,
    });
  assert.equal(project.crm.tasks.length, 1);
});
test("explicit proposal adoption changes assumptions and invalidates plans, never deploys", () => {
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  const { proposal } = act(project, "RUN_LOOP");
  const deployed = structuredClone(project.crm.deployment);
  act(project, "APPLY_PROPOSAL", { proposalId: proposal.id });
  assert.equal(project.assumptions.serviceMinutes, 3.4);
  assert.equal(project.approval, null);
  assert.equal(project.simulation, null);
  assert.deepEqual(project.crm.deployment, deployed);
  assert.throws(
    () => act(project, "APPLY_PROPOSAL", { proposalId: proposal.id }),
    /미적용/,
  );
});
test("agent aliases strip null fields and cannot confirm measurements or approve/deploy/import", () => {
  const project = ready();
  domain.executeTool(project, "propose_space", {
    width: 30,
    family: "festival",
    depth: null,
  });
  assert.equal(project.space.width, 30);
  assert.equal(project.space.depth, 18);
  assert.equal(project.space.family, "festival");
  assert.equal(project.space.confirmed, false);
  for (const action of [
    "APPROVE_PLAN",
    "DEPLOY_CRM",
    "ADD_PERSON",
    "SET_CONSENT",
    "APPLY_PROPOSAL",
    "SEND_EMAIL",
  ])
    assert.throws(() => domain.executeTool(project, action, {}), /허용되지/);
});
test("agent read context excludes contacts and private observation notes", () => {
  const project = ready();
  act(project, "ADD_PERSON", {
    name: "PII-UNIQUE-NAME",
    email: "private@example.com",
  });
  act(project, "ADD_OBSERVATION", observation({ notes: "PII-PRIVATE-NOTE" }));
  const context = domain.executeTool(project, "get_project");
  assert.equal(context.crm.people.length, 1);
  assert.equal(context.crm.peopleCount, 1);
  assert.equal(JSON.stringify(context).includes("private@example.com"), false);
  assert.equal(JSON.stringify(context).includes("PII-"), false);
  assert.equal(
    JSON.stringify(domain.executeTool(project, "review_operations")).includes(
      "PII-",
    ),
    false,
  );
});
test("SQLite persists state and upload bytes across close/reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = createStore(dir);
  const project = store.create(createProject("지속 저장"));
  await store.mutate(project.id, 1, (draft) => {
    draft.name = "다시 읽기";
    draft.attachments.push({ id: "IMG-1" });
    return { upload: { id: "IMG-1", mime: "image/png", bytes: png } };
  });
  await store.close();
  store = createStore(dir);
  assert.equal(store.get(project.id).name, "다시 읽기");
  assert.equal(store.get(project.id).version, 2);
  assert.deepEqual(store.upload(project.id, "IMG-1").bytes, png);
  await store.close();
});
test("SQLite CAS serializes competing writes, rejects stale versions and keeps successful state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-cas-test-"));
  const store = createStore(dir);
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = store.create(createProject());
  const outcomes = await Promise.allSettled([
    store.mutate(project.id, 1, async (draft) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      draft.name = "winner";
    }),
    store.mutate(project.id, 1, (draft) => {
      draft.name = "loser";
    }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  assert.equal(outcomes[1].reason.status, 409);
  assert.equal(store.get(project.id).name, "winner");
});
test("failed mutation rolls back changes and does not advance version", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-rollback-test-"));
  const store = createStore(dir);
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = store.create(createProject());
  await assert.rejects(
    store.mutate(project.id, 1, (draft) => {
      draft.name = "not persisted";
      throw new Error("fail");
    }),
  );
  assert.deepEqual(store.get(project.id), project);
});
test("HTTP projects create/load/list/export and health do not expose server credentials", async (t) => {
  const { request, project } = await apiFixture(t);
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.mode, "local-single-owner");
  assert.equal("apiKey" in health.data, false);
  assert.equal(
    (await request("/api/projects")).data.projects[0].id,
    project.id,
  );
  assert.equal(
    (await request(`/api/projects/${project.id}`)).data.project.name,
    project.name,
  );
  const exported = await request(`/api/projects/${project.id}/export`);
  assert.equal(exported.data.project.id, project.id);
  assert.match(
    exported.response.headers.get("content-disposition"),
    /attachment/,
  );
});
test("HTTP mutation requires version and returns 409 on stale input", async (t) => {
  const { request, project } = await apiFixture(t);
  const path = `/api/projects/${project.id}/actions`;
  assert.equal(
    (await request(path, { type: "UPDATE_BRIEF", payload: { name: "N" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(path, {
        type: "UPDATE_BRIEF",
        payload: { name: "N" },
        expectedVersion: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(path, {
        type: "UPDATE_BRIEF",
        payload: { name: "OLD" },
        expectedVersion: 1,
      })
    ).status,
    409,
  );
});
test("HTTP repeated CRM deployment returns the same version and leaves registrations and proposals intact", async (t) => {
  const { app, request } = await apiFixture(t);
  const project = ready();
  act(project, "ADD_PERSON", { name: "기존 참가자" });
  act(project, "ADD_OBSERVATION", observation());
  act(project, "RUN_LOOP");
  app.store.create(project);
  const path = `/api/projects/${project.id}/actions`;
  const repeat = await request(path, {
    type: "DEPLOY_CRM", payload: {}, expectedVersion: project.version,
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.noChange, true);
  assert.equal(repeat.data.result.id, project.crm.deployment.id);
  assert.deepEqual(repeat.data.project, project);
  assert.deepEqual(app.store.get(project.id), project);
  const invalid = await request(path, {
    type: "DEPLOY_CRM", payload: { unexpected: true }, expectedVersion: project.version,
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(app.store.get(project.id), project);
});
test("HTTP rejects hostile Origins and DNS-rebinding Hosts", async (t) => {
  const { request, url } = await apiFixture(t);
  assert.equal(
    (
      await request("/api/projects", undefined, {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/projects", { name: "blocked" }, { Origin: "null" }))
      .status,
    403,
  );
  const parsed = new URL(url);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: parsed.port,
        path: "/api/health",
        headers: { Host: `attacker.example:${parsed.port}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});
test("HTTP body content type, malformed JSON and maximum bytes are enforced", async (t) => {
  const { url } = await apiFixture(t);
  const wrong = await fetch(url + "/api/projects", {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(wrong.status, 415);
  const malformed = await fetch(url + "/api/projects", {
    method: "POST",
    body: "{",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(malformed.status, 400);
  const big = await fetch(url + "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "x".repeat(8 * 1024 * 1024) }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(big.status, 413);
});
test("signature validation rejects disguised files, corrupt base64 and oversized image dimensions", () => {
  assert.equal(
    validateUpload({
      name: "a.png",
      mime: "image/png",
      data: png.toString("base64"),
    }).bytes.length,
    png.length,
  );
  assert.throws(() =>
    validateUpload({
      name: "bad.png",
      mime: "image/png",
      data: Buffer.from("<svg/>").toString("base64"),
    }),
  );
  assert.throws(() =>
    validateUpload({ name: "bad.png", mime: "image/png", data: "!!!!" }),
  );
  const large = Buffer.from(png);
  large.writeUInt32BE(20000, 16);
  assert.throws(() =>
    validateUpload({
      name: "large.png",
      mime: "image/png",
      data: large.toString("base64"),
    }),
  );
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
    0x00, 0x01, 0x00, 0x01, 0xff, 0xd9,
  ]);
  jpeg.writeUInt16BE(12001, 9);
  assert.throws(() => validateUpload({
    name: "large.jpg", mime: "image/jpeg", data: jpeg.toString("base64"),
  }));
  assert.throws(() => validateUpload({
    name: "no-frame.jpg", mime: "image/jpeg",
    data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"),
  }));
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(12000, 24, 3); // VP8X stores width minus one.
  webp.writeUIntLE(1, 27, 3);
  assert.throws(() => validateUpload({
    name: "large.webp", mime: "image/webp", data: webp.toString("base64"),
  }));
  webp.writeUIntLE(0, 24, 3);
  webp.writeUInt32LE(0, 16);
  assert.throws(() => validateUpload({
    name: "bad-chunk.webp", mime: "image/webp", data: webp.toString("base64"),
  }));
});
test("uploads are versioned, persisted, served safely and project-isolated", async (t) => {
  const { request, project, url } = await apiFixture(t);
  const input = {
    name: "../photo.png",
    mime: "image/png",
    data: png.toString("base64"),
    expectedVersion: 1,
  };
  const uploaded = await request(`/api/projects/${project.id}/uploads`, input);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.project.version, 2);
  assert.equal(uploaded.data.attachment.name.includes("/"), false);
  const response = await fetch(url + uploaded.data.attachment.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(
    (await request(`/api/projects/${project.id}/uploads`, input)).status,
    409,
  );
  const other = await request("/api/projects", { name: "다른 프로젝트" });
  assert.equal(
    (
      await request(
        `/api/projects/${other.data.project.id}/uploads/${uploaded.data.attachment.id}`,
      )
    ).status,
    404,
  );
});
test("local chat executes allowed tools and persists message, result and audit once", async (t) => {
  const { request, project } = await apiFixture(t);
  const response = await request(`/api/projects/${project.id}/chat`, {
    message: "상권 분석",
    expectedVersion: 1,
    useModel: false,
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.project.version, 2);
  assert.equal(response.data.project.messages.length, 2);
  assert.equal(response.data.project.research.source, "test-osm");
});
test("model errors roll back draft tool mutations and return no leaked error secrets", async (t) => {
  const { request, project } = await apiFixture(t, {
    modelConfigured: true,
    dependencies: {
      ...dependencies,
      runAgent: async ({ executeTool }) => {
        await executeTool("propose_space", { width: 50 });
        throw new Error("sk-secret-example provider stack");
      },
    },
  });
  const result = await request(`/api/projects/${project.id}/chat`, {
    message: "변경 요청",
    expectedVersion: 1,
    useModel: true,
  });
  assert.equal(result.status, 502);
  assert.equal(JSON.stringify(result.data).includes("sk-secret"), false);
  const saved = (await request(`/api/projects/${project.id}`)).data.project;
  assert.equal(saved.version, 1);
  assert.equal(saved.space.width, 24);
  assert.equal(saved.messages.length, 0);
});
test("model credit exhaustion gives a distinct sanitized actionable error and rolls back", async (t) => {
  const { request, project } = await apiFixture(t, {
    modelConfigured: true,
    dependencies: {
      ...dependencies,
      runAgent: async ({ executeTool }) => {
        await executeTool("propose_space", { width: 50 });
        throw Object.assign(new Error("provider sk-sensitive-detail"), {
          status: 429,
          code: "credit_balance_exhausted",
        });
      },
    },
  });
  const result = await request(`/api/projects/${project.id}/chat`, {
    message: "모델 실행",
    expectedVersion: 1,
    useModel: true,
  });
  assert.equal(result.status, 429);
  assert.equal(result.data.code, "MODEL_CREDITS_EXHAUSTED");
  assert.match(result.data.error, /크레딧/);
  assert.equal(JSON.stringify(result.data).includes("sk-sensitive"), false);
  assert.equal(
    (await request(`/api/projects/${project.id}`)).data.project.space.width,
    24,
  );
});
test("chat project context keeps the shape expected by the agent without CRM contacts", async (t) => {
  let inspected;
  const { app, request, project } = await apiFixture(t, {
    dependencies: {
      ...dependencies,
      runAgent: async ({ project }) => {
        inspected = project;
        return { reply: "확인", steps: [] };
      },
    },
  });
  await app.store.mutate(project.id, 1, (draft) => {
    draft.crm.people.push({ name: "PRIVATE", email: "private@example.com" });
  });
  const response = await request(`/api/projects/${project.id}/chat`, {
    message: "현황",
    expectedVersion: 2,
    useModel: false,
  });
  assert.equal(response.status, 200);
  assert.equal(inspected.crm.people.length, 1);
  assert.ok(Array.isArray(inspected.attachments));
  assert.ok(Array.isArray(inspected.messages));
  assert.equal(
    JSON.stringify(inspected).includes("private@example.com"),
    false,
  );
});
test("only selected project-owned images may be loaded by a configured model call", async (t) => {
  let loaded;
  const { request, project } = await apiFixture(t, {
    modelConfigured: true,
    dependencies: {
      ...dependencies,
      runAgent: async ({ imageIds, loadImage }) => {
        loaded = await loadImage(imageIds[0]);
        await assert.rejects(loadImage("IMG-unselected"));
        return { reply: "사진 확인", steps: [] };
      },
    },
  });
  const upload = await request(`/api/projects/${project.id}/uploads`, {
    name: "a.png",
    mime: "image/png",
    data: png.toString("base64"),
    expectedVersion: 1,
  });
  const chat = await request(`/api/projects/${project.id}/chat`, {
    message: "선택 사진",
    expectedVersion: 2,
    useModel: true,
    imageIds: [upload.data.attachment.id],
  });
  assert.equal(chat.status, 200);
  assert.equal(loaded.mime, "image/png");
  assert.equal(loaded.data, png.toString("base64"));
});
test("chat and actions serialize under one project version lock", async (t) => {
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  let release;
  const unblock = new Promise((resolve) => {
    release = resolve;
  });
  const { request, project } = await apiFixture(t, {
    dependencies: {
      ...dependencies,
      runAgent: async () => {
        began();
        await unblock;
        return { reply: "완료", steps: [] };
      },
    },
  });
  const chat = request(`/api/projects/${project.id}/chat`, {
    message: "대화",
    expectedVersion: 1,
    useModel: false,
  });
  await started;
  const action = request(`/api/projects/${project.id}/actions`, {
    type: "UPDATE_BRIEF",
    payload: { name: "오래된 이름" },
    expectedVersion: 1,
  });
  release();
  assert.equal((await chat).status, 200);
  assert.equal((await action).status, 409);
});
test("scheduler runs locally once per interval and cannot auto-approve or deploy proposals", async (t) => {
  const { app } = await apiFixture(t);
  const project = ready();
  act(project, "ADD_OBSERVATION", observation());
  act(project, "SET_LOOP_POLICY", { enabled: true, intervalMinutes: 5 });
  app.store.create(project);
  await app.runScheduler();
  const saved = app.store.get(project.id);
  assert.equal(saved.loop.proposals.length, 1);
  assert.equal(saved.loop.proposals[0].status, "pending");
  assert.deepEqual(saved.approval, project.approval);
  assert.deepEqual(saved.crm.deployment, project.crm.deployment);
  await app.runScheduler();
  assert.equal(app.store.get(project.id).version, saved.version);
});
test("scheduler records quality-gate skip without fabricated proposals", async (t) => {
  const { app } = await apiFixture(t);
  const project = ready();
  act(project, "SET_LOOP_POLICY", { enabled: true, intervalMinutes: 5 });
  app.store.create(project);
  await app.runScheduler();
  const saved = app.store.get(project.id);
  assert.equal(saved.loop.proposals.length, 0);
  assert.ok(saved.loop.lastError.includes("완전성"));
  assert.equal(saved.audit.at(-1).action, "SCHEDULER_SKIPPED");
});
test("static files are bounded to public assets and symlink escapes are rejected", async (t) => {
  const { dir, url } = await apiFixture(t);
  await mkdir(join(dir, "public"));
  await writeFile(join(dir, "public", "index.html"), "<html>ready</html>");
  await writeFile(join(dir, "secret.json"), '{"secret":true}');
  await symlink(join(dir, "secret.json"), join(dir, "public", "leak.json"));
  assert.equal((await fetch(url + "/")).status, 200);
  assert.equal((await fetch(url + "/leak.json")).status, 404);
  assert.equal((await fetch(url + "/server/store.mjs")).status, 404);
  assert.equal((await fetch(url + "/%2e%2e%2fsecret.json")).status, 400);
});
