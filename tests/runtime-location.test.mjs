import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntimeLocation } from '../server/runtime-location.mjs';

test('a deployment environment flag cannot by itself claim OpenShell isolation', () => {
  const options = { env: { EVENT_TWIN_SANDBOX: 'my-assistant' }, platform: 'linux', stat: () => ({ isDirectory: () => true }) };
  assert.equal(inspectRuntimeLocation({ ...options, read: () => 'NoNewPrivs:\t0\nSeccomp:\t0' }).connected, false);
  assert.equal(inspectRuntimeLocation({ ...options, read: () => { throw new Error('denied'); } }).connected, false);
  assert.equal(inspectRuntimeLocation({ ...options, platform: 'darwin', read: () => 'NoNewPrivs:\t1\nSeccomp:\t2' }).connected, false);
  const observed = inspectRuntimeLocation({ ...options, read: () => 'NoNewPrivs:\t1\nSeccomp:\t2\n' });
  assert.equal(observed.connected, true);
  assert.equal(observed.status, 'process-confirmed');
});
