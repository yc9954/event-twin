import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/http.mjs";
import { createProject, createDomain } from "../server/domain.mjs";
import { runAgent, sanitizeAgentEvent } from "../server/agent.mjs";

const deps = {
  generateCandidates: () => [],
  runBatch: () => ({ results: [] }),
  analyzeArea: () => ({
    tools: [],
    source: "stream-test",
    privateOutput: "RAW_OUTPUT_PRIVATE",
  }),
};
const domain = createDomain(deps);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function modelClient(secondResponse) {
  let calls = 0;
  return {
    responses: {
      async create() {
        if (++calls === 1)
          return {
            output: [
              {
                type: "function_call",
                name: "update_assumptions",
                arguments: '{"visitors":1300}',
                call_id: "c-1",
              },
            ],
          };
        if (secondResponse) return secondResponse();
        return { output: [], output_text: "계산 조건을 저장했습니다." };
      },
    },
  };
}
async function fixture(t, { agent = runAgent, configured = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-stream-"));
  const app = await createAppServer({
    dataDir: dir,
    port: 0,
    scheduler: false,
    modelConfigured: configured,
    dependencies: { ...deps, runAgent: agent },
  });
  await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const connectionId = (await (await fetch(url + "/api/health")).json())
    .provider.connectionId;
  const post = (path, body, stream = false, options = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stream ? { Accept: "application/x-ndjson" } : {}),
      },
      body: JSON.stringify(body),
      ...options,
    });
  const p = (
    await (await post("/api/projects", { name: "Streaming fixture" })).json()
  ).project;
  return {
    app,
    url,
    post,
    p,
    chat: (extra = {}, stream = true, options) =>
      post(
        `/api/projects/${p.id}/chat`,
        {
          message: "상권 분석",
          expectedVersion: p.version,
          useModel: false,
          imageIds: [],
          expectedConnectionId: connectionId,
          ...extra,
        },
        stream,
        options,
      ),
  };
}
async function collect(response) {
  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("agent lifecycle reflects real execution; progress contains no raw tool output or secrets", async () => {
  const project = createProject("Lifecycle"),
    events = [];
  const result = await runAgent({
    project,
    message: "상권 분석",
    onEvent(event) {
      events.push(event);
    },
    executeTool(name) {
      assert.equal(events.at(-1).type, "tool.started");
      assert.equal(events.at(-1).name, name);
      return { email: "PRIVATE@example.invalid", secret: "PRIVATE_SECRET" };
    },
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["request.accepted", "tool.started", "tool.completed"],
  );
  assert.equal(events[1].stepId, events[2].stepId);
  assert.equal(events[2].status, "complete");
  assert.equal(result.steps[0].output.secret, "PRIVATE_SECRET");
  assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
  for (const e of events) assert.ok(Number.isFinite(Date.parse(e.at)));
});

test("progress sanitizer allows only tool identifiers and known scalar business inputs", () => {
  const event = sanitizeAgentEvent({
    type: "tool.started",
    name: "propose_space",
    stepId: "d99b8f6b-4423-4790-9daa-095ac37cd901",
    inputSummary: {
      width: 24,
      depth: 18,
      family: "courtyard",
      email: "PRIVATE_EMAIL",
      prompt: "PRIVATE_PROMPT",
      height: { secret: true },
    },
    output: "PRIVATE_OUTPUT",
    error: "PRIVATE_ERROR",
    thoughts: "PRIVATE_REASONING",
  });
  assert.deepEqual(event.inputSummary, {
    width: 24,
    depth: 18,
    family: "courtyard",
  });
  assert.equal(JSON.stringify(event).includes("PRIVATE"), false);
  assert.equal(
    sanitizeAgentEvent({ type: "thought.delta", text: "PRIVATE" }),
    null,
  );
  assert.equal(sanitizeAgentEvent({ type: "model.awaiting", round: 7 }), null);
  assert.equal(
    sanitizeAgentEvent({
      type: "tool.started",
      name: "send_email",
      stepId: "invalid",
    }),
    null,
  );
});

test("fixture model emits actual rounds and tools; a failed observer cannot change execution", async () => {
  const project = createProject("Model lifecycle"),
    events = [];
  const result = await runAgent({
    project: domain.context(project),
    message: "방문객을 1300명으로 변경",
    useModel: true,
    client: modelClient(),
    executeTool: (name, args) => domain.executeTool(project, name, args),
    async onEvent(event) {
      events.push(event);
      throw new Error("observer unavailable");
    },
  });
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "request.accepted",
      "model.awaiting",
      "tool.started",
      "tool.completed",
      "model.awaiting",
    ],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "model.awaiting").map((e) => e.round),
    [1, 2],
  );
  assert.equal(project.assumptions.visitors, 1300);
  assert.equal(result.steps[0].status, "complete");
});

test("HTTP stream starts before tool completion and keeps version lock until atomic commit", async (t) => {
  const started = deferred(),
    finish = deferred();
  t.after(() => finish.resolve());
  const f = await fixture(t, {
    agent: (args) =>
      runAgent({
        ...args,
        executeTool: async (name, values) => {
          started.resolve();
          await finish.promise;
          return args.executeTool(name, values);
        },
      }),
  });
  const response = await f.chat();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes('"tool.started"'))
    buffer += decoder.decode((await reader.read()).value);
  await started.promise;
  assert.equal(f.app.store.get(f.p.id).version, f.p.version);
  assert.equal(f.app.store.get(f.p.id).research, null);
  const competing = f.post(`/api/projects/${f.p.id}/actions`, {
    type: "UPDATE_ASSUMPTIONS",
    payload: { visitors: 99 },
    expectedVersion: f.p.version,
  });
  finish.resolve();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value);
  }
  reader.releaseLock();
  const events = buffer.trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    events.map((e) => e.sequence),
    [1, 2, 3, 4],
  );
  assert.equal(new Set(events.map((e) => e.requestId)).size, 1);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).committed, true);
  assert.equal(events.at(-1).data.project.version, f.p.version + 1);
  assert.equal(
    events.at(-1).data.steps[0].output.privateOutput,
    "RAW_OUTPUT_PRIVATE",
  );
  assert.equal(
    JSON.stringify(events.slice(0, -1)).includes("RAW_OUTPUT_PRIVATE"),
    false,
  );
  assert.equal((await competing).status, 409);
  assert.equal(f.app.store.get(f.p.id).messages.length, 2);
});

test("HTTP model deltas stream before commit and persisted context survives a fresh project read", async (t) => {
  const f = await fixture(t, { configured: true, agent: async ({ onEvent }) => {
    await onEvent({ type: "request.accepted", mode: "model" });
    await onEvent({ type: "model.awaiting", round: 1, inputRevision: 1, historyMessages: 0, selectedImages: 0 });
    await onEvent({ type: "response.delta", round: 1, text: "공개 " });
    await onEvent({ type: "response.delta", round: 1, text: "답변" });
    return { reply: "공개 답변", steps: [], mode: "model", provider: "nvidia", model: "fixture-model",
      modelContext: { inputRevision: 1, historyMessages: 0, availableTools: 8, selectedImages: 0 },
      modelActivity: [{ round: 1, text: "공개 답변", toolNames: [] }] };
  } });
  const events = await collect(await f.chat({ useModel: true, message: "읽기 전용 질문" }));
  assert.deepEqual(events.map(event => event.type), ["request.accepted", "model.awaiting", "response.delta", "response.delta", "response.completed"]);
  assert.equal(events.filter(event => event.type === "response.delta").map(event => event.text).join(""), "공개 답변");
  assert.equal(events.at(-1).committed, true);
  const saved = (await (await fetch(`${f.url}/api/projects/${f.p.id}`)).json()).project;
  assert.equal(saved.messages.at(-1).content, "공개 답변");
  assert.equal(saved.messages.at(-1).modelContext.availableTools, 8);
  assert.equal(saved.messages.at(-1).modelActivity[0].text, "공개 답변");
});

test("local tool failure is a truthful failed step, not a failed/rolled-back conversation", async (t) => {
  const f = await fixture(t);
  const response = await f.chat({ message: "시뮬레이션 실행" });
  const events = await collect(response);
  assert.deepEqual(
    events.map((e) => e.type),
    ["request.accepted", "tool.started", "tool.failed", "response.completed"],
  );
  assert.equal(events[2].status, "failed");
  assert.equal(events[2].error, undefined);
  assert.equal(events.at(-1).committed, true);
  assert.equal(events.at(-1).data.steps[0].status, "failed");
  assert.equal(f.app.store.get(f.p.id).messages.length, 2);
});

test("provider failure preserves partial receipts and in-band 429 while rolling back all draft mutations", async (t) => {
  const client = modelClient(() => {
    throw Object.assign(new Error("PRIVATE_PROVIDER_KEY"), {
      status: 429,
      code: "credit_balance_exhausted",
    });
  });
  const f = await fixture(t, {
    configured: true,
    agent: (args) => runAgent({ ...args, client }),
  });
  const response = await f.chat({ message: "방문객 변경", useModel: true });
  const events = await collect(response),
    terminal = events.at(-1);
  assert.equal(response.status, 200); // Headers were sent before the provider failed.
  assert.equal(terminal.type, "response.failed");
  assert.equal(terminal.status, 429);
  assert.equal(terminal.code, "MODEL_CREDITS_EXHAUSTED");
  assert.equal(terminal.committed, false);
  assert.ok(terminal.events.some((e) => e.type === "tool.completed"));
  assert.equal(JSON.stringify(events).includes("PRIVATE_PROVIDER_KEY"), false);
  const saved = f.app.store.get(f.p.id);
  assert.equal(saved.version, f.p.version);
  assert.equal(saved.assumptions.visitors, f.p.assumptions.visitors);
  assert.equal(saved.messages.length, 0);
  const retry = await f.post(`/api/projects/${f.p.id}/actions`, {
    type: "UPDATE_ASSUMPTIONS",
    payload: { visitors: 900 },
    expectedVersion: f.p.version,
  });
  assert.equal(retry.status, 200);
});

test("stream validation errors preserve real HTTP status and never start tools or image loading", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    agent: async () => {
      calls++;
      throw new Error("Should not execute");
    },
  });
  for (const [input, status, code] of [
    [{ expectedVersion: 2 }, 409, "VERSION_CONFLICT"],
    [{ useModel: true }, 503, "MODEL_NOT_CONFIGURED"],
    [{ imageIds: ["IMG-other-project"] }, 400, "INVALID_INPUT"],
  ]) {
    const response = await f.chat(input),
      events = await collect(response);
    assert.equal(response.status, status);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "response.failed");
    assert.equal(events[0].code, code);
    assert.equal(events[0].committed, false);
  }
  assert.equal(calls, 0);
  assert.equal(f.app.store.get(f.p.id).version, 1);
});

test("legacy JSON route remains unchanged on success and model error", async (t) => {
  const f = await fixture(t);
  const response = await f.chat({}, false),
    data = await response.json();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(Object.keys(data).sort(), ["project", "reply", "steps"]);
  assert.equal(data.project.version, 2);
  const invalid = await f.chat({ useModel: true }, false);
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).code, "MODEL_NOT_CONFIGURED");
});

test("disconnecting an observer does not release the transaction lock or falsely cancel an accepted tool", async (t) => {
  const finish = deferred(),
    done = deferred();
  t.after(() => finish.resolve());
  const f = await fixture(t, {
    agent: (args) =>
      runAgent({
        ...args,
        executeTool: async (name, values) => {
          await finish.promise;
          const output = args.executeTool(name, values);
          done.resolve();
          return output;
        },
      }),
  });
  const response = await f.chat();
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  finish.resolve();
  await done.promise;
  // Queue a read-only mutation to await the existing per-project transaction.
  await f.app.store.mutate(f.p.id, undefined, () => ({ noChange: true }), {
    internal: true,
  });
  const saved = f.app.store.get(f.p.id);
  assert.equal(saved.version, 2);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.research.source, "stream-test");
});
