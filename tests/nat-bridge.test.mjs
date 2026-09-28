import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNatBridge, getNatExperimentAudit} from '../server/nat-bridge.mjs';
test('NAT bridge verifies read-only framework receipt without claiming inference',async()=>{
 const result=await checkNatBridge({fetchImpl:async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:8008/generate');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{input_message:'health'});
  return Response.json({value:JSON.stringify({framework:'nvidia-nat',version:'1.9.0',tool:'health',readOnly:true,inferencePerformed:false,result:{ok:true}})});
 }});
 assert.equal(result.verified,true);assert.equal(result.inferenceVerified,false);
});
test('NAT bridge rejects unknown framework, false proof, large and failed responses',async()=>{
 for(const response of [Response.json({value:'{}'}),new Response('x'.repeat(17000)),new Response('',{status:503})]) {
  const result=await checkNatBridge({fetchImpl:async()=>response});assert.equal(result.connected,false);assert.equal(result.verified,false);
 }
});

test('NAT experiment audit sends only a project identifier and verifies a 16-outcome receipt', async () => {
 const id = 'EVT-project-1';
 const rows = Array.from({length:16}, (_, i) => ({
  candidateId:String.fromCharCode(65+i), sourcePath:`simulation.results[${i}]`,
  feasible:true, completed:100+i,
  completionRate:50, waitP90Minutes:5, costKRW:50000000,
  scenarioConsents:300, completionRateReplicateP10P90:[45,55], reasonCodes:[],
  constraintChecks:{budget:true,completionRate:true,waitP90:true,consents:true},
  privateEmail:'should-not-forward',
 }));
 const audit = await getNatExperimentAudit(id, {fetchImpl:async (url, options) => {
  assert.equal(url, 'http://127.0.0.1:8008/generate');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(JSON.parse(options.body).input_message),
   {tool:'experiment_audit', projectId:id});
  return Response.json({value:JSON.stringify({framework:'nvidia-nat',version:'1.9.0',
   tool:'experiment_audit',readOnly:true,inferencePerformed:false,
   result:{status:'audited',projectId:id,projectVersion:4,inputRevision:2,
    batchId:'SIM-test',method:'paired-seeded-discrete-event-v1 (uncalibrated)',
    calibration:'uncalibrated',pairedSamples:true,seed:42,replications:12,
    constraints:{budget:60000000,minCompletionRate:40,maxWaitMinutes:12,minConsent:240},
    candidateCount:16,feasibleCount:16,results:rows,
    rankedFeasibleIds:rows.map((row)=>row.candidateId).reverse(),
    recommendedId:'P',selectedId:'P',
    evidence:{source:'persisted-local-project-simulation',forecastValidated:false,
     sameSurveyedFixedBuilding:false},privateEmail:'should-not-forward'}})});
 }});
 assert.equal(audit.status,'audited');
 assert.equal(audit.results.length,16);
 assert.equal('privateEmail' in audit,false);
 assert.equal('privateEmail' in audit.results[0],false);
});

test('NAT experiment audit rejects malformed identifiers and receipts', async () => {
 await assert.rejects(getNatExperimentAudit('../secret'), {code:'INVALID_PROJECT_ID'});
 for (const response of [
  Response.json({value:JSON.stringify({framework:'nvidia-nat',version:'1.9.0',
   tool:'experiment_audit',readOnly:true,inferencePerformed:false,
   result:{status:'audited',projectId:'EVT-project-1',candidateCount:16,results:[]}})}),
  new Response('x'.repeat(17000)),
  new Response('', {status:503}),
 ]) await assert.rejects(getNatExperimentAudit('EVT-project-1', {fetchImpl:async()=>response}),
  {code:'NAT_UNAVAILABLE_OR_INVALID'});
});
