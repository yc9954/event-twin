import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/http.mjs";
import { createDomain, createProject } from "../server/domain.mjs";
import { runAgent } from "../server/agent.mjs";
import { getModelConfiguration } from "../server/model-provider.mjs";

const domain = createDomain({
  generateCandidates: () => [],
  runBatch: () => ({ results: [] }),
  analyzeArea: () => ({ tools: [] }),
});
const configurations = [
  {
    MODEL_PROVIDER: "nim",
    NIM_BASE_URL: "https://nim-a.invalid/v1",
    NIM_MODEL: "fixture-model",
  },
  {
    MODEL_PROVIDER: "nim",
    NIM_BASE_URL: "https://nim-b.invalid/v1",
    NIM_MODEL: "fixture-model",
  },
  {
    MODEL_PROVIDER: "nim",
    NIM_BASE_URL: "https://nim-b.invalid/v1",
    NIM_MODEL: "different-model",
  },
];

test("domain rejects legacy, null and malformed connection metadata and preserves valid consent IDs", () => {
  const project = createProject("Connection metadata");
  const connectionId = getModelConfiguration(configurations[0]).connectionId;
  for (const value of [undefined, null, "", 7, "not-a-connection"])
    for (const role of ["user", "assistant"])
      project.messages.push({
        role,
        content: "LEGACY_PRIVATE",
        provider: "nim",
        useModel: true,
        mode: "model",
        connectionId: value,
      });
  project.messages.push({
    role: "user",
    content: "ALLOWED",
    provider: "nim",
    useModel: true,
    connectionId,
  });
  const before = structuredClone(project),
    context = domain.context(project);
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].connectionId, connectionId);
  assert.equal(context.messages[0].provider, "nim");
  assert.deepEqual(project, before);
});

test("same-provider endpoint/model changes never replay another connection's history, including get_project output", async () => {
  const project = createProject("Connection-isolated history");
  project.messages = [
    {
      role: "user",
      content: "LEGACY_PRIVATE",
      provider: "nim",
      useModel: true,
    },
    ...configurations.flatMap((env, index) =>
      ["user", "assistant"].map((role) => ({
        role,
        content: `ROUTE_${index}_${role}`,
        provider: "nim",
        useModel: true,
        mode: "model",
        connectionId: getModelConfiguration(env).connectionId,
      })),
    ),
  ];
  for (const [index, env] of configurations.entries()) {
    const requests = [];
    const result = await runAgent({
      project: domain.context(project),
      message: "CURRENT_REQUEST",
      useModel: true,
      env,
      client: {
        chat: {
          completions: {
            create: async (request) => {
              requests.push(structuredClone(request));
              return requests.length === 1
                ? {
                    choices: [
                      {
                        finish_reason: "tool_calls",
                        message: {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              id: "c",
                              type: "function",
                              function: {
                                name: "get_project",
                                arguments: "{}",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  }
                : {
                    choices: [
                      {
                        finish_reason: "stop",
                        message: { role: "assistant", content: "done" },
                      },
                    ],
                  };
            },
          },
        },
      },
      executeTool: () => domain.context(project),
    });
    const serialized = JSON.stringify(requests);
    assert.equal(result.connectionId, getModelConfiguration(env).connectionId);
    assert.ok(!serialized.includes("LEGACY_PRIVATE"));
    for (let other = 0; other < configurations.length; other++)
      for (const role of ["user", "assistant"])
        assert.equal(
          serialized.includes(`ROUTE_${other}_${role}`),
          other === index,
        );
    const summary = JSON.parse(
      requests[1].messages.find((message) => message.role === "tool").content,
    );
    assert.equal(summary.project.messages, undefined);
  }
});

test("SQLite restart preserves model-message connection IDs; NIM endpoint/model transitions do not resend older messages", async (t) => {
  // Every model response is injected: .invalid endpoints must never be contacted.
  const keys = ["MODEL_PROVIDER", "NIM_MODEL", "NIM_BASE_URL", "NIM_API_KEY"];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const dir = await mkdtemp(join(tmpdir(), "event-twin-history-binding-"));
  let app = null,
    stage = 0,
    projectId,
    version,
    connectionId;
  const payloads = [[], [], []],
    savedIds = [];
  t.after(async () => {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  async function start(env) {
    if (app) {
      await app.close();
      app = null;
    }
    Object.assign(process.env, env);
    delete process.env.NIM_API_KEY;
    app = await createAppServer({
      dataDir: dir,
      port: 0,
      scheduler: false,
      dependencies: {
        runAgent: (args) => {
          let round = 0;
          return runAgent({
            ...args,
            client: {
              chat: {
                completions: {
                  create: async (request) => {
                    payloads[stage].push(structuredClone(request));
                    if (++round === 1)
                      return {
                        choices: [
                          {
                            finish_reason: "tool_calls",
                            message: {
                              role: "assistant",
                              content: null,
                              tool_calls: [
                                {
                                  id: `c${stage}`,
                                  type: "function",
                                  function: {
                                    name: "get_project",
                                    arguments: "{}",
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      };
                    return {
                      choices: [
                        {
                          finish_reason: "stop",
                          message: {
                            role: "assistant",
                            content: `SAVED_REPLY_${stage}`,
                          },
                        },
                      ],
                    };
                  },
                },
              },
            },
          });
        },
      },
    });
    await app.listen();
    const base = `http://127.0.0.1:${app.server.address().port}`;
    connectionId = (await (await fetch(base + "/api/health")).json()).provider
      .connectionId;
    savedIds.push(connectionId);
    return async (path, body) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.ok, true, JSON.stringify(value));
      return value;
    };
  }
  for (stage = 0; stage < configurations.length; stage++) {
    const post = await start(configurations[stage]);
    if (stage === 0) {
      const p = (
        await post("/api/projects", { name: "Persisted connection consent" })
      ).project;
      projectId = p.id;
      version = p.version;
    }
    const result = await post(`/api/projects/${projectId}/chat`, {
      message: `SAVED_USER_${stage}`,
      useModel: true,
      expectedVersion: version,
      expectedConnectionId: connectionId,
    });
    version = result.project.version;
    for (const message of result.project.messages.slice(-2))
      assert.equal(message.connectionId, connectionId);
    for (let earlier = 0; earlier < stage; earlier++) {
      const serialized = JSON.stringify(payloads[stage]);
      assert.ok(!serialized.includes(`SAVED_USER_${earlier}`));
      assert.ok(!serialized.includes(`SAVED_REPLY_${earlier}`));
      assert.ok(
        result.project.messages.some(
          (message) =>
            message.content === `SAVED_USER_${earlier}` &&
            message.connectionId === savedIds[earlier],
        ),
      );
    }
    const followup = await post(`/api/projects/${projectId}/chat`, {
      message: `FOLLOWUP_${stage}`,
      useModel: true,
      expectedVersion: version,
      expectedConnectionId: connectionId,
    });
    version = followup.project.version;
    assert.ok(
      payloads[stage][2].messages.some(
        (message) => message.content === `SAVED_USER_${stage}`,
      ),
    );
    assert.ok(
      payloads[stage][2].messages.some(
        (message) => message.content === `SAVED_REPLY_${stage}`,
      ),
    );
  }
  assert.equal(new Set(savedIds).size, 3);
});
