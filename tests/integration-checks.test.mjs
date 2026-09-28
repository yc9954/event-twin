import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationChecks } from '../server/integration-checks.mjs';
import { runAgent } from '../server/agent.mjs';
const config = {provider:'nvidia',model:'test-model',connectionId:'model-v1-current',configured:true};
test('probe does not call an unconfigured provider', async () => {
  const checks = createIntegrationChecks({getConfiguration:()=>({...config,configured:false}),runAgent:()=>assert.fail('must not run')});
  assert.equal((await checks.check()).status,'not-configured');
});
test('verification requires actual tool nonce roundtrip; generic text is not sufficient', async () => {
  const checks = createIntegrationChecks({getConfiguration:()=>config,runAgent:async()=>({reply:'OK'})});
  const result=await checks.check(); assert.equal(result.inferenceVerified,true);assert.equal(result.toolCallingVerified,false);assert.equal(result.status,'incomplete');
});
test('probe executes only isolated read-only test, verifies returned nonce, and rate limits', async () => {
  const checks = createIntegrationChecks({getConfiguration:()=>config,runAgent:async({project,executeTool,imageIds})=>{
    assert.equal(project.messages.length,0);assert.equal(project.crm.people.length,0);assert.deepEqual(imageIds,[]);
    return {reply:(await executeTool('get_project')).brief.goal,steps:[{name:'get_project',status:'complete'}]};
  }});
  const result=await checks.check();assert.equal(result.status,'verified');assert.equal(result.projectDataSent,false);
  assert.equal(result.connectionId, config.connectionId);
  await assert.rejects(()=>checks.check(),e=>e.code==='CHECK_RATE_LIMITED');
});
test('a forbidden attempt plus implicit state refresh cannot pass verification', async () => {
 const checks = createIntegrationChecks({getConfiguration:()=>config,runAgent:async({executeTool})=>{
  await assert.rejects(()=>executeTool('propose_space'),/get_project/);
  return {reply:(await executeTool('get_project')).brief.goal,steps:[{name:'propose_space',status:'failed'}]};
 }});
 assert.equal((await checks.check()).toolCallingVerified,false);
});
test('provider errors preserve safe codes without leaking messages or keys', async () => {
  const checks = createIntegrationChecks({getConfiguration:()=>config,runAgent:async()=>{throw Object.assign(new Error('secret-key-in-message'),{status:429,code:'credit_balance_exhausted'});}});
  const result=await checks.check();assert.equal(result.code,'credit_balance_exhausted');assert.equal(result.inferenceVerified,false);assert.doesNotMatch(JSON.stringify(result),/secret/);
});

test('real agent loop cannot upgrade a failed mutation and implicit refresh to verified', async () => {
  let rounds = 0;
  const client = { responses: { create: async request => ++rounds === 1
    ? {output:[{type:'function_call',name:'propose_space',call_id:'bad-call',arguments:'{}'}]}
    : {output:[],output_text:JSON.stringify(request.input)} } };
  const checks = createIntegrationChecks({
    getConfiguration:()=>config,
    runAgent:args=>runAgent({...args,client,env:{MODEL_PROVIDER:'openai',OPENAI_API_KEY:'fixture-key'}}),
  });
  const receipt = await checks.check();
  assert.equal(rounds,2);
  assert.equal(receipt.status,'incomplete');
  assert.equal(receipt.inferenceVerified,true);
  assert.equal(receipt.toolCallingVerified,false);
});
