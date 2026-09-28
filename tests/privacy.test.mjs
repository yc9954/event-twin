import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomain, createProject } from "../server/domain.mjs";
import { createAppServer } from "../server/http.mjs";
import { runAgent } from "../server/agent.mjs";
import { getModelConfiguration } from "../server/model-provider.mjs";
const { connectionId: testConnectionId, provider: testProvider } =
  getModelConfiguration();

const domain = createDomain({
  generateCandidates: () => [],
  runBatch: () => ({ results: [] }),
  analyzeArea: () => ({ tools: [] }),
});

function historyFixture() {
  const project = createProject("History privacy test");
  project.messages = [
    { role: "user", content: "LOCAL_USER_PRIVATE", useModel: false },
    { role: "assistant", content: "LOCAL_REPLY_PRIVATE", mode: "local" },
    { role: "user", content: "LEGACY_USER_PRIVATE" },
    { role: "assistant", content: "LEGACY_REPLY_PRIVATE" },
    {
      role: "user",
      content: "EXPLICIT_NO_PRIVATE",
      useModel: false,
      mode: "model",
    },
    {
      role: "assistant",
      content: "EXPLICIT_NO_REPLY_PRIVATE",
      useModel: false,
      mode: "model",
    },
    {
      role: "user",
      content: "CONFLICT_LOCAL_PRIVATE",
      useModel: true,
      mode: "local",
    },
    {
      role: "assistant",
      content: "CONFLICT_REPLY_PRIVATE",
      useModel: true,
      mode: "local",
    },
    { role: "user", content: "MODE_ONLY_PRIVATE", mode: "model" },
    { role: "assistant", content: "NO_MODE_PRIVATE", useModel: true },
    { role: "user", content: "UNKNOWN_OPTIN_PRIVATE", useModel: "true" },
    { role: "system", content: "INVALID_ROLE_PRIVATE", useModel: true },
    { role: "assistant", content: { invalid: true }, mode: "model" },
    {
      role: "user",
      content: "MODEL_USER_ALLOWED",
      connectionId: testConnectionId,
      provider: testProvider,
      useModel: true,
      imageIds: ["PRIVATE_IMAGE_REFERENCE"],
    },
    {
      role: "assistant",
      content: "MODEL_REPLY_ALLOWED",
      connectionId: testConnectionId,
      provider: testProvider,
      mode: "model",
      steps: [{ output: "PRIVATE_RAW_TOOL_DATA" }],
    },
    {
      role: "assistant",
      content: "OPENAI_REPLY_ALLOWED",
      connectionId: testConnectionId,
      provider: testProvider,
      mode: "openai",
      useModel: true,
    },
  ];
  return project;
}

test("model context excludes local, legacy, malformed and explicitly denied history", () => {
  const context = domain.context(historyFixture());
  assert.deepEqual(
    context.messages.map((message) => message.content),
    ["MODEL_USER_ALLOWED", "MODEL_REPLY_ALLOWED", "OPENAI_REPLY_ALLOWED"],
  );
  assert.equal(JSON.stringify(context).includes("PRIVATE"), false);
});

test("approved history retains its opt-in metadata without image or raw tool metadata", () => {
  const { messages } = domain.context(historyFixture());
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].useModel, true);
  assert.equal(messages[1].mode, "model");
  assert.equal(messages[2].mode, "model");
  assert.equal(messages[2].useModel, true);
  for (const message of messages)
    assert.deepEqual(Object.keys(message).sort(), [
      "connectionId",
      "content",
      "mode",
      "provider",
      "role",
      "useModel",
    ]);
});

test("domain context preserves provider-specific consent for the model boundary", () => {
  const project = createProject("Provider consent");
  project.messages = [
    {
      role: "user",
      content: "NVIDIA only",
      connectionId: getModelConfiguration({
        MODEL_PROVIDER: "nvidia",
        NVIDIA_MODEL: "test",
      }).connectionId,
      useModel: true,
      provider: "nvidia",
    },
    {
      role: "assistant",
      content: "NVIDIA reply",
      connectionId: getModelConfiguration({
        MODEL_PROVIDER: "nvidia",
        NVIDIA_MODEL: "test",
      }).connectionId,
      mode: "model",
      provider: "nvidia",
    },
    {
      role: "user",
      content: "OpenAI only",
      connectionId: testConnectionId,
      useModel: true,
      provider: "openai",
    },
  ];
  assert.deepEqual(
    domain.context(project).messages.map((m) => m.provider),
    ["nvidia", "nvidia", "openai"],
  );
});

test("get_project aliases cannot recover filtered local chat or CRM contact details", () => {
  const project = historyFixture();
  project.crm.people.push({
    id: "P-1",
    name: "PRIVATE_NAME",
    email: "PRIVATE_CONTACT@example.invalid",
  });
  project.observations.push({
    id: "OBS-1",
    visitors: 30,
    notes: "PRIVATE_OBSERVATION_NOTES",
  });
  for (const name of [
    "get_project",
    "get_context",
    "get_status",
    "review_operations",
  ]) {
    const result = domain.executeTool(project, name, {});
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false, name);
    assert.equal(result.crm.peopleCount, 1);
  }
});

test("history limit applies after privacy filtering and never changes persisted records", () => {
  const project = createProject("Bounded history");
  project.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user",
    content: `allowed-${index}`,
    useModel: true,
    connectionId: testConnectionId,
    provider: testProvider,
  }));
  project.messages.push(
    ...Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `LOCAL_PRIVATE-${index}`,
      useModel: false,
    })),
  );
  const before = structuredClone(project);
  const context = domain.context(project);
  assert.deepEqual(
    context.messages.map((message) => message.content),
    Array.from({ length: 8 }, (_, index) => `allowed-${index + 4}`),
  );
  context.messages[0].content = "detached view edit";
  assert.deepEqual(project, before);
});

test("HTTP chat keeps local history locally while withholding it from SDK and get_project calls", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "event-twin-privacy-"));
  const requests = [];
  const contexts = [];
  const client = {
    responses: {
      async create(options) {
        requests.push(structuredClone(options));
        return requests.length % 2 === 1
          ? {
              output: [
                {
                  type: "function_call",
                  name: "get_project",
                  call_id: `call-${requests.length}`,
                  arguments: "{}",
                },
              ],
            }
          : { output: [], output_text: "MODEL_REPLY_ALLOWED" };
      },
    },
  };
  const app = await createAppServer({
    dataDir,
    port: 0,
    scheduler: false,
    modelConfigured: true,
    dependencies: {
      generateCandidates: () => [],
      runBatch: () => ({ results: [] }),
      analyzeArea: () => ({ tools: [] }),
      async runAgent(args) {
        contexts.push(structuredClone(args.project));
        if (!args.useModel) return { reply: "LOCAL_REPLY_PRIVATE", steps: [] };
        return runAgent({ ...args, client });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = await app.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const connectionId = (await (await fetch(url + "/api/health")).json())
    .provider.connectionId;
  async function post(path, body) {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  }
  let project = (await post("/api/projects", { name: "Privacy integration" }))
    .project;
  const chat = async (message, useModel) => {
    const result = await post(`/api/projects/${project.id}/chat`, {
      message,
      useModel,
      expectedConnectionId: connectionId,
      imageIds: [],
      expectedVersion: project.version,
    });
    project = result.project;
  };
  await chat("LOCAL_USER_PRIVATE", false);
  assert.equal(requests.length, 0);
  await chat("MODEL_USER_ALLOWED", true);
  await chat("MODEL_FOLLOWUP_ALLOWED", true);
  assert.equal(requests.length, 4);
  assert.equal(project.messages.length, 6);
  assert.equal(project.messages[0].content, "LOCAL_USER_PRIVATE");
  assert.equal(project.messages[0].useModel, false);
  assert.equal(project.messages[1].mode, "local");
  assert.equal(project.messages[2].useModel, true);
  assert.equal(project.messages[3].mode, "model");
  assert.equal(project.messages[0].connectionId, null);
  assert.equal(project.messages[1].connectionId, null);
  assert.ok(
    project.messages
      .slice(2)
      .every((message) => message.connectionId === connectionId),
  );
  assert.ok(
    contexts[2].messages.every(
      (message) => message.connectionId === connectionId,
    ),
  );
  assert.equal(contexts[2].messages[0].useModel, true);
  assert.equal(contexts[2].messages[1].mode, "model");
  assert.equal(JSON.stringify(requests).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(contexts).includes("PRIVATE"), false);
  assert.equal(
    requests[2].input.some(
      (message) =>
        message.role === "user" && message.content === "MODEL_USER_ALLOWED",
    ),
    true,
  );
  assert.equal(
    requests[2].input.some(
      (message) =>
        message.role === "assistant" &&
        message.content === "MODEL_REPLY_ALLOWED",
    ),
    true,
  );
  for (const request of requests) assert.equal(request.store, false);
});
