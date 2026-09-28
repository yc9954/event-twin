import test from 'node:test';
import assert from 'node:assert/strict';
import { agentBlueprint } from '../shared/agent-blueprint.mjs';
import { agentTools, localCommands } from '../server/agent.mjs';
import { runtimeContext, runtimeDescriptor } from '../server/agent-runtime.mjs';
import { registerRuntimeContext } from '../vendor/nemoclaw/runtime-context.mjs';

test('versioned web blueprint matches exactly the executable tools', () => {
  assert.deepEqual(agentBlueprint.tools.map(t => t.name), agentTools.map(t => t.name));
  assert.equal(agentBlueprint.policy.arbitraryShell, false);
  assert.equal(agentBlueprint.policy.arbitraryNetwork, false);
  assert.equal(agentBlueprint.limits.toolCalls, 16);
});

test('NemoClaw-derived hook is invoked without host state or unsupported sandbox claims', () => {
  const context = runtimeContext({ useModel: true, modelConfigured: true });
  assert.match(context, /consented model request/);
  assert.match(context, /not running inside an OpenShell sandbox/);
  assert.match(context, /Only the owner/);
  assert.match(context, /no shell or raw filesystem/);
  assert.doesNotMatch(context, /You are running inside OpenShell/);
  assert.match(runtimeContext(), /local tool mode/);
});

test('runtime descriptor cannot turn a configured key into verified inference or sandbox readiness', () => {
  const runtime = runtimeDescriptor({ modelConfigured: true, model: 'test-model' });
  assert.equal(runtime.inference.configured, true);
  assert.equal(runtime.inference.verified, false);
  assert.equal(runtime.sandbox.connected, false);
  assert.equal(runtime.upstream.commit.length, 40);
  assert.equal(runtime.contextHook, 'before_prompt_build');
  assert.doesNotMatch(JSON.stringify(runtime), /API_KEY|api-key/);
});

test('runtime verification is bound to the exact provider connection identity', () => {
  const check = {provider:'nvidia', model:'test-model', connectionId:'model-v1-previous', inferenceVerified:true, toolCallingVerified:true};
  const stale = runtimeDescriptor({provider:'nvidia', model:'test-model', connectionId:'model-v1-current', modelConfigured:true, check});
  assert.equal(stale.inference.verified, false);
  assert.equal(stale.inference.toolCallingVerified, false);
  assert.equal(stale.inference.lastCheck, null);
  const current = runtimeDescriptor({provider:'nvidia', model:'test-model', connectionId:'model-v1-previous', modelConfigured:true, check});
  assert.equal(current.inference.verified, true);
  assert.equal(current.inference.toolCallingVerified, true);
  const disabled = runtimeDescriptor({provider:'nvidia', model:'test-model', connectionId:'model-v1-previous', modelConfigured:false, check});
  assert.equal(disabled.inference.verified, false);
});

test('runtime hook stores request-scoped configuration without changing other sessions', () => {
  const register = runtimeName => {
    let listener;
    registerRuntimeContext({ on(name, callback) { assert.equal(name, 'before_prompt_build'); listener = callback; } },
      { runtimeName, runtimePhase: null, networkLines: [], filesystemLines: [], behaviorLines: [] });
    return listener;
  };
  const a = register('A');
  const b = register('B');
  assert.match(a().prependSystemContext, /Runtime: A/);
  assert.match(b().prependSystemContext, /Runtime: B/);
});

test('blueprint local shortcuts invoke only their advertised tool', () => {
  for (const tool of agentBlueprint.tools.filter(t => t.prompt)) {
    assert.equal(localCommands(tool.prompt)[0]?.[0], tool.name, tool.name);
  }
});
