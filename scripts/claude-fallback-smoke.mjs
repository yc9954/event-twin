// Synthetic read-only live Claude probe. The PRIMARY failure is deliberately
// injected; Claude inference and its fresh-token tool roundtrip are real.
// No production project, DB write, history, contact or image is used.
import assert from 'node:assert/strict';
import { runAgent } from '../server/agent.mjs';
import { createIntegrationChecks } from '../server/integration-checks.mjs';
import { getModelConfiguration } from '../server/model-provider.mjs';

if (!process.argv.includes('--confirm-live-api')) {
  console.error('Pass --confirm-live-api to authorize a real, potentially billed Anthropic API probe.');
  process.exit(2);
}
const env = { ...process.env, MODEL_PROVIDER: 'nvidia', NVIDIA_MODEL: 'synthetic-primary-failure',
  NVIDIA_BASE_URL: 'https://integrate.api.nvidia.com/v1', NVIDIA_API_KEY: 'synthetic-never-sent',
  MODEL_FALLBACK_PROVIDER: 'anthropic' };
assert.ok(getModelConfiguration(env).fallback?.configured, 'Private Anthropic credentials must be configured.');
let primaryAttempts = 0, fallbackEvents = 0, textDeltas = 0;
const client = { chat: { completions: { create: async () => {
  primaryAttempts++;
  throw Object.assign(new Error('Synthetic primary failure; no NVIDIA request sent.'), { status: 400 });
} } } };
const checks = createIntegrationChecks({ getConfiguration: () => getModelConfiguration(env),
  runAgent: args => runAgent({ ...args, env, client, onEvent: event => {
    if (event.type === 'model.fallback') fallbackEvents++;
    if (event.type === 'response.delta') textDeltas++;
  } }) });
const receipt = await checks.check();
console.log(JSON.stringify({ scope: 'injected-NVIDIA-failure / real-Claude-tool-roundtrip',
  checkedAt: receipt.checkedAt, status: receipt.status, provider: receipt.provider,
  model: receipt.model, code: receipt.code, toolCallingVerified: receipt.toolCallingVerified,
  durationMs: receipt.durationMs, primaryAttempts, fallbackEvents, textDeltas }));
assert.equal(receipt.toolCallingVerified, true);
assert.equal(receipt.provider, 'anthropic');
assert.equal(primaryAttempts, 1);
assert.equal(fallbackEvents, 1);
assert.ok(textDeltas > 0);
