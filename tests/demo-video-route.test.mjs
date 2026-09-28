import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/http.mjs';

test('local tab recording stores only signed video bytes with owner-only file permissions', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'event-twin-recording-'));
  const app = await createAppServer({ dataDir, port: 0, scheduler: false, modelConfigured: false });
  const address = await app.listen();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}/api/demo/tab-video`;
  const wrong = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: Buffer.alloc(40) });
  assert.equal(wrong.status, 415);
  const bytes = Buffer.alloc(40);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(bytes);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: bytes });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.match(saved.path, /demo-recordings\/tab-[a-f0-9-]+\.webm$/);
  assert.deepEqual(await readFile(saved.path), bytes);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
});
