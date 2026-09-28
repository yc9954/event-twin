import { randomUUID } from 'node:crypto';
import { createProject } from './domain.mjs';

// A real, opt-in provider probe. It never receives an owner's project, contacts,
// images, or message history. Unit tests inject an agent and are not live proof.
export function createIntegrationChecks({ runAgent, getConfiguration, clock = Date.now }) {
  let receipt = null, busy = false, lastAttempt = -Infinity;
  function snapshot() { return receipt ? structuredClone(receipt) : null; }
  async function check() {
    if (busy || clock() - lastAttempt < 30000) {
      const error = new Error('연결 검사는 30초에 한 번만 실행할 수 있습니다.');
      error.status = 429; error.code = 'CHECK_RATE_LIMITED'; throw error;
    }
    const config = getConfiguration();
    const base = { provider: config.provider, model: config.model, connectionId: config.connectionId || null, checkedAt: new Date(clock()).toISOString(), scope: 'synthetic-read-only-tool-roundtrip', configured: config.configured, inferenceVerified: false, toolCallingVerified: false, projectDataSent: false };
    if (!config.configured) { receipt = { ...base, status: 'not-configured', code: 'MODEL_NOT_CONFIGURED', durationMs: 0 }; return snapshot(); }
    busy = true; lastAttempt = clock();
    const started = clock(), nonce = randomUUID();
    let invoked = false, attempts = 0;
    const probeProject = createProject('연결 검사용 임시 프로젝트 — 실제 비즈니스 아님');
    try {
      const result = await runAgent({
        project: structuredClone(probeProject),
        message: 'This is a connectivity test. Call get_project exactly once. Its returned project.brief.goal contains a NEW random verification token. Return that new goal verbatim. Do not use the initial context goal. Do not call any other tool.',
        useModel: true, imageIds: [],
        executeTool: async name => {
          attempts++;
          if (name !== 'get_project') throw new Error('연결 검사는 get_project만 허용합니다.');
          invoked = true;
          probeProject.brief.goal = nonce;
          return structuredClone(probeProject);
        },
        loadImage: async () => { throw new Error('연결 검사는 이미지를 전송하지 않습니다.'); },
      });
      const returned = typeof result?.reply === 'string' && result.reply.length > 0;
      const explicitRead = result?.steps?.length === 1 && result.steps[0].name === 'get_project' && result.steps[0].status === 'complete';
      const roundtrip = invoked && attempts === 1 && explicitRead && returned && result.reply.includes(nonce);
      receipt = { ...base, provider: result.provider || base.provider, model: result.model || base.model,
        primaryProvider: base.provider, fallback: result.modelContext?.fallback || null,
        status: roundtrip ? 'verified' : 'incomplete', code: roundtrip ? null : 'TOOL_ROUNDTRIP_NOT_PROVEN', inferenceVerified: returned, toolCallingVerified: roundtrip, durationMs: clock() - started };
    } catch (error) {
      const code = String(error.code || error.error?.code || 'MODEL_REQUEST_FAILED');
      const safeCode = /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : 'MODEL_REQUEST_FAILED';
      receipt = { ...base, status: 'failed', code: safeCode, httpStatus: Number.isInteger(error.status) ? error.status : null, durationMs: clock() - started };
    } finally { busy = false; }
    return snapshot();
  }
  return { check, snapshot };
}
