import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/http.mjs';
import { createModelQueue } from '../server/model-queue.mjs';

test('public demo cannot list, export, mutate, upload into, or NAT-audit another session or private project',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'event-twin-demo-'));const app=await createAppServer({dataDir:dir,port:0,scheduler:false});
  await app.listen();t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const old=process.env.EVENT_TWIN_GATEWAY_KEY;process.env.EVENT_TWIN_GATEWAY_KEY='k'.repeat(64);t.after(()=>{if(old===undefined)delete process.env.EVENT_TWIN_GATEWAY_KEY;else process.env.EVENT_TWIN_GATEWAY_KEY=old;});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const headers=owner=>({'x-event-twin-proxy':'vercel','x-event-twin-key':'k'.repeat(64),'x-event-twin-demo':'1','x-event-twin-owner':owner,'content-type':'application/json'});
  const a=headers('a'.repeat(32)),b=headers('b'.repeat(32));
  const create=async h=>(await(await fetch(base+'/api/projects',{method:'POST',headers:h,body:JSON.stringify({name:'synthetic'})})).json()).project;
  const privateProject=await create({'content-type':'application/json'}),p=await create(a),q=await create(b);
  const list=await(await fetch(base+'/api/projects',{headers:a})).json();assert.deepEqual(list.projects.map(p=>p.id),[p.id]);
  for(const id of [privateProject.id,q.id])for(const suffix of ['', '/export','/nat-audit','/uploads/file','/actions','/chat']){
    const r=await fetch(base+`/api/projects/${id}${suffix}`,{headers:a,...(['/actions','/chat'].includes(suffix)?{method:'POST',body:'{}'}:{})});assert.equal(r.status,404);
  }
  assert.equal((await fetch(base+'/api/projects',{headers:{...a,'x-event-twin-key':'wrong'}})).status,401);
  assert.equal((await fetch(base+'/api/projects',{headers:{...a,'x-event-twin-owner':'wrong'}})).status,403);
});
test('model requests queue in FIFO order without usage quotas and release on failure',async()=>{
  const queue=createModelQueue(1);const order=[];let release;
  const first=queue(async()=>{order.push(1);await new Promise(r=>release=r);throw new Error('provider failure');}).catch(()=>{});
  const second=queue(async()=>order.push(2));const third=queue(async()=>order.push(3));
  assert.deepEqual(order,[1]);release();await Promise.all([first,second,third]);assert.deepEqual(order,[1,2,3]);
  for(let i=0;i<50;i++)await queue(async()=>i);
});
