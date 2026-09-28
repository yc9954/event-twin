import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('model probe UI binds opt-in to the exact displayed connection, not a persistent boolean', async () => {
  const source = await readFile(new URL('../client/IntegrationSettings.jsx', import.meta.url), 'utf8');
  assert.match(source, /confirmedConnectionId,setConfirmedConnectionId\] = useState\(null\)/);
  assert.match(source, /const confirmed = !!provider.connectionId && confirmedConnectionId === provider.connectionId;/);
  assert.match(source, /if \(!confirmed \|\| checking\) return;/);
  assert.match(source, /setConfirmedConnectionId\(e.target.checked \? provider.connectionId : null\)/);
  assert.match(source, /api.checkIntegration\(provider.connectionId\)/);
  assert.match(source, /disabled=\{!confirmed\|\|checking\}/);
});

test('read-only NAT launcher strips all supported model credentials', async () => {
  const source = await readFile(new URL('../scripts/nvidia-nat.mjs', import.meta.url), 'utf8');
  assert.match(source, /\['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NGC_API_KEY', 'NIM_API_KEY', 'EVENT_TWIN_GATEWAY_KEY'\]\) delete env\[key\]/);
});
