import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProxyHandler } from '../api/proxy.mjs';
import { passwordHash, issueSession, COOKIE } from '../deploy/vercel/auth.mjs';
const env={EVENT_TWIN_SESSION_SECRET:'s'.repeat(64),EVENT_TWIN_PASSWORD_HASH:passwordHash('fixture-password'),
  EVENT_TWIN_GATEWAY_KEY:'k'.repeat(64),EVENT_TWIN_BACKEND_URL:'https://backend.example/event-twin-api/'};
async function harness(t,{fetchImpl,parsed=false,publicDemo=false}={}) {
  const calls=[];
  const proxy=createProxyHandler({env:{...env,...(publicDemo?{EVENT_TWIN_PUBLIC_DEMO:'true'}:{})},fetchImpl:fetchImpl|| (async(url,options)=>{calls.push({url:String(url),options});return Response.json({ok:true});})});
  const server=createServer(async(req,res)=>{
    if(parsed&&req.method==='POST'){let raw='';for await(const c of req)raw+=c;req.body=Object.fromEntries(new URLSearchParams(raw));}
    await proxy(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookie=`${COOKIE}=${issueSession(env.EVENT_TWIN_SESSION_SECRET)}`;
  return {calls,cookie,request:(path,options={})=>fetch(base+path,{redirect:'manual',...options})};
}
test('anonymous reads never reach backend; password form creates secure owner session',async t=>{
  const h=await harness(t);
  const blocked=await h.request('/api/health');assert.equal(blocked.status,401);assert.equal(h.calls.length,0);
  const page=await h.request('/api/auth');assert.match(await page.text(),/워크스페이스 비밀번호/);
  const bad=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'password=wrong'});
  assert.match(bad.headers.get('location'),/error=1/);assert.equal(bad.headers.get('set-cookie'),null);
  const good=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'password=fixture-password'});
  assert.equal(good.status,303);assert.match(good.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  const health=await h.request('/api/health',{headers:{cookie:h.cookie}});assert.equal(health.status,200);
  assert.equal((await health.json()).access.mode,'private-vercel');assert.equal(h.calls[0].options.headers['x-event-twin-key'],env.EVENT_TWIN_GATEWAY_KEY);
  assert.equal(h.calls[0].options.headers.cookie,undefined);
});
test('supports Vercel parsed forms and rejects cross-origin writes, forged cookies and arbitrary routes',async t=>{
  const h=await harness(t,{parsed:true});
  const good=await h.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'password=fixture-password'});assert.equal(good.status,303);assert.ok(good.headers.get('set-cookie'));
  const hostile=await h.request('/api/projects',{method:'POST',headers:{cookie:h.cookie,origin:'https://attacker.example','content-type':'application/json'},body:'{}'});assert.equal(hostile.status,403);
  assert.equal((await h.request('/api/health',{headers:{cookie:h.cookie+'x'}})).status,401);
  assert.equal((await h.request('/api/proxy?__route=https://attacker.example',{headers:{cookie:h.cookie}})).status,400);
  assert.equal((await h.request('/api/demo/tab-video',{headers:{cookie:h.cookie}})).status,404);
  assert.equal(h.calls.length,0);
});
test('authenticated API forwards JSON and streaming frames without forwarding user credentials',async t=>{
  let captured;
  const h=await harness(t,{fetchImpl:async(url,options)=>{captured={url:String(url),options};return new Response('{"type":"response.delta"}\n{"type":"response.completed"}\n',{headers:{'content-type':'application/x-ndjson'}});}});
  const r=await h.request('/api/proxy?__route=projects/EVT-fixture/chat',{method:'POST',headers:{cookie:h.cookie,'content-type':'application/json','authorization':'DoNotForward'},body:'{"message":"test"}'});
  assert.equal(r.status,200);assert.match(await r.text(),/response.completed/);
  assert.equal(captured.url,'https://backend.example/event-twin-api/projects/EVT-fixture/chat');
  assert.equal(captured.options.body.toString(),'{"message":"test"}');assert.equal(captured.options.headers.authorization,undefined);
});
test('upstream infrastructure authentication HTML fails with a safe JSON error',async t=>{
  const h=await harness(t,{fetchImpl:async()=>new Response('<html>infrastructure login</html>',{status:403,headers:{'content-type':'text/html'}})});
  const r=await h.request('/api/health',{headers:{cookie:h.cookie}});assert.equal(r.status,502);assert.equal((await r.json()).code,'BACKEND_UNAVAILABLE');
});
test('public demo has no login and gives each browser a signed, isolated anonymous session',async t=>{
  const h=await harness(t,{publicDemo:true});
  assert.equal((await h.request('/api/auth')).headers.get('location'),'/');
  assert.equal((await h.request('/api/health')).status,409);
  const session=await h.request('/api/demo-session');assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const health=await h.request('/api/health',{headers:{cookie,'x-event-twin-owner':'untrusted','x-event-twin-demo':'0'}});
  assert.equal((await health.json()).access.mode,'public-demo');
  assert.match(h.calls[0].options.headers['x-event-twin-owner'],/^[a-f0-9]{32}$/);assert.equal(h.calls[0].options.headers['x-event-twin-demo'],'1');
  const second=await h.request('/api/demo-session');assert.notEqual(second.headers.get('set-cookie'),session.headers.get('set-cookie'));
});
