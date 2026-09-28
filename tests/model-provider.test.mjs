import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../server/http.mjs";
import {
  getModelConfiguration,
  createModelClient,
  assertImageCapability,
} from "../server/model-provider.mjs";
import { runAgent, agentTools } from "../server/agent.mjs";

// All credentials/responses in this file are fixtures. No hosted service calls.
const hosted = {
  MODEL_PROVIDER: "nvidia",
  NVIDIA_MODEL: "nvidia/fixture-tool-model",
  NVIDIA_API_KEY: "fixture-nvidia-key",
};
const nim = {
  MODEL_PROVIDER: "nim",
  NIM_MODEL: "fixture-nim-model",
  NIM_BASE_URL: "http://127.0.0.1:8000/v1",
};
const project = {
  id: "fixture-project",
  inputRevision: 1,
  name: "Public test event",
  brief: {},
  space: {},
  assumptions: {},
  candidates: [],
  crm: {
    people: [{ name: "PII_SENTINEL", email: "PRIVATE_EMAIL_SENTINEL" }],
    tasks: [],
  },
  observations: [],
  messages: [
    { role: "user", content: "LOCAL_SENTINEL", useModel: false },
    {
      role: "user",
      content: "CONSENT_SENTINEL",
      connectionId: getModelConfiguration(hosted).connectionId,
      useModel: true,
      provider: "nvidia",
    },
  ],
};
const call = (name = "get_project", id = "call_1", args = "{}") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
const completion = (
  message = { content: "실제 테스트 서버의 응답입니다." },
  finish_reason = message.tool_calls?.length ? "tool_calls" : "stop",
) => ({
  id: "fixture-completion",
  choices: [
    {
      index: 0,
      finish_reason,
      message: { role: "assistant", content: null, ...message },
    },
  ],
});
const request = {
  input: [
    { role: "developer", content: "Safe guidance" },
    { role: "user", content: [{ type: "input_text", text: "Check tools" }] },
  ],
  tools: agentTools,
  max_output_tokens: 3000,
};
const fixtureClient = (create) => ({ chat: { completions: { create } } });

test("supported Nemotron hosted tool loops reserve output for answers without changing other provider profiles", async () => {
  const model = "nvidia/nemotron-3.5-lightning-30b-a3b";
  const managedModel = "nvidia/nemotron-3-super-120b-a12b";
  for (const env of [
    { ...hosted, NVIDIA_MODEL: model },
    { ...hosted, NVIDIA_MODEL: managedModel },
    hosted,
    { ...hosted, NVIDIA_MODEL: `${model}-other` },
    { ...nim, NIM_MODEL: model },
  ]) {
    let sent;
    const adapter = createModelClient({ env, client: fixtureClient(async payload => {
      sent = payload;
      return completion();
    }) });
    await adapter.createResponse(request);
    if (env.MODEL_PROVIDER === "nvidia" && [model, managedModel].includes(env.NVIDIA_MODEL))
      assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: false });
    else assert.equal(Object.hasOwn(sent, "chat_template_kwargs"), false);
    assert.equal(sent.max_tokens, 3000);
    assert.equal(sent.tool_choice, "auto");
  }
});

test("configuration registry defaults only to OpenAI; explicit NVIDIA/NIM never borrow OpenAI credentials", () => {
  const empty = getModelConfiguration({});
  assert.equal(empty.provider, "openai");
  assert.equal(empty.model, "gpt-6-astra");
  assert.deepEqual(empty.missing, ["OPENAI_API_KEY"]);
  const openai = getModelConfiguration({
    OPENAI_API_KEY: "PRIVATE_OPENAI_KEY",
  });
  assert.equal(openai.configured, true);
  assert.equal(openai.verified, false);
  const missing = getModelConfiguration({
    MODEL_PROVIDER: "nvidia",
    OPENAI_API_KEY: "PRIVATE_OPENAI_KEY",
  });
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missing, ["NVIDIA_MODEL", "NVIDIA_API_KEY"]);
  assert.equal(missing.baseURL, "https://integrate.api.nvidia.com/v1");
  assert.equal(getModelConfiguration(hosted).configured, true);
  assert.equal(getModelConfiguration(nim).configured, true);
  assert.equal(
    getModelConfiguration({ MODEL_PROVIDER: "nim" }).configured,
    false,
  );
  assert.deepEqual(getModelConfiguration({ MODEL_PROVIDER: "nim" }).missing, [
    "NIM_MODEL",
    "NIM_BASE_URL",
  ]);
  for (const env of [hosted, nim, { OPENAI_API_KEY: "PRIVATE_OPENAI_KEY" }]) {
    const json = JSON.stringify(getModelConfiguration(env));
    assert.ok(
      !json.includes("PRIVATE_OPENAI_KEY") &&
        !json.includes("fixture-nvidia-key"),
    );
  }
});

test("configuration rejects unknown providers and credential-bearing/insecure URLs without echoing secrets", () => {
  for (const provider of ["wrong", "constructor", "__proto__"])
    assert.equal(
      getModelConfiguration({ MODEL_PROVIDER: provider }).provider,
      "invalid",
    );
  for (const url of [
    "https://user:PRIVATE_URL_SECRET@example.com/v1",
    "https://example.com/v1?token=PRIVATE_URL_SECRET",
    "https://example.com/v1#PRIVATE_URL_SECRET",
    "http://remote-gpu.test/v1",
    "https://example.com/chat/completions",
    "file:///v1",
  ]) {
    const config = getModelConfiguration({ ...nim, NIM_BASE_URL: url });
    assert.equal(config.configured, false, url);
    assert.equal(config.baseURL, null);
    assert.ok(!JSON.stringify(config).includes("PRIVATE_URL_SECRET"));
  }
  assert.equal(
    getModelConfiguration({
      ...nim,
      NIM_BASE_URL: "https://remote-gpu.test/v1/",
    }).baseURL,
    "https://remote-gpu.test/v1",
  );
  assert.equal(
    getModelConfiguration({
      ...hosted,
      NVIDIA_BASE_URL: "http://127.0.0.1:9000/v1",
    }).configured,
    false,
  );
});

test("SDK configuration isolates keys, organization/project and redirects; NIM can omit auth", () => {
  for (const env of [
    { ...hosted, OPENAI_API_KEY: "WRONG_KEY" },
    { ...nim, OPENAI_API_KEY: "WRONG_KEY" },
    { ...nim, NIM_API_KEY: "fixture-nim-key" },
  ]) {
    let options;
    createModelClient({
      env,
      sdkFactory: (opts) => {
        options = opts;
        return {};
      },
    });
    assert.notEqual(options.apiKey, "WRONG_KEY");
    assert.equal(options.organization, null);
    assert.equal(options.project, null);
    assert.equal(options.maxRetries, 0);
    if (env.MODEL_PROVIDER === "nvidia")
      assert.equal(options.apiKey, "fixture-nvidia-key");
    else if (env.NIM_API_KEY) assert.equal(options.apiKey, env.NIM_API_KEY);
    else assert.equal(options.defaultHeaders.Authorization, null);
  }
});

test("chat adapter sends OpenAI-compatible schemas and translates multi-tool assistant/results without reasoning", async () => {
  const payloads = [];
  const adapter = createModelClient({
    env: hosted,
    client: fixtureClient(async (payload) => {
      payloads.push(structuredClone(payload));
      return payloads.length === 1
        ? completion({
            content: "도구를 확인합니다.",
            tool_calls: [call(), call("review_operations", "call_2")],
            reasoning_content: "HIDDEN_REASONING_SENTINEL",
          })
        : completion();
    }),
  });
  const first = await adapter.createResponse(request);
  assert.equal(
    first.output.filter((item) => item.type === "function_call").length,
    2,
  );
  assert.ok(!JSON.stringify(first).includes("HIDDEN_REASONING_SENTINEL"));
  await adapter.createResponse({
    ...request,
    input: [
      ...request.input,
      ...first.output,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"ok":true}',
      },
      {
        type: "function_call_output",
        call_id: "call_2",
        output: '{"ok":true}',
      },
    ],
  });
  assert.equal(payloads[0].model, hosted.NVIDIA_MODEL);
  assert.equal(payloads[0].messages[0].role, "system");
  assert.equal(payloads[0].messages[1].content, "Check tools");
  assert.equal(payloads[0].tools[0].function.name, "get_project");
  assert.equal(payloads[0].stream, false);
  assert.equal(payloads[0].max_tokens, 3000);
  assert.ok(
    !("store" in payloads[0]) &&
      !("input" in payloads[0]) &&
      !("instructions" in payloads[0]),
  );
  assert.deepEqual(
    payloads[1].messages[2].tool_calls.map((item) => item.id),
    ["call_1", "call_2"],
  );
  assert.deepEqual(
    payloads[1].messages
      .slice(-2)
      .map((item) => [item.role, item.tool_call_id]),
    [
      ["tool", "call_1"],
      ["tool", "call_2"],
    ],
  );
});

test("hosted NVIDIA streams public text and assembles tool-call fragments without emitting provider reasoning", async () => {
  let sent;
  const chunks = [
    { choices: [{ index: 0, delta: { content: "주변", reasoning_content: "HIDDEN_REASONING_SENTINEL" } }] },
    { choices: [{ index: 0, delta: { content: "을 확인합니다.", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "analyze_", arguments: "{" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "area", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
  ];
  const adapter = createModelClient({ env: hosted, client: fixtureClient(async payload => {
    sent = payload;
    return (async function* () { for (const chunk of chunks) yield chunk; })();
  }) });
  const deltas = [];
  const response = await adapter.createResponse({ ...request, onTextDelta: text => deltas.push(text) });
  assert.equal(sent.stream, true);
  assert.deepEqual(deltas, ["주변", "을 확인합니다."]);
  assert.equal(response.output_text, "주변을 확인합니다.");
  assert.equal(response.output.find(item => item.type === "function_call").name, "analyze_area");
  assert.equal(JSON.stringify(response).includes("HIDDEN_REASONING_SENTINEL"), false);
});

test("OpenAI Responses streams text deltas but uses the completed response as authoritative", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "안녕" },
    { type: "response.completed", response: { output_text: "안녕하세요", output: [{ type: "message", content: [{ type: "output_text", text: "안녕하세요" }] }] } },
  ];
  let sent;
  const adapter = createModelClient({ env: { OPENAI_API_KEY: "fixture-openai" }, client: { responses: { async create(payload) {
    sent = payload;
    return (async function* () { for (const event of events) yield event; })();
  } } } });
  const deltas = [];
  const result = await adapter.createResponse({ ...request, onTextDelta: text => deltas.push(text) });
  assert.equal(sent.stream, true);
  assert.equal(Object.hasOwn(sent, "onTextDelta"), false);
  assert.deepEqual(deltas, ["안녕"]);
  assert.equal(result.output_text, "안녕하세요");
});

test("standalone probe instructions and forced function use chat-completions schema", async () => {
  let payload;
  const adapter = createModelClient({
    env: hosted,
    client: fixtureClient(async (data) => {
      payload = data;
      return completion();
    }),
  });
  await adapter.createResponse({
    ...request,
    input: [{ role: "user", content: "Probe only" }],
    instructions: "Probe instruction",
    tool_choice: { type: "function", name: "get_project" },
  });
  assert.equal(payload.messages[0].content, "Probe instruction");
  assert.deepEqual(payload.tool_choice, {
    type: "function",
    function: { name: "get_project" },
  });
});

test("malformed, truncated, refused and excessive chat responses fail closed", async () => {
  const cases = [
    [{ choices: [] }, "MODEL_INVALID_RESPONSE"],
    [completion({ tool_calls: [call(), call()] }), "MODEL_INVALID_RESPONSE"],
    [
      completion({ tool_calls: [call("get_project", "")] }),
      "MODEL_INVALID_RESPONSE",
    ],
    [
      completion({
        tool_calls: Array.from({ length: 17 }, (_, i) =>
          call("get_project", `c${i}`),
        ),
      }),
      "MODEL_INVALID_RESPONSE",
    ],
    [completion({ content: null }, "tool_calls"), "MODEL_INVALID_RESPONSE"],
    [completion({ tool_calls: [call()] }, "length"), "MODEL_OUTPUT_LIMIT"],
    [completion({ refusal: "PRIVATE_PROVIDER_REFUSAL" }), "MODEL_REFUSED"],
    [completion({ content: "" }, "content_filter"), "MODEL_REFUSED"],
  ];
  for (const [response, code] of cases) {
    const adapter = createModelClient({
      env: hosted,
      client: fixtureClient(async () => response),
    });
    await assert.rejects(
      adapter.createResponse(request),
      (error) =>
        error.code === code &&
        !error.message.includes("PRIVATE_PROVIDER_REFUSAL"),
    );
  }
});

test("provider errors are sanitized; only transient 5xx retry, with no provider fallback", async () => {
  for (const [failure, expected] of [
    [{ status: 429, code: "insufficient_quota" }, "MODEL_CREDITS_EXHAUSTED"],
    [{ status: 429 }, "MODEL_RATE_LIMITED"],
    [{ status: 401 }, "MODEL_AUTH_FAILED"],
    [{ status: 400 }, "MODEL_REQUEST_FAILED"],
    [{ status: 500 }, "MODEL_REQUEST_FAILED"],
  ]) {
    let count = 0;
    const adapter = createModelClient({
      env: hosted,
      client: fixtureClient(async () => {
        count++;
        throw Object.assign(
          new Error("PRIVATE_PROVIDER_ERROR fixture-nvidia-key"),
          failure,
        );
      }),
    });
    await assert.rejects(
      adapter.createResponse(request),
      (error) =>
        error.code === expected &&
        !error.message.includes("PRIVATE_PROVIDER_ERROR") &&
        !error.message.includes("fixture-nvidia-key"),
    );
    assert.equal(count, failure.status === 500 ? 3 : 1);
  }
  assert.throws(
    () =>
      createModelClient({
        env: { MODEL_PROVIDER: "nvidia", OPENAI_API_KEY: "WRONG_KEY" },
      }),
    (error) => error.code === "MODEL_NOT_CONFIGURED",
  );
});

test("OpenAI path remains Responses with store false and no chat conversion", async () => {
  let payload;
  const adapter = createModelClient({
    env: { OPENAI_MODEL: "gpt-6-astra" },
    client: {
      responses: {
        create: async (opts) => {
          payload = opts;
          return { output_text: "ok", output: [] };
        },
      },
    },
  });
  const response = await adapter.createResponse({ ...request, store: true });
  assert.equal(response.output_text, "ok");
  assert.equal(payload.store, false);
  assert.equal(payload.model, "gpt-6-astra");
  assert.deepEqual(payload.input, request.input);
});

test("NVIDIA agent loop preserves allowed tools, refreshed compact context, opt-in history and progress", async () => {
  const payloads = [],
    events = [],
    executed = [];
  const current = structuredClone(project);
  const client = fixtureClient(async (payload) => {
    payloads.push(structuredClone(payload));
    return payloads.length === 1
      ? completion({
          tool_calls: [
            call(
              "propose_space",
              "c1",
              '{"width":30,"depth":20,"height":null}',
            ),
            call("deploy", "c2"),
          ],
        })
      : completion({
          content: "초안 수정 완료. 운영 배포는 오너 승인이 필요합니다.",
        });
  });
  const result = await runAgent({
    project: structuredClone(project),
    message: "공간 초안 제안",
    useModel: true,
    env: hosted,
    client,
    onEvent: (event) => events.push(event),
    executeTool: (name, args) => {
      executed.push(name);
      if (name === "get_project") return current;
      assert.deepEqual(args, { width: 30, depth: 20 });
      current.inputRevision = 2;
      current.space.width = args.width;
      return { secret: "RAW_TOOL_SENTINEL" };
    },
  });
  assert.equal(result.provider, "nvidia");
  assert.equal(result.model, hosted.NVIDIA_MODEL);
  assert.deepEqual(executed, ["propose_space", "get_project"]);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, "complete");
  const sent = JSON.stringify(payloads);
  for (const privateValue of [
    "PII_SENTINEL",
    "PRIVATE_EMAIL_SENTINEL",
    "LOCAL_SENTINEL",
    "RAW_TOOL_SENTINEL",
  ])
    assert.ok(!sent.includes(privateValue), privateValue);
  assert.ok(sent.includes("CONSENT_SENTINEL"));
  const toolResult = JSON.parse(
    payloads[1].messages.find((m) => m.role === "tool").content,
  );
  assert.equal(toolResult.project.inputRevision, 2);
  assert.equal(toolResult.project.space.width, 30);
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
});

test("local requests never initialize model transport; unverified provider images fail before load or network", async () => {
  let network = 0,
    images = 0;
  const client = fixtureClient(async () => {
    network++;
    return completion();
  });
  const local = await runAgent({
    project,
    message: "일반적인 질문",
    env: hosted,
    client,
    executeTool: () => assert.fail(),
  });
  assert.equal(local.mode, "local");
  assert.equal(network, 0);
  await assert.rejects(
    runAgent({
      project,
      message: "이미지 해석",
      useModel: true,
      imageIds: ["i"],
      env: hosted,
      client,
      loadImage: () => {
        images++;
        return { mime: "image/png", data: "PRIVATE_IMAGE" };
      },
      executeTool: () => assert.fail(),
    }),
    (error) => error.code === "MODEL_IMAGE_UNSUPPORTED",
  );
  assert.equal(network, 0);
  assert.equal(images, 0);
  assert.throws(
    () => assertImageCapability(getModelConfiguration(nim), ["i"]),
    (error) => error.code === "MODEL_IMAGE_UNSUPPORTED",
  );
});

test("model history opt-in is connection-bound; legacy consent fails closed for every provider", async () => {
  const p = structuredClone(project);
  const configurations = Object.fromEntries(
    [{ MODEL_PROVIDER: "openai" }, hosted, nim].map((env) => [
      env.MODEL_PROVIDER,
      getModelConfiguration(env),
    ]),
  );
  p.messages = [
    { role: "user", content: "LEGACY_CONSENT_SENTINEL", useModel: true },
    ...["openai", "nvidia", "nim"].flatMap((provider) => [
      {
        role: "user",
        content: `${provider}_USER_SENTINEL`,
        useModel: true,
        provider,
        connectionId: configurations[provider].connectionId,
      },
      {
        role: "assistant",
        content: `${provider}_REPLY_SENTINEL`,
        mode: "model",
        provider,
        connectionId: configurations[provider].connectionId,
      },
    ]),
    {
      role: "user",
      content: "DENIED_SENTINEL",
      useModel: false,
      provider: "nvidia",
    },
  ];
  for (const env of [{ MODEL_PROVIDER: "openai" }, hosted, nim]) {
    const requests = [];
    const create = async (payload) => {
      requests.push(structuredClone(payload));
      if (env.MODEL_PROVIDER === "openai")
        return requests.length === 1
          ? {
              output: [
                {
                  type: "function_call",
                  name: "get_project",
                  call_id: "c",
                  arguments: "{}",
                },
              ],
            }
          : { output: [], output_text: "ok" };
      return requests.length === 1
        ? completion({ tool_calls: [call()] })
        : completion();
    };
    const client =
      env.MODEL_PROVIDER === "openai"
        ? { responses: { create } }
        : fixtureClient(create);
    await runAgent({
      project: p,
      message: "현재 요청",
      useModel: true,
      env,
      client,
      executeTool: () => p,
    });
    const sent = JSON.stringify(requests);
    for (const provider of ["openai", "nvidia", "nim"])
      for (const role of ["USER", "REPLY"])
        assert.equal(
          sent.includes(`${provider}_${role}_SENTINEL`),
          provider === env.MODEL_PROVIDER,
        );
    assert.equal(sent.includes("LEGACY_CONSENT_SENTINEL"), false);
    assert.ok(!sent.includes("DENIED_SENTINEL"));
  }
});

test("real SDK performs NIM HTTP tool loop against localhost fixture with no borrowed Authorization", async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({
      path: req.url,
      method: req.method,
      headers: req.headers,
      payload: JSON.parse(text),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        received.length === 1
          ? completion({ tool_calls: [call()] })
          : completion({ content: "로컬 fixture HTTP 왕복 완료" }),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runAgent({
    project,
    message: "프로젝트 조회",
    useModel: true,
    env: {
      ...nim,
      NIM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OPENAI_API_KEY: "MUST_NOT_SEND",
    },
    executeTool: (name) => {
      assert.equal(name, "get_project");
      return project;
    },
  });
  assert.equal(result.provider, "nim");
  assert.equal(received.length, 2);
  for (const receipt of received) {
    assert.equal(receipt.path, "/v1/chat/completions");
    assert.equal(receipt.method, "POST");
    assert.equal(receipt.headers.authorization, undefined);
    assert.ok(!JSON.stringify(receipt).includes("MUST_NOT_SEND"));
  }
  assert.equal(received[1].payload.messages.at(-1).role, "tool");
});

test("real SDK NIM sends only explicitly configured NIM credential and refuses redirects", async (t) => {
  let receivedAuthorization,
    redirected = 0;
  const destination = createServer((req, res) => {
    redirected++;
    res.writeHead(200);
    res.end("{}");
  });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const server = createServer((req, res) => {
    receivedAuthorization = req.headers.authorization;
    req.resume();
    res.writeHead(307, {
      location: `http://127.0.0.1:${destination.address().port}/v1/chat/completions`,
    });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => destination.close(resolve));
  });
  const adapter = createModelClient({
    env: {
      ...nim,
      NIM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      NIM_API_KEY: "fixture-nim-key",
    },
  });
  await assert.rejects(
    adapter.createResponse(request),
    (error) => error.code === "MODEL_REQUEST_FAILED",
  );
  assert.equal(receivedAuthorization, "Bearer fixture-nim-key");
  assert.equal(redirected, 0);
});

test("NVIDIA failure after a tool rolls back HTTP JSON and streaming transactions; version lock is released", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-provider-test-"));
  const app = await createAppServer({
    dataDir: dir,
    port: 0,
    scheduler: false,
    modelConfigured: true,
    dependencies: {
      runAgent: (args) => {
        let count = 0;
        return runAgent({
          ...args,
          env: hosted,
          client: fixtureClient(async () => {
            if (++count === 1)
              return completion({
                tool_calls: [
                  call("update_assumptions", "c1", '{"visitors":900}'),
                ],
              });
            throw Object.assign(new Error("RAW_PROVIDER_SECRET"), {
              status: 429,
              code: "insufficient_quota",
            });
          }),
        });
      },
    },
  });
  await app.listen();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const connectionId = (await (await fetch(url + "/api/health")).json())
    .provider.connectionId;
  const post = (path, body, stream = false) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stream ? { Accept: "application/x-ndjson" } : {}),
      },
      body: JSON.stringify(body),
    });
  for (const stream of [false, true]) {
    const p = (
      await (await post("/api/projects", { name: "Rollback fixture" })).json()
    ).project;
    const response = await post(
      `/api/projects/${p.id}/chat`,
      {
        message: "방문객 변경",
        useModel: true,
        expectedConnectionId: connectionId,
        imageIds: [],
        expectedVersion: p.version,
      },
      stream,
    );
    const text = await response.text();
    assert.ok(!text.includes("RAW_PROVIDER_SECRET"));
    const events = stream ? text.trim().split("\n").map(JSON.parse) : [];
    const failure = stream ? events.at(-1) : JSON.parse(text);
    assert.equal(failure.code, "MODEL_CREDITS_EXHAUSTED");
    if (stream) {
      assert.equal(failure.committed, false);
      assert.equal(failure.status, 429);
      assert.ok(events.some((event) => event.type === "tool.completed"));
    } else assert.equal(response.status, 429);
    const saved = app.store.get(p.id);
    assert.equal(saved.version, p.version);
    assert.equal(saved.messages.length, 0);
    assert.equal(saved.assumptions.visitors, p.assumptions.visitors);
    const next = await post(`/api/projects/${p.id}/actions`, {
      type: "UPDATE_ASSUMPTIONS",
      payload: { visitors: 1000 },
      expectedVersion: p.version,
    });
    assert.equal(next.status, 200);
  }
});
