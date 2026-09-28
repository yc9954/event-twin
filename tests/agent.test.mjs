import test from "node:test";
import assert from "node:assert/strict";
import { runAgent, localCommands, agentTools } from "../server/agent.mjs";
import { getModelConfiguration } from "../server/model-provider.mjs";
import { analyzeArea, distanceMetres } from "../server/research.mjs";
import { createDomain, createProject } from "../server/domain.mjs";
import { generateCandidates, runBatch } from "../shared/simulation.mjs";
const project = {
  id: "p",
  name: "Event",
  inputRevision: 1,
  brief: { lat: 37.5445, lng: 127.052 },
  space: { width: 24, depth: 18, staff: 6 },
  assumptions: {
    visitors: 1200,
    durationMinutes: 360,
    budget: 60000000,
    seed: 42,
    replications: 12,
  },
  candidates: [],
  simulation: null,
  crm: { people: [{ email: "private@test.com" }], tasks: [] },
  observations: [],
  attachments: [],
  messages: [],
};
test("local parser handles numeric dimensions and avoids pretending photo inference", async () => {
  assert.deepEqual(localCommands("30×20m 중정 부스 4개")[0], [
    "propose_space",
    { width: 30, depth: 20, booths: 4, family: "courtyard" },
  ]);
  let called = false;
  const r = await runAgent({
    project,
    message: "사진으로 공간 만들어줘",
    imageIds: ["i"],
    executeTool: () => (called = true),
  });
  assert.equal(called, false);
  assert.match(r.reply, /해석하지/);
});
test("local tool failure recorded honestly", async () => {
  const r = await runAgent({
    project,
    message: "시뮬레이션 실행",
    executeTool: () => {
      throw new Error("치수 확인 필요");
    },
  });
  assert.equal(r.steps[0].status, "failed");
  assert.match(r.reply, /치수 확인 필요/);
});
test("model tools exclude owner approvals, deployment, arbitrary fetch and send", () => {
  assert.equal(agentTools.length, 8);
  for (const t of agentTools)
    assert.ok(!/approve|deploy|send|fetch|exec/.test(t.name));
});
test("an exact model-mode execution command requires its named tool", async () => {
  const requests = [];
  const client = { responses: { create: async (options) => {
    requests.push(options);
    return requests.length === 1
      ? { output: [{ type: "function_call", name: "run_simulation", call_id: "qa-tool", arguments: "{}" }] }
      : { output_text: "저장된 결과를 확인하세요.", output: [] };
  } } };
  const result = await runAgent({
    project, message: "시뮬레이션 실행해줘", useModel: true, client,
    executeTool: (name) => name === "get_project" ? structuredClone(project) : { ok: true },
  });
  assert.deepEqual(requests[0].tools.map((item) => item.name), ["run_simulation"]);
  assert.equal(requests[0].max_output_tokens, 512);
  assert.deepEqual(requests[0].tool_choice, { type: 'function', name: 'run_simulation' });
  assert.equal(requests[1].tool_choice, undefined);
  assert.equal(result.steps[0].name, "run_simulation");
  assert.equal(result.steps[0].status, "complete");

  const fabricated = { responses: { create: async () => ({
    output_text: "실행하지 않은 결과는 45%입니다.", output: [],
  }) } };
  await assert.rejects(runAgent({
    project, message: "시뮬레이션 실행해줘", useModel: true,
    client: fabricated, executeTool: () => { throw new Error("not called"); },
  }), /run_simulation 도구를 모델이 호출하지 않았습니다/);
});
test("SDK loop routes function output, no CRM PII in model context, store false", async () => {
  const requests = [];
  const client = {
    responses: {
      create: async (opts) => {
        requests.push(structuredClone(opts));
        return requests.length === 1
          ? {
              output: [
                {
                  type: "function_call",
                  name: "analyze_area",
                  call_id: "c",
                  arguments: "{}",
                },
              ],
            }
          : { output_text: "지도 분석 완료", output: [] };
      },
    },
  };
  const r = await runAgent({
    project,
    message: "주변 상권 분석",
    useModel: true,
    client,
    executeTool: (name) =>
      name === "get_project" ? structuredClone(project) : { count: 3 },
  });
  assert.equal(r.reply, "지도 분석 완료");
  assert.equal(r.steps[0].status, "complete");
  assert.equal(requests[0].store, false);
  assert.ok(!JSON.stringify(requests).includes("private@test.com"));
  assert.ok(requests[1].input.some((i) => i.type === "function_call_output"));
});
test("unknown model tool cannot call execute callback", async () => {
  let done = false,
    calls = 0;
  const client = {
    responses: {
      create: async () =>
        ++calls === 1
          ? {
              output: [
                {
                  type: "function_call",
                  name: "deploy",
                  call_id: "c",
                  arguments: "{}",
                },
              ],
            }
          : { output_text: "승인 필요", output: [] },
    },
  };
  await runAgent({
    project,
    message: "임의로 실행",
    useModel: true,
    client,
    executeTool: () => (done = true),
  });
  assert.equal(done, false);
});
test("OSM research based on geography not fabricated flow", () => {
  const a = analyzeArea(project);
  assert.equal(a.inBounds, true);
  assert.ok(a.facilities.length > 20);
  assert.ok(a.stations.length === 3);
  assert.equal(a.tools.find((t) => t.id === "weather").status, "unavailable");
  assert.equal(a.tools.find((t) => t.id === "audience").status, "assumption");
  assert.equal(distanceMetres([127, 37], [127, 37]), 0);
  assert.ok(distanceMetres([127, 37], [127, 37.01]) > 1100);
});

test("local questions, negations, quotations and compound requests never run tools", async () => {
  const prompts = [
    "시뮬레이션을 실행하지 말고 설명만 해줘",
    "시뮬레이션 실행하지 마",
    "시뮬레이션 실행?",
    "16개 안은 어떤 의미야?",
    "16개 후보 생성은 하지 말아줘",
    "방문객 1600명은 많을까?",
    "30×20m 중정 부스 4개로 하면 어떨까?",
    "부스 4개로 변경하지 마",
    "중정",
    "야외 행사 운영에 관해 설명해줘",
    "CRM을 만들지 말아줘",
    "CRM 구축이 뭐야?",
    "주변 상권 분석 기능 설명해줘",
    '"시뮬레이션 실행"',
    "16개 안 생성 후 시뮬레이션 실행",
    "방문객 1600명으로 변경하고 16개 안 생성해줘",
  ];
  for (const message of prompts) {
    assert.deepEqual(localCommands(message), [], message);
    const r = await runAgent({
      project,
      message,
      executeTool: () => assert.fail(`unexpected execution: ${message}`),
    });
    assert.equal(r.steps.length, 0);
    assert.match(r.reply, /실행하지 않았습니다/);
  }
});
test("local allowlist preserves UI shortcuts and numeric changes without substring collisions", () => {
  const commands = [
    ["현재 위치 주변 상권과 접근성을 분석해줘.", "analyze_area", {}],
    [
      "확인한 공간 조건으로 16개 후보 안을 생성해줘.",
      "generate_candidates",
      {},
    ],
    ["현재 실험 조건으로 모든 후보를 시뮬레이션해줘.", "run_simulation", {}],
    ["현장 관측 데이터를 토대로 개선안을 연구해줘.", "review_operations", {}],
    ["16개 후보 생성해줘", "generate_candidates", {}],
    ["시뮬레이션 실행해줘!", "run_simulation", {}],
    ["CRM 만들어줘", "build_crm", {}],
    ["프로젝트 상태 조회", "get_project", {}],
    ["방문객 1600명으로 변경해줘", "update_assumptions", { visitors: 1600 }],
    [
      "30×20m 중정 부스 4개 인력 8명 높이 4m로 설정해줘",
      "propose_space",
      {
        width: 30,
        depth: 20,
        booths: 4,
        staff: 8,
        height: 4,
        family: "courtyard",
      },
    ],
  ];
  for (const [message, name, args] of commands)
    assert.deepEqual(localCommands(message), [[name, args]], message);
});

function scriptedClient(rounds) {
  const requests = [];
  return {
    requests,
    client: {
      responses: {
        create: async (opts) => {
          requests.push(structuredClone(opts));
          const calls = rounds[requests.length - 1];
          return calls
            ? {
                output: calls.map(([name, args], i) => ({
                  type: "function_call",
                  name,
                  arguments: JSON.stringify(args),
                  call_id: `call-${requests.length}-${i}`,
                })),
              }
            : { output: [], output_text: "완료" };
        },
      },
    },
  };
}
function outputs(request) {
  return request.input
    .filter((i) => i.type === "function_call_output")
    .map((i) => JSON.parse(i.output));
}

test("large tool result is complete compact JSON, retaining every candidate metric and live state", async () => {
  const live = createProject("Large simulation");
  const domain = createDomain({ generateCandidates, runBatch, analyzeArea });
  domain.applyAction(live, "UPDATE_SPACE", { confirmed: true });
  domain.applyAction(live, "GENERATE_CANDIDATES");
  domain.applyAction(live, "RUN_SIMULATION");
  const candidateId = live.simulation.recommendedId;
  domain.applyAction(live, "APPROVE_PLAN", { candidateId });
  domain.applyAction(live, "BUILD_CRM");
  domain.applyAction(live, "DEPLOY_CRM");
  assert.ok(JSON.stringify(domain.context(live)).length > 60000);
  const { client, requests } = scriptedClient([[["get_project", {}]]]);
  await runAgent({
    project: structuredClone(domain.context(live)),
    message: "현재 상태를 조회해줘",
    useModel: true,
    client,
    executeTool: (name, args) => domain.executeTool(live, name, args),
  });
  const [out] = outputs(requests[1]);
  assert.equal(out.project.inputRevision, live.inputRevision);
  assert.equal(out.project.version, live.version);
  assert.equal(out.project.selectedId, candidateId);
  assert.equal(out.project.approval.id, live.approval.id);
  assert.equal(out.project.deployment.id, live.crm.deployment.id);
  assert.equal(out.project.simulation.results.length, 16);
  for (const r of out.project.simulation.results) {
    const actual = live.simulation.results.find(
      (a) => a.candidateId === r.candidateId,
    );
    assert.equal(r.completed, actual.completed);
    assert.deepEqual(r.range, actual.range);
    assert.equal(r.sampleCount, 12);
    assert.equal(r.samples, undefined);
    assert.equal(r.timeline, undefined);
  }
  assert.ok(
    requests[1].input.find((i) => i.type === "function_call_output").output
      .length < 60000,
  );
  assert.ok(out.project.crm.schema.slotCount > 0);
  assert.equal(out.project.crm.schema.slots, undefined);
  assert.equal(out.project.candidates[0].scene, undefined);
});

test("model sees current revision and invalidated approval after mutations despite detached initial context", async () => {
  const live = structuredClone({
    ...project,
    version: 9,
    selectedId: "A",
    approval: { id: "old-approval", candidateId: "A", inputRevision: 1 },
    crm: {
      ...project.crm,
      deployment: { id: "deployed-old", candidateId: "A", inputRevision: 1 },
    },
  });
  const initial = structuredClone(live);
  const { client, requests } = scriptedClient([
    [["propose_space", { width: 30 }]],
    [["update_assumptions", { visitors: 1600 }]],
  ]);
  const calls = [];
  await runAgent({
    project: initial,
    message: "폭과 방문자 변경",
    useModel: true,
    client,
    executeTool: (name, args) => {
      calls.push(name);
      if (name === "get_project") return structuredClone(live);
      live.inputRevision++;
      live.selectedId = null;
      live.approval = null;
      if (name === "propose_space")
        live.space = { ...live.space, ...args, confirmed: false };
      if (name === "update_assumptions")
        live.assumptions = { ...live.assumptions, ...args };
      return { ok: true };
    },
  });
  assert.deepEqual(calls, [
    "propose_space",
    "get_project",
    "update_assumptions",
    "get_project",
  ]);
  const first = outputs(requests[1])[0].project,
    last = outputs(requests[2]).at(-1).project;
  assert.equal(first.inputRevision, 2);
  assert.equal(first.space.width, 30);
  assert.equal(first.selectedId, null);
  assert.equal(first.approval, null);
  assert.equal(last.inputRevision, 3);
  assert.equal(last.assumptions.visitors, 1600);
  assert.equal(last.approval, null);
  assert.equal(last.deployment.inputRevision, 1);
  assert.equal(last.deployment.id, "deployed-old");
  assert.equal(initial.inputRevision, 1);
  assert.equal(initial.approval.id, "old-approval");
});
test("failed tools return an error with current state; failed state refresh stops model continuation", async () => {
  const first = scriptedClient([[["run_simulation", {}]]]);
  await runAgent({
    project,
    message: "실행",
    useModel: true,
    client: first.client,
    executeTool: (name) => {
      if (name === "get_project") return structuredClone(project);
      throw new Error("치수 확인 필요");
    },
  });
  const out = outputs(first.requests[1])[0];
  assert.equal(out.ok, false);
  assert.match(out.result.error, /치수 확인/);
  assert.equal(out.project.inputRevision, 1);
  const second = scriptedClient([[["analyze_area", {}]]]);
  await assert.rejects(
    runAgent({
      project,
      message: "분석",
      useModel: true,
      client: second.client,
      executeTool: () => ({ count: 3 }),
    }),
    /최신 프로젝트 상태/,
  );
  assert.equal(second.requests.length, 1);
});
test("local and legacy history never cross model boundary, including get_project results", async () => {
  const p = structuredClone(project);
  const { connectionId, provider } = getModelConfiguration();
  p.messages = [
    { role: "user", mode: "local", content: "LOCAL_PRIVATE_SENTINEL" },
    { role: "assistant", mode: "local", content: "LOCAL_REPLY_SENTINEL" },
    { role: "user", content: "LEGACY_PRIVATE_SENTINEL" },
    {
      role: "user",
      mode: "local",
      useModel: true,
      content: "CONFLICTED_PRIVATE_SENTINEL",
    },
    {
      role: "user",
      mode: "model",
      useModel: false,
      content: "DECLINED_PRIVATE_SENTINEL",
    },
    {
      role: "assistant",
      mode: "model",
      useModel: false,
      content: "DECLINED_REPLY_SENTINEL",
    },
    { role: "user", mode: "model", content: "MISSING_USER_OPT_IN_SENTINEL" },
    { role: "user", useModel: true, content: "LEGACY_MODEL_OPT_IN_PRIVATE" },
    {
      role: "user",
      useModel: true,
      content: "EXPLICIT_MODEL_OPT_IN_SENTINEL",
      connectionId,
      provider,
    },
    {
      role: "user",
      mode: "model",
      useModel: true,
      content: "CONSENTED_HISTORY_SENTINEL",
      connectionId,
      provider,
    },
    {
      role: "assistant",
      mode: "model",
      content: "CONSENTED_REPLY_SENTINEL",
      connectionId,
      provider,
    },
  ];
  const { client, requests } = scriptedClient([[["get_project", {}]]]);
  await runAgent({
    project: p,
    message: "지금 보낼 질문",
    useModel: true,
    client,
    executeTool: () => structuredClone(p),
  });
  const sent = JSON.stringify(requests);
  for (const value of [
    "LOCAL_PRIVATE_SENTINEL",
    "LOCAL_REPLY_SENTINEL",
    "LEGACY_PRIVATE_SENTINEL",
    "LEGACY_MODEL_OPT_IN_PRIVATE",
    "CONFLICTED_PRIVATE_SENTINEL",
    "DECLINED_PRIVATE_SENTINEL",
    "DECLINED_REPLY_SENTINEL",
    "MISSING_USER_OPT_IN_SENTINEL",
    "private@test.com",
  ])
    assert.ok(!sent.includes(value), value);
  assert.ok(sent.includes("EXPLICIT_MODEL_OPT_IN_SENTINEL"));
  assert.ok(sent.includes("CONSENTED_HISTORY_SENTINEL"));
  assert.ok(sent.includes("CONSENTED_REPLY_SENTINEL"));
  assert.equal(outputs(requests[1])[0].project.messages, undefined);
});

test("operations model context retains quality evidence, proposed assumptions and paired metrics without notes", async () => {
  const live = createProject("Operations evidence");
  const domain = createDomain({ generateCandidates, runBatch, analyzeArea });
  domain.applyAction(live, "UPDATE_SPACE", { confirmed: true });
  domain.applyAction(live, "GENERATE_CANDIDATES");
  domain.applyAction(live, "RUN_SIMULATION");
  domain.applyAction(live, "APPROVE_PLAN", {
    candidateId: live.simulation.recommendedId,
  });
  domain.applyAction(live, "BUILD_CRM");
  domain.applyAction(live, "DEPLOY_CRM");
  live.crm.deployment.appliedAt = "2026-09-19T00:00:00.000Z";
  const observation = {
    visitors: 100,
    completed: 65,
    waitP90: 18,
    consents: 42,
    cost: 3000000,
    completeness: 0.6,
    notes: "PRIVATE_OPERATIONS_NOTES_SENTINEL",
    windowStart: "2026-09-20T03:00:00Z",
    windowEnd: "2026-09-20T05:00:00Z",
  };
  domain.applyAction(live, "ADD_OBSERVATION", observation);
  assert.throws(() => domain.applyAction(live, "RUN_LOOP"), /완전성/);
  domain.applyAction(live, "ADD_OBSERVATION", {
    ...observation,
    completeness: 0.98,
  });
  const { proposal } = domain.applyAction(live, "RUN_LOOP");
  const { client, requests } = scriptedClient([[["review_operations", {}]]]);
  await runAgent({
    project: structuredClone(domain.context(live)),
    message: "운영 근거 검토",
    useModel: true,
    client,
    executeTool: (name, args) => domain.executeTool(live, name, args),
  });
  const current = outputs(requests[1])[0].project;
  assert.deepEqual(
    current.observations.map((o) => o.completeness),
    [0.6, 0.98],
  );
  for (const record of current.observations) {
    assert.equal(record.cost, observation.cost);
    assert.equal(
      record.windowStart,
      new Date(observation.windowStart).toISOString(),
    );
    assert.equal(
      record.windowEnd,
      new Date(observation.windowEnd).toISOString(),
    );
    assert.ok(record.recordedAt);
    assert.equal(record.notes, undefined);
  }
  const exposed = current.loop.proposals[0];
  assert.deepEqual(exposed.assumptions, proposal.assumptions);
  assert.equal(exposed.assumptions.serviceMinutes, 3.4);
  assert.deepEqual(exposed.signal, proposal.signal);
  assert.equal(exposed.observation.completeness, 0.98);
  for (const key of ["baseline", "alternative"]) {
    for (const metric of [
      "rate",
      "waitP90",
      "completed",
      "cost",
      "consents",
      "feasible",
    ])
      assert.equal(exposed[key][metric], proposal[key][metric]);
    assert.deepEqual(exposed[key].range, proposal[key].range);
    assert.equal(exposed[key].samples, undefined);
    assert.equal(exposed[key].sampleCount, live.assumptions.replications);
  }
  assert.equal(exposed.requiresOwnerApproval, true);
  assert.equal(exposed.applied, false);
  assert.equal(exposed.calibrated, false);
  assert.ok(!JSON.stringify(requests).includes(observation.notes));
});
