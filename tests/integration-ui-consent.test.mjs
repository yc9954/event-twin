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
  assert.match(source, /\['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NGC_API_KEY', 'NIM_API_KEY', 'ANTHROPIC_API_KEY', 'EVENT_TWIN_GATEWAY_KEY'\]\) delete env\[key\]/);
});

test('fallback disclosure names Anthropic, transferred history/tool results and API charges before consent', async () => {
  const app = await readFile(new URL('../client/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /NVIDIA \+ Claude fallback/);
  assert.match(app, /같은 요청 맥락·이전 대화·도구 결과를 Anthropic/);
  assert.match(app, /두 제공자 전송과 Claude API 비용에 동의/);
  const settings = await readFile(new URL('../client/IntegrationSettings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /Claude fallback/);
  assert.match(settings, /두 제공자로 합성 맥락/);
});
