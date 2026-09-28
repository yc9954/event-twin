// Requires an already running local NAT service; never starts a model/provider.
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:8008';
const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
assert.equal(health.status, 200);
assert.equal((await health.json()).status, 'healthy');
const response = await fetch(`${origin}/generate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input_message: 'health' }), signal: AbortSignal.timeout(10000), redirect: 'error',
});
assert.equal(response.status, 200);
const receipt = JSON.parse((await response.json()).value);
assert.equal(receipt.framework, 'nvidia-nat');
assert.equal(receipt.version, '1.9.0');
assert.equal(receipt.tool, 'health');
assert.equal(receipt.readOnly, true);
assert.equal(receipt.inferencePerformed, false);
assert.equal(receipt.result.ok, true);
const foreign = await fetch(`${origin}/generate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
  body: JSON.stringify({ input_message: 'health' }), signal: AbortSignal.timeout(5000), redirect: 'error',
});
assert.equal(foreign.status, 403);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), natVersion: receipt.version,
  natServe: 'passed', appHttpTool: 'passed', foreignOrigin: 'blocked', inferencePerformed: false }, null, 2));
