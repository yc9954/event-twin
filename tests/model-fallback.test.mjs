import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelConfiguration, createModelClient } from '../server/model-provider.mjs';
import { anthropicInput } from '../server/anthropic-provider.mjs';
import { runAgent, sanitizeAgentEvent } from '../server/agent.mjs';
import { createProject } from '../server/domain.mjs';
import { createIntegrationChecks } from '../server/integration-checks.mjs';

const env = { MODEL_PROVIDER: 'nvidia', NVIDIA_MODEL: 'fixture-nvidia', NVIDIA_API_KEY: 'fixture-primary',
  MODEL_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'fixture-fallback', ANTHROPIC_MODEL: 'claude-sonnet-4-6' };
const request = { input: [{ role: 'developer', content: 'Use tools safely.' }, { role: 'user', content: 'Read state.' }], tools: [], max_output_tokens: 500 };
const chat = create => ({ chat: { completions: { create } } });
const complete = text => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] });
const native = (content = [{ type: 'text', text: 'Claude answer' }], stop_reason = 'end_turn') => ({ role: 'assistant', content, stop_reason });
const fail = async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { status: 400 }); };

test('fallback is opt-in, credentials are separate, and recipient/model/key changes invalidate consent', () => {
  const config = getModelConfiguration(env);
  assert.equal(config.fallback.configured, true);
  assert.equal(config.fallback.capabilities.api, 'anthropic-messages');
  assert.equal(getModelConfiguration({ ...env, MODEL_FALLBACK_PROVIDER: '' }).fallback, undefined);
  for (const change of [{ MODEL_FALLBACK_PROVIDER: '' }, { ANTHROPIC_MODEL: 'claude-other' }, { ANTHROPIC_API_KEY: 'new-secret' }])
    assert.notEqual(config.connectionId, getModelConfiguration({ ...env, ...change }).connectionId);
  assert.equal(getModelConfiguration({ ...env, ANTHROPIC_API_KEY: '' }).fallback.configured, false);
  assert.equal(JSON.stringify(config).includes('fixture-fallback'), false);
  assert.equal(JSON.stringify(config).includes('fixture-primary'), false);
});

test('NVIDIA succeeds without touching Claude', async () => {
  let calls = 0;
  const model = createModelClient({ env, client: chat(async () => complete('NVIDIA answer')), anthropicClient: { messages: { create: async () => { calls++; return native(); } } } });
  assert.equal((await model.createResponse(request)).output_text, 'NVIDIA answer');
  assert.equal(calls, 0);
  assert.equal(model.activeConfiguration.provider, 'nvidia');
});

test('failed NVIDIA request switches once, reports reason, then pins Claude for this request', async () => {
  let primary = 0, secondary = 0; const receipts = [];
  const model = createModelClient({ env, client: chat(async () => { primary++; return fail(); }), anthropicClient: { messages: { create: async payload => {
    secondary++; assert.equal(payload.model, env.ANTHROPIC_MODEL); assert.equal(payload.system, 'Use tools safely.'); return native();
  } } } });
  assert.equal((await model.createResponse({ ...request, onFallback: r => receipts.push(r) })).output_text, 'Claude answer');
  await model.createResponse(request);
  assert.equal(primary, 1); assert.equal(secondary, 2); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reason, 'MODEL_REQUEST_FAILED'); assert.equal(model.activeConfiguration.provider, 'anthropic');
});

test('no fallback after partial public output, refusal, truncation, cancellation, or missing fallback key', async () => {
  let secondary = 0;
  const anthropicClient = { messages: { create: async () => { secondary++; return native(); } } };
  async function* brokenStream() { yield { choices: [{ delta: { content: 'partial answer' }, finish_reason: null }] }; throw new Error('private stream failure'); }
  const partial = createModelClient({ env, client: chat(async () => brokenStream()), anthropicClient });
  await assert.rejects(partial.createResponse({ ...request, onTextDelta: () => {} }));
  for (const finish_reason of ['content_filter', 'length']) {
    const model = createModelClient({ env, client: chat(async () => ({ choices: [{ finish_reason, message: { role: 'assistant', content: '' } }] })), anthropicClient });
    await assert.rejects(model.createResponse(request));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createModelClient({ env, client: chat(fail), anthropicClient }).createResponse({ ...request, signal: controller.signal }));
  await assert.rejects(createModelClient({ env: { ...env, ANTHROPIC_API_KEY: '' }, client: chat(fail), anthropicClient }).createResponse(request));
  assert.equal(secondary, 0);
});

test('both providers failing returns a sanitized explicit failure, never a mock result', async () => {
  const model = createModelClient({ env, client: chat(fail), anthropicClient: { messages: { create: async () => { throw Object.assign(new Error('PRIVATE_FALLBACK_KEY'), { status: 401 }); } } } });
  await assert.rejects(model.createResponse(request), error => error.code === 'MODEL_FALLBACK_FAILED' && !error.message.includes('PRIVATE'));
});

test('native tool messages retain real receipts, combine adjacent roles, and reject image transfer', () => {
  const converted = anthropicInput([...request.input, { role: 'user', content: 'Extra context' },
    { type: 'function_call', call_id: 'call_1', name: 'get_project', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"actual":true}' }]);
  assert.equal(converted.messages[0].content.length, 2);
  assert.deepEqual(converted.messages[1].content[0], { type: 'tool_use', id: 'call_1', name: 'get_project', input: {} });
  assert.equal(converted.messages[2].content[0].content, '{"actual":true}');
  assert.throws(() => anthropicInput([{ role: 'user', content: [{ type: 'input_image', image_url: 'PRIVATE_IMAGE' }] }]), { code: 'MODEL_IMAGE_UNSUPPORTED' });
});

test('Claude streams public text only, accumulates complete native output, and supports forced tools', async () => {
  const deltas = [];
  const anthropicClient = { messages: { stream(payload) {
    assert.deepEqual(payload.tool_choice, { type: 'tool', name: 'get_project' });
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'NOT_PUBLIC' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Public text' } };
    }, finalMessage: async () => native([{ type: 'text', text: 'Public text' }]) };
  } } };
  const model = createModelClient({ env, client: chat(fail), anthropicClient });
  const result = await model.createResponse({ ...request, tool_choice: { type: 'function', name: 'get_project' }, onTextDelta: text => deltas.push(text) });
  assert.deepEqual(deltas, ['Public text']); assert.equal(result.output_text, 'Public text');
});

test('fallback after a completed tool continues from its receipt without replaying the tool', async () => {
  const project = createProject('synthetic'); let primary = 0, toolCalls = 0; const events = [];
  const result = await runAgent({ project, message: '프로젝트 상태 조회', useModel: true, env,
    client: chat(async () => {
      if (++primary === 1) return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_real', type: 'function', function: { name: 'get_project', arguments: '{}' } }] } }] };
      return fail();
    }), anthropicClient: { messages: { stream(payload) {
      assert.ok(payload.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'call_real')));
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Stored state reviewed.' } }; }, finalMessage: async () => native([{ type: 'text', text: 'Stored state reviewed.' }]) };
    } } }, executeTool: async () => { toolCalls++; return structuredClone(project); }, onEvent: event => events.push(event) });
  assert.equal(toolCalls, 1); assert.equal(result.provider, 'anthropic'); assert.equal(result.steps.length, 1);
  assert.equal(result.modelContext.fallback.round, 2); assert.equal(events.filter(e => e.type === 'model.fallback').length, 1);
});

test('combined recipient consent includes fallback history, not past NVIDIA-only consent', async () => {
  const project = createProject('synthetic');
  project.messages = [
    { role: 'user', content: 'OLD_PRIVATE', useModel: true, provider: 'nvidia', connectionId: getModelConfiguration({ ...env, MODEL_FALLBACK_PROVIDER: '' }).connectionId },
    { role: 'user', content: 'NEW_ALLOWED', useModel: true, provider: 'anthropic', connectionId: getModelConfiguration(env).connectionId },
  ];
  await runAgent({ project, message: 'Explain briefly', useModel: true, env, client: chat(async payload => {
    assert.ok(JSON.stringify(payload.messages).includes('NEW_ALLOWED'));
    assert.ok(!JSON.stringify(payload.messages).includes('OLD_PRIVATE'));
    return complete('safe');
  }), executeTool: async () => { throw new Error('must not run'); } });
});

test('fallback event is allowlisted and drops any untrusted raw error or credential', () => {
  const event = sanitizeAgentEvent({ type: 'model.fallback', from: 'nvidia', to: 'anthropic', model: 'claude-sonnet-4-6', reason: 'MODEL_REQUEST_FAILED', round: 1, apiKey: 'PRIVATE', error: 'PRIVATE' });
  assert.equal(event.to, 'anthropic'); assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
  assert.equal(sanitizeAgentEvent({ ...event, to: 'unknown' }), null);
});

test('Claude input explicitly separates project reference data from the current user request', async () => {
  const project = createProject('synthetic');
  await runAgent({ project, message: '내 목표를 알려줘', useModel: true, env, client: chat(fail),
    anthropicClient: { messages: { create: async payload => {
      assert.match(payload.system, /정상적인 프로젝트 조회/);
      const blocks = payload.messages[0].content;
      assert.match(blocks[0].text, /프로젝트 참고자료 끝\.$/);
      assert.match(blocks[1].text, /^현재 사용자가 직접 입력한 요청/);
      assert.match(blocks[1].text, /내 목표를 알려줘$/);
      return native();
    } } }, executeTool: async () => { throw new Error('must not run'); } });
});

test('connection check attributes successful fallback to Claude, never NVIDIA', async () => {
  const checks = createIntegrationChecks({ getConfiguration: () => getModelConfiguration(env), runAgent: async args => {
    const project = await args.executeTool('get_project');
    return { reply: project.brief.goal, provider: 'anthropic', model: env.ANTHROPIC_MODEL,
      modelContext: { fallback: { from: 'nvidia', to: 'anthropic' } }, steps: [{ name: 'get_project', status: 'complete' }] };
  } });
  const receipt = await checks.check();
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.provider, 'anthropic'); assert.equal(receipt.primaryProvider, 'nvidia');
});
