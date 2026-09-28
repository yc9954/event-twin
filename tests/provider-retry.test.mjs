import test from 'node:test';
import assert from 'node:assert/strict';
import { withProviderRetry } from '../server/provider-retry.mjs';
test('transient provider 500 is bounded and retries inference only', async () => {
  let attempts=0; const waits=[];
  const value=await withProviderRetry(async()=>{if(++attempts<3)throw {status:500};return 'ok';}, {wait:async ms=>waits.push(ms)});
  assert.equal(value,'ok'); assert.equal(attempts,3); assert.deepEqual(waits,[500,1500]);
  attempts=0;
  await assert.rejects(withProviderRetry(async()=>{attempts++;throw new Error('no status');}));
  assert.equal(attempts,1);
});
test('never replay an exposed stream, auth failure, rate limit, or aborted request', async () => {
  for(const status of [401,403,429]) { let n=0;
    await assert.rejects(withProviderRetry(async()=>{n++;throw {status};})); assert.equal(n,1);
  }
  let n=0;
  await assert.rejects(withProviderRetry(async()=>{n++;throw {status:500};},{exposed:()=>true})); assert.equal(n,1);
  await assert.rejects(withProviderRetry(async()=>{throw new Error('should not run');},{signal:AbortSignal.abort()}));
});
