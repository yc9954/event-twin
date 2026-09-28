// Fixed loopback endpoint only. NAT is a read-only workflow, not LLM inference,
// model serving, or OpenShell isolation. Never send CRM, chat, images or notes.
const ENDPOINT = 'http://127.0.0.1:8008/generate';
const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_RECEIPT_BYTES = 16_384;

function bridgeError(code = 'NAT_UNAVAILABLE_OR_INVALID') {
  const error = new Error(code);
  error.code = code;
  error.status = code === 'INVALID_PROJECT_ID' ? 400 : 503;
  return error;
}

async function requestNat(message, tool, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({input_message: message}),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw bridgeError();
    const reader = response.body?.getReader();
    if (!reader) throw bridgeError();
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RECEIPT_BYTES) {
        await reader.cancel();
        throw bridgeError();
      }
      chunks.push(value);
    }
    const wrapper = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const receipt = JSON.parse(wrapper.value);
    if (receipt.framework !== 'nvidia-nat' || receipt.tool !== tool ||
        receipt.readOnly !== true || receipt.inferencePerformed !== false ||
        !/^\d+\.\d+\.\d+$/.test(receipt.version)) throw bridgeError();
    return receipt;
  } catch {
    throw bridgeError();
  }
}

export async function checkNatBridge({fetchImpl = globalThis.fetch} = {}) {
  const checkedAt = new Date().toISOString();
  try {
    const receipt = await requestNat('health', 'health', fetchImpl);
    if (receipt.result?.ok !== true) throw bridgeError();
    return {connected:true,verified:true,checkedAt,framework:receipt.framework,version:receipt.version,scope:'read-only-http-workflow',inferenceVerified:false};
  } catch {
    return {connected:false,verified:false,checkedAt,scope:'read-only-http-workflow',inferenceVerified:false,code:'NAT_UNAVAILABLE_OR_INVALID'};
  }
}

// The returned result is already structurally reduced by the NAT function.
// Validate its contract again before a caller can expose it in chat or UI.
export async function getNatExperimentAudit(projectId, {fetchImpl = globalThis.fetch} = {}) {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))
    throw bridgeError('INVALID_PROJECT_ID');
  const receipt = await requestNat(JSON.stringify({tool:'experiment_audit', projectId}),
    'experiment_audit', fetchImpl);
  const result = receipt.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      result.projectId !== projectId ||
      !['not_run', 'stale', 'invalid', 'audited'].includes(result.status))
    throw bridgeError();
  if (!Number.isSafeInteger(result.projectVersion) ||
      !Number.isSafeInteger(result.inputRevision)) throw bridgeError();
  const base = {projectId, projectVersion:result.projectVersion,
    inputRevision:result.inputRevision, status:result.status};
  if (result.status !== 'audited') {
    if (!Array.isArray(result.issueCodes) ||
        result.issueCodes.some((code) => typeof code !== 'string' || !/^[A-Z_]{1,48}$/.test(code)))
      throw bridgeError();
    return {...base, issueCodes:[...result.issueCodes]};
  }
  const validId = (id) => typeof id === 'string' && PROJECT_ID.test(id);
  const validOptionalId = (id) => id === null || validId(id);
  const metrics = ['completed', 'completionRate', 'waitP90Minutes', 'costKRW', 'scenarioConsents'];
  const checks = ['budget', 'completionRate', 'waitP90', 'consents'];
  const limits = ['budget', 'minCompletionRate', 'maxWaitMinutes', 'minConsent'];
  const rows = result.results;
  if (result.candidateCount !== 16 || !Array.isArray(rows) || rows.length !== 16 ||
      !Array.isArray(result.rankedFeasibleIds) ||
      !Number.isSafeInteger(result.feasibleCount) || result.feasibleCount < 0 ||
      result.feasibleCount > 16 || result.rankedFeasibleIds.length !== result.feasibleCount ||
      !validOptionalId(result.recommendedId) || !validOptionalId(result.selectedId) ||
      !validOptionalId(result.batchId) ||
      result.method !== 'paired-seeded-discrete-event-v1 (uncalibrated)' ||
      result.calibration !== 'uncalibrated' || result.pairedSamples !== true ||
      !Number.isSafeInteger(result.seed) || !Number.isSafeInteger(result.replications) ||
      !result.constraints || limits.some((key) => !Number.isFinite(result.constraints[key])) ||
      result.evidence?.forecastValidated !== false ||
      result.evidence?.sameSurveyedFixedBuilding !== false ||
      result.evidence?.source !== 'persisted-local-project-simulation')
    throw bridgeError();
  const safeRows = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || !validId(row.candidateId) ||
        row.sourcePath !== `simulation.results[${index}]` ||
        typeof row.feasible !== 'boolean' ||
        metrics.some((key) => !Number.isFinite(row[key]) || row[key] < 0) ||
        !Array.isArray(row.completionRateReplicateP10P90) ||
        row.completionRateReplicateP10P90.length !== 2 ||
        row.completionRateReplicateP10P90.some((value) => !Number.isFinite(value)) ||
        !Array.isArray(row.reasonCodes) ||
        row.reasonCodes.some((code) => typeof code !== 'string' || !/^[A-Z_]{1,48}$/.test(code)) ||
        !row.constraintChecks || checks.some((key) => typeof row.constraintChecks[key] !== 'boolean'))
      throw bridgeError();
    return {candidateId:row.candidateId, sourcePath:row.sourcePath,
      feasible:row.feasible, completed:row.completed,
      completionRate:row.completionRate, waitP90Minutes:row.waitP90Minutes,
      costKRW:row.costKRW, scenarioConsents:row.scenarioConsents,
      completionRateReplicateP10P90:[...row.completionRateReplicateP10P90],
      reasonCodes:[...row.reasonCodes],
      constraintChecks:Object.fromEntries(checks.map((key) => [key, row.constraintChecks[key]]))};
  });
  const ids = new Set(safeRows.map((row) => row.candidateId));
  const feasible = new Set(safeRows.filter((row) => row.feasible).map((row) => row.candidateId));
  if (ids.size !== 16 || feasible.size !== result.feasibleCount ||
      result.rankedFeasibleIds.some((id) => !validId(id) || !feasible.has(id)) ||
      new Set(result.rankedFeasibleIds).size !== result.feasibleCount ||
      result.recommendedId !== (result.rankedFeasibleIds[0] || null) ||
      (result.selectedId !== null && !ids.has(result.selectedId)))
    throw bridgeError();
  return {...base, batchId:result.batchId, method:result.method,
    calibration:result.calibration, pairedSamples:true, seed:result.seed,
    replications:result.replications,
    constraints:Object.fromEntries(limits.map((key) => [key, result.constraints[key]])),
    candidateCount:16, feasibleCount:result.feasibleCount,
    rankedFeasibleIds:[...result.rankedFeasibleIds],
    recommendedId:result.recommendedId, selectedId:result.selectedId,
    results:safeRows,
    evidence:{source:'persisted-local-project-simulation',
      scope:'structural-consistency-and-stored-constraint-comparison',
      replicateRangeMeaning:'10th–90th percentile of seeded scenario replications, not a predictive confidence interval',
      forecastValidated:false, sameSurveyedFixedBuilding:false}};
}
