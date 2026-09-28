import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../server/http.mjs";
import {
  getModelConfiguration,
  modelConnectionId,
} from "../server/model-provider.mjs";
import { api } from "../client/api.js";

// Read-only fixture agents only. These tests make no hosted inference requests.
const envKeys = [
  "MODEL_PROVIDER",
  "OPENAI_MODEL",
  "OPENAI_API_KEY",
  "NVIDIA_MODEL",
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
  "NIM_MODEL",
  "NIM_BASE_URL",
  "NIM_API_KEY",
  "MODEL_FALLBACK_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
];
function isolatedEnvironment(t, overrides = {}) {
  const previous = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}
async function fixture(t, { modelConfigured = true, agent } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-consent-"));
  let calls = 0;
  const app = await createAppServer({
    dataDir: dir,
    port: 0,
    scheduler: false,
    modelConfigured,
    dependencies: {
      runAgent: async (args) => {
        calls++;
        if (agent) return agent(args);
        const config = getModelConfiguration(args.env);
        if (args.project.name.startsWith("연결 검사용")) {
          const p = await args.executeTool("get_project", {});
          return {
            reply: p.brief.goal,
            steps: [{ name: "get_project", status: "complete" }],
            provider: config.provider,
            model: config.model,
          };
        }
        return {
          reply: "fixture response",
          steps: [],
          provider: config.provider,
          model: config.model,
        };
      },
    },
  });
  await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, stream = false) => {
    const response = await fetch(url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stream ? { Accept: "application/x-ndjson" } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      data: text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1),
    };
  };
  const health = await (await fetch(url + "/api/health")).json();
  const p = (await post("/api/projects", { name: "Consent fixture" })).data
    .project;
  return { app, post, p, health, calls: () => calls };
}

test("connection identity binds recipient, model, capability and credential without exposing the credential", () => {
  const config = getModelConfiguration({
    MODEL_PROVIDER: "nvidia",
    NVIDIA_MODEL: "nvidia/test-model",
    NVIDIA_API_KEY: "PRIVATE_KEY_A",
  });
  const changedKey = getModelConfiguration({
    MODEL_PROVIDER: "nvidia",
    NVIDIA_MODEL: "nvidia/test-model",
    NVIDIA_API_KEY: "PRIVATE_KEY_B",
  });
  const absentKey = getModelConfiguration({
    MODEL_PROVIDER: "nvidia",
    NVIDIA_MODEL: "nvidia/test-model",
  });
  assert.match(config.connectionId, /^model-v1-[0-9a-f]{64}$/);
  assert.notEqual(config.connectionId, changedKey.connectionId);
  assert.notEqual(config.connectionId, absentKey.connectionId);
  assert.equal(config.connectionId, modelConnectionId(config, "PRIVATE_KEY_A"));
  for (const patch of [
    { provider: "nim" },
    { model: "another-model" },
    { baseURL: "https://other-recipient.invalid/v1" },
    { capabilities: { ...config.capabilities, images: true } },
    { capabilities: { ...config.capabilities, api: "responses" } },
  ])
    assert.notEqual(
      modelConnectionId({ ...config, ...patch }, "PRIVATE_KEY_A"),
      config.connectionId,
    );
  assert.ok(!JSON.stringify(config).includes("PRIVATE_KEY_A"));
  assert.ok(!JSON.stringify(changedKey).includes("PRIVATE_KEY_B"));
});

test("even short optional NIM credentials change the browser-visible connection identity", () => {
  const base = {
    MODEL_PROVIDER: "nim",
    NIM_MODEL: "fixture-model",
    NIM_BASE_URL: "http://127.0.0.1:8000/v1",
  };
  const first = getModelConfiguration({ ...base, NIM_API_KEY: "a" });
  const second = getModelConfiguration({ ...base, NIM_API_KEY: "b" });
  const absent = getModelConfiguration(base);
  assert.notEqual(first.connectionId, second.connectionId);
  assert.notEqual(first.connectionId, absent.connectionId);
  assert.ok(!JSON.stringify(first).includes('"NIM_API_KEY":"a"'));
  assert.match(first.connectionId, /^model-v1-[0-9a-f]{64}$/);
});

test("model chat rejects absent, empty, malformed and stale recipient consent before any agent/image/tool work", async (t) => {
  isolatedEnvironment(t, { MODEL_PROVIDER: "openai" });
  const f = await fixture(t);
  for (const stream of [false, true])
    for (const expectedConnectionId of [
      undefined,
      "",
      null,
      7,
      "model-v1-stale",
    ]) {
      const result = await f.post(
        `/api/projects/${f.p.id}/chat`,
        {
          message: "private fixture text",
          useModel: true,
          imageIds: [],
          expectedVersion: f.p.version,
          expectedConnectionId,
        },
        stream,
      );
      assert.equal(result.status, 409);
      assert.equal(result.data.code, "MODEL_CONNECTION_CHANGED");
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.app.store.get(f.p.id), f.p);
    }
  const accepted = await f.post(`/api/projects/${f.p.id}/chat`, {
    message: "consented fixture",
    useModel: true,
    imageIds: [],
    expectedVersion: f.p.version,
    expectedConnectionId: f.health.provider.connectionId,
  });
  assert.equal(accepted.status, 200);
  assert.equal(f.calls(), 1);
  assert.equal(accepted.data.project.version, f.p.version + 1);
});

test("local chat preserves legacy API compatibility and never needs model recipient consent", async (t) => {
  isolatedEnvironment(t, { MODEL_PROVIDER: "nvidia" });
  const f = await fixture(t, { modelConfigured: false });
  const result = await f.post(`/api/projects/${f.p.id}/chat`, {
    message: "프로젝트 상태 조회",
    useModel: false,
    imageIds: [],
    expectedVersion: f.p.version,
  });
  assert.equal(result.status, 200);
  assert.equal(f.calls(), 1);
});

test("connection probe needs current recipient identity even when confirm is true, without consuming a failed-consent attempt", async (t) => {
  isolatedEnvironment(t, { MODEL_PROVIDER: "openai" });
  const f = await fixture(t);
  for (const expectedConnectionId of [undefined, "", "stale"]) {
    const result = await f.post("/api/integrations/check", {
      confirm: true,
      expectedConnectionId,
    });
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "MODEL_CONNECTION_CHANGED");
    assert.equal(f.calls(), 0);
  }
  const result = await f.post("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: f.health.provider.connectionId,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.check.status, "verified");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.app.store.get(f.p.id), f.p);
});

test("matching consent on an unconfigured connection remains unconfigured, not a fallback", async (t) => {
  isolatedEnvironment(t, { MODEL_PROVIDER: "nvidia" });
  const f = await fixture(t, { modelConfigured: false });
  const result = await f.post(`/api/projects/${f.p.id}/chat`, {
    message: "private text",
    useModel: true,
    expectedVersion: f.p.version,
    expectedConnectionId: f.health.provider.connectionId,
  });
  assert.equal(result.status, 503);
  assert.equal(result.data.code, "MODEL_NOT_CONFIGURED");
  assert.equal(f.calls(), 0);
  const check = await f.post("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: f.health.provider.connectionId,
  });
  assert.equal(check.data.check.status, "not-configured");
  assert.equal(f.calls(), 0);
});

test("server freezes the consented route for both chat and probe; environment mutation cannot silently change execution", async (t) => {
  isolatedEnvironment(t, {
    MODEL_PROVIDER: "openai",
    OPENAI_MODEL: "fixture-original",
  });
  const configurations = [];
  const f = await fixture(t, {
    agent: async (args) => {
      const config = getModelConfiguration(args.env);
      configurations.push(config);
      if (args.project.name.startsWith("연결 검사용"))
        return {
          reply: (await args.executeTool("get_project", {})).brief.goal,
          steps: [{ name: "get_project", status: "complete" }],
          provider: config.provider,
          model: config.model,
        };
      return {
        reply: "ok",
        steps: [],
        provider: config.provider,
        model: config.model,
      };
    },
  });
  process.env.MODEL_PROVIDER = "nvidia";
  process.env.NVIDIA_MODEL = "fixture-new";
  await f.post(`/api/projects/${f.p.id}/chat`, {
    message: "consented",
    useModel: true,
    expectedVersion: f.p.version,
    expectedConnectionId: f.health.provider.connectionId,
  });
  await f.post("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: f.health.provider.connectionId,
  });
  assert.equal(configurations.length, 2);
  assert.ok(
    configurations.every(
      (c) =>
        c.connectionId === f.health.provider.connectionId &&
        c.provider === "openai" &&
        c.model === "fixture-original",
    ),
  );
  const changedConfig = getModelConfiguration();
  assert.notEqual(changedConfig.connectionId, f.health.provider.connectionId);
});

test("a browser carrying the previous provider identity cannot send text or probe a newly started provider", async (t) => {
  isolatedEnvironment(t, {
    MODEL_PROVIDER: "openai",
    OPENAI_MODEL: "fixture-openai",
  });
  const previous = await fixture(t);
  process.env.MODEL_PROVIDER = "nvidia";
  process.env.NVIDIA_MODEL = "nvidia/fixture-nemotron";
  const next = await fixture(t);
  assert.notEqual(
    previous.health.provider.connectionId,
    next.health.provider.connectionId,
  );
  for (const stream of [false, true]) {
    const result = await next.post(
      `/api/projects/${next.p.id}/chat`,
      {
        message: "Text only consented for previous provider",
        useModel: true,
        expectedVersion: next.p.version,
        expectedConnectionId: previous.health.provider.connectionId,
      },
      stream,
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "MODEL_CONNECTION_CHANGED");
  }
  const probe = await next.post("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: previous.health.provider.connectionId,
  });
  assert.equal(probe.status, 409);
  assert.equal(next.calls(), 0);
  assert.deepEqual(next.app.store.get(next.p.id), next.p);
});

test("rotating only the provider key invalidates prior chat and probe consent", async (t) => {
  isolatedEnvironment(t, {
    MODEL_PROVIDER: "nvidia",
    NVIDIA_MODEL: "nvidia/fixture-nemotron",
    NVIDIA_API_KEY: "fixture-key-A",
  });
  const previous = await fixture(t);
  process.env.NVIDIA_API_KEY = "fixture-key-B";
  const next = await fixture(t);
  assert.notEqual(
    previous.health.provider.connectionId,
    next.health.provider.connectionId,
  );
  for (const stream of [false, true]) {
    const result = await next.post(
      `/api/projects/${next.p.id}/chat`,
      {
        message: "Text consented only for the earlier key",
        useModel: true,
        expectedVersion: next.p.version,
        expectedConnectionId: previous.health.provider.connectionId,
      },
      stream,
    );
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "MODEL_CONNECTION_CHANGED");
  }
  const probe = await next.post("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: previous.health.provider.connectionId,
  });
  assert.equal(probe.status, 409);
  assert.equal(probe.data.code, "MODEL_CONNECTION_CHANGED");
  assert.equal(next.calls(), 0);
  assert.deepEqual(next.app.store.get(next.p.id), next.p);
});

test("frontend forwards the displayed consent identity for JSON, streaming and explicit probes without automatic refresh/retry", async (t) => {
  const received = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    received.push({ path, body: JSON.parse(options.body) });
    return Response.json(
      { error: "connection changed", code: "MODEL_CONNECTION_CHANGED" },
      { status: 409 },
    );
  });
  for (const callback of [undefined, () => {}])
    await assert.rejects(
      api.chat("p", "private", 1, true, [], callback, "displayed-connection"),
      (error) =>
        error.status === 409 && error.code === "MODEL_CONNECTION_CHANGED",
    );
  await assert.rejects(
    api.checkIntegration("displayed-connection"),
    (error) => error.code === "MODEL_CONNECTION_CHANGED",
  );
  assert.equal(received.length, 3);
  assert.ok(
    received.every(
      (r) => r.body.expectedConnectionId === "displayed-connection",
    ),
  );
  assert.ok(received.every((r) => r.path !== "/api/health"));
});

test('HTTP requires consent to the fallback recipient and persists actual Claude attribution', async t => {
  isolatedEnvironment(t, { MODEL_PROVIDER: 'nvidia', NVIDIA_MODEL: 'fixture-primary', NVIDIA_API_KEY: 'fixture-nvidia',
    MODEL_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_API_KEY: 'fixture-claude' });
  const fallback = { from: 'nvidia', to: 'anthropic', model: 'claude-sonnet-4-6', reason: 'MODEL_REQUEST_FAILED', round: 1 };
  const app = await fixture(t, { agent: async args => {
    await args.onEvent?.({ type: 'model.fallback', ...fallback });
    return { reply: 'Real provider attribution fixture', steps: [], provider: 'anthropic', model: fallback.model, modelContext: { fallback } };
  } });
  const body = { message: '읽기 전용 상태 설명', useModel: true, expectedVersion: app.p.version };
  const old = getModelConfiguration({ ...process.env, MODEL_FALLBACK_PROVIDER: '' }).connectionId;
  const rejected = await app.post(`/api/projects/${app.p.id}/chat`, { ...body, expectedConnectionId: old });
  assert.equal(rejected.status, 409);
  assert.equal(app.calls(), 0);
  assert.equal(app.health.provider.fallback.configured, true);
  const response = await app.post(`/api/projects/${app.p.id}/chat`, { ...body, expectedConnectionId: app.health.provider.connectionId }, true);
  assert.equal(response.data.type, 'response.completed');
  assert.equal(response.data.committed, true);
  const saved = app.app.store.get(app.p.id).messages;
  assert.ok(saved.every(m => m.provider === 'anthropic' && m.connectionId === app.health.provider.connectionId));
  assert.equal(saved.at(-1).model, fallback.model);
  assert.deepEqual(saved.at(-1).modelContext.fallback, fallback);
  assert.equal(JSON.stringify(saved).includes('fixture-claude'), false);
});
