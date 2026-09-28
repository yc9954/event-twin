import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../client/api.js";

const result = {
  project: { id: "P-1", version: 2 },
  reply: "한국어 완료",
  steps: [],
};
const start = {
  type: "request.accepted",
  sequence: 1,
  requestId: "req-1",
  at: "2026-09-28T00:00:00.000Z",
  committed: false,
};
const complete = {
  type: "response.completed",
  sequence: 2,
  requestId: "req-1",
  committed: true,
  status: 200,
  data: result,
};
const headers = { "Content-Type": "application/x-ndjson; charset=utf-8" };
function responseFor(events, status = 200) {
  const bytes = new TextEncoder().encode(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split both JSON delimiters and Korean UTF-8 sequences across chunks.
        for (let i = 0; i < bytes.length; i += 3)
          controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    }),
    { status, headers },
  );
}

test("optional chat callback requests NDJSON and receives events before final resolution", async (t) => {
  let streamController, requestOptions, notifyStarted;
  const observed = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (_path, options) => {
    requestOptions = options;
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(encoder.encode(JSON.stringify(start) + "\n"));
        },
      }),
      { headers },
    );
  });
  let resolved = false;
  const events = [];
  const promise = api.chat("P-1", "요청", 1, false, [], (event) => {
    events.push(event);
    notifyStarted();
  });
  promise.then(() => {
    resolved = true;
  });
  await observed;
  assert.equal(resolved, false);
  assert.equal(requestOptions.headers.Accept, "application/x-ndjson");
  assert.equal(JSON.parse(requestOptions.body).useModel, false);
  streamController.enqueue(encoder.encode(JSON.stringify(complete) + "\n"));
  streamController.close();
  assert.deepEqual(await promise, result);
  assert.deepEqual(
    events.map((event) => event.type),
    ["request.accepted", "response.completed"],
  );
});

test("stream parser preserves split UTF-8 and observer exceptions do not change success", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    responseFor([start, complete]),
  );
  assert.deepEqual(
    await api.chat("P-1", "요청", 1, false, [], () => {
      throw new Error("UI unavailable");
    }),
    result,
  );
});

test("text deltas arrive before commit but are not retained as failure receipts", async (t) => {
  const delta = { type: "response.delta", round: 1, text: "실시간 답변", sequence: 2, requestId: "req-1", committed: false };
  t.mock.method(globalThis, "fetch", async () => responseFor([start, delta, complete]));
  const observed = [];
  assert.deepEqual(await api.chat("P-1", "요청", 1, true, [], event => observed.push(event)), result);
  assert.deepEqual(observed.map(event => event.type), ["request.accepted", "response.delta", "response.completed"]);
  const failure = { type: "response.failed", requestId: "req-1", committed: false, error: "failed" };
  t.mock.method(globalThis, "fetch", async () => responseFor([start, delta, failure]));
  await assert.rejects(api.chat("P-1", "요청", 1, true, [], () => {}), error => {
    assert.deepEqual(error.events.map(event => event.type), ["request.accepted", "response.failed"]);
    return true;
  });
});

test("in-band failure retains sanitized status, code and partial events instead of reporting success", async (t) => {
  const failure = {
    type: "response.failed",
    requestId: "req-1",
    status: 429,
    code: "MODEL_CREDITS_EXHAUSTED",
    error: "API 크레딧 부족",
    committed: false,
  };
  t.mock.method(globalThis, "fetch", async () => responseFor([start, failure]));
  const observed = [];
  await assert.rejects(
    api.chat("P-1", "요청", 1, true, [], (event) => observed.push(event)),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "MODEL_CREDITS_EXHAUSTED");
      assert.equal(error.committed, false);
      assert.equal(error.requestId, "req-1");
      assert.equal(error.events.length, 2);
      assert.equal(error.event.type, "response.failed");
      return true;
    },
  );
  assert.equal(observed.at(-1).type, "response.failed");
});

test("truncated streams retain receipts, mark commit unknown, and never retry mutations", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return responseFor([start]);
  });
  await assert.rejects(
    api.chat("P-1", "요청", 1, false, [], () => {}),
    (error) => {
      assert.equal(error.code, "STREAM_INTERRUPTED");
      assert.equal(error.committed, null);
      assert.equal(error.events[0].type, "request.accepted");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("legacy JSON chat and pre-stream HTTP errors retain their API contract", async (t) => {
  let options;
  t.mock.method(globalThis, "fetch", async (_path, supplied) => {
    options = supplied;
    return Response.json(result);
  });
  assert.deepEqual(await api.chat("P-1", "요청", 1, false, []), result);
  assert.equal(options.headers.Accept, undefined);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "다른 버전", code: "VERSION_CONFLICT" },
      { status: 409 },
    ),
  );
  await assert.rejects(
    api.chat("P-1", "요청", 1, false, [], () => {}),
    (error) => error.status === 409 && error.code === "VERSION_CONFLICT",
  );
});
