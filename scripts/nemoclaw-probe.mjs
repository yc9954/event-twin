// Synthetic, read-only diagnostic. Never print credentials or model reasoning.
import OpenAI from 'openai';
import { runAgent } from '../server/agent.mjs';
import { createProject } from '../server/domain.mjs';
import { createAppServer } from '../server/http.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const env = { ...process.env, MODEL_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'openshell-managed',
  NVIDIA_BASE_URL: 'https://inference.local/v1', NVIDIA_MODEL: 'nvidia/nemotron-3-super-120b-a12b' };
const sdk = new OpenAI({ apiKey: env.NVIDIA_API_KEY, baseURL: env.NVIDIA_BASE_URL, timeout: 60000, maxRetries: 0,
  organization: null, project: null, fetch: (url, init) => globalThis.fetch(url, { ...init, redirect: 'error' }) });
const project = createProject('합성 연결 검수 — 실제 행사 아님');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const response = await nativeFetch(url, init);
  if (String(url).startsWith(env.NVIDIA_BASE_URL) && !response.ok)
    console.log(JSON.stringify({providerStatus:response.status,
      error:(await response.clone().text()).replace(/nvapi-[\w-]+/g,'[redacted]').slice(0,800)}));
  return response;
};
let round = 0;
const client = { chat: { completions: { create: async payload => {
  round++;
  try {
    const result = await sdk.chat.completions.create(payload);
    console.log(JSON.stringify({ round, finish: result.choices?.[0]?.finish_reason,
      toolNames: result.choices?.[0]?.message?.tool_calls?.map(call => call.function.name), usage: result.usage }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({ round, status: error.status, code: error.code,
      message: String(error.message).replace(/nvapi-[\w-]+/g, '[redacted]').slice(0, 800) }));
    throw error;
  }
} } } };
const selectedClient = process.env.EVENT_TWIN_NATIVE_PROBE === '1' ? undefined : client;
const result = await runAgent({ project, env, client: selectedClient, useModel: true, message: '프로젝트 상태 조회',
  executeTool: name => { if (name !== 'get_project') throw new Error('Only get_project allowed'); return project; } });
console.log(JSON.stringify({ mode: result.mode, tools: result.steps.map(step => ({name:step.name,status:step.status})) }));
Object.assign(process.env, env);
const dataDir = await mkdtemp(join(tmpdir(), 'event-twin-managed-probe-'));
const app = await createAppServer({ dataDir, port: 0, scheduler: false,
  dependencies: { runAgent: args => runAgent({ ...args, client: selectedClient }) } });
try {
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(base + '/api/health')).json();
  const created = await (await fetch(base + '/api/projects', { method: 'POST',
    headers: {'Content-Type':'application/json'}, body: JSON.stringify({name:'합성 HTTP 연결 검수'}) })).json();
  const response = await fetch(base + `/api/projects/${created.project.id}/chat`, {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:'프로젝트 상태 조회',
      useModel:true,expectedConnectionId:health.provider.connectionId,expectedVersion:created.project.version,imageIds:[]})});
  const value = await response.json();
  console.log(JSON.stringify({httpStatus:response.status,code:value.code,steps:value.steps?.map(s=>({name:s.name,status:s.status}))}));
  if (!response.ok) process.exitCode = 1;
} finally { await app.close(); await rm(dataDir,{recursive:true,force:true}); }
