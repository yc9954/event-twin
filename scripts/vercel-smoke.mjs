// Live authenticated deployment QA. Creates one clearly labelled synthetic
// project, never sends real contacts/images, never logs cookies or secrets.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.env.EVENT_TWIN_PUBLIC_URL || 'https://event-twin-nemoclaw.vercel.app';
const session=await fetch(base+'/api/demo-session');assert.equal(session.status,200);
const cookie=session.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
let project;const evidence={url:base,checkedAt:new Date().toISOString(),scope:'synthetic hybrid live deployment QA',checks:[]};
async function request(path,body){
  const response=await fetch(base+path,{headers:{cookie,...(body===undefined?{}:{'content-type':'application/json'})},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(235000)});
  const value=await response.json();if(!response.ok)throw new Error(`${path}: ${response.status} ${value.code||'failed'}`);return value;
}
async function action(type,payload={}){const r=await request(`/api/projects/${project.id}/actions`,{type,payload,expectedVersion:project.version});project=r.project;return r.result;}
async function chat(message,useModel=false,connectionId){
  const started=Date.now();let firstEventMs;const events=[];
  const r=await fetch(base+`/api/projects/${project.id}/chat`,{method:'POST',headers:{cookie,'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({message,useModel,imageIds:[],expectedVersion:project.version,expectedConnectionId:connectionId}),signal:AbortSignal.timeout(235000)});
  assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/ndjson/);
  const decoder=new TextDecoder();let buffer='';
  for await(const bytes of r.body){buffer+=decoder.decode(bytes,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const event=JSON.parse(line);firstEventMs??=Date.now()-started;events.push(event);}}
  const done=events.find(e=>e.type==='response.completed');
  assert.ok(done,`stream failed: ${events.find(e=>e.type==='response.failed')?.code||'incomplete'}`);assert.equal(done.committed,true);project=done.data.project;
  const result={useModel,tools:done.data.steps.map(s=>`${s.name}:${s.status}`),events:events.length,textDeltas:events.filter(e=>e.type==='response.delta').length,firstEventMs,durationMs:Date.now()-started};
  evidence.checks.push(result);console.log(JSON.stringify(result));return done.data;
}
try{
  const h=await request('/api/health');assert.equal(h.access.mode,'public-demo');assert.equal(h.runtime.sandbox.connected,true);
  evidence.provider=h.provider.provider;evidence.model=h.provider.model;
  console.log(JSON.stringify({health:'connected',provider:h.provider.provider,model:h.provider.model}));
  const nat=await request('/api/integrations/nat-check',{});assert.equal(nat.natCheck.verified,true);evidence.natVersion=nat.natCheck.version;
  const probe=await request('/api/integrations/check',{confirm:true,expectedConnectionId:h.provider.connectionId});evidence.integrationCheck=probe.check;
  console.log(JSON.stringify({integrationCheck:probe.check}));
  assert.equal(probe.check.toolCallingVerified,true,'live model/tool roundtrip must pass');
  project=(await request('/api/projects',{name:'Vercel 배포 QA · 합성 행사 (실제 행사 아님)'})).project;evidence.projectId=project.id;
  const read=await chat('프로젝트 상태 조회',true,h.provider.connectionId);assert.ok(read.steps.some(s=>s.name==='get_project'&&s.status==='complete'));
  await action('UPDATE_SPACE',{confirmed:true});
  await chat('16개 안 생성해줘');assert.equal(project.candidates.length,16);
  await chat('시뮬레이션 실행해줘');assert.equal(project.simulation.results.length,16);
  const audit=await request(`/api/projects/${project.id}/nat-audit`);evidence.natAudit=audit.natAudit;
  await action('APPROVE_PLAN',{candidateId:project.simulation.recommendedId});
  await chat('CRM 구축해줘');assert.ok(project.crm.schema.zones.length>0);
  await action('DEPLOY_CRM');assert.equal(project.crm.deployment.externallyDeployed,false);
  await action('ADD_PERSON',{name:'합성 QA 참가자',email:'qa@example.invalid',marketingConsent:false});
  await action('UPDATE_REGISTRATION',{registrationId:project.crm.registrations[0].id,status:'completed',zoneId:project.crm.deployment.schema.zones[0].id});
  const start=Date.parse(project.crm.deployment.appliedAt);
  await action('ADD_OBSERVATION',{visitors:300,completed:120,waitP90:20,consents:60,cost:1000000,completeness:0.98,notes:'합성 QA 관측값 · 실제 행사 데이터 아님',windowStart:new Date(start).toISOString(),windowEnd:new Date(start+1000).toISOString()});
  await action('RUN_LOOP');assert.equal(project.loop.proposals.length,1);
  await chat('운영 현황 조회해줘');
  const saved=(await request(`/api/projects/${project.id}`)).project;assert.equal(saved.version,project.version);assert.equal(saved.crm.registrations.length,1);
  const exported=await fetch(base+`/api/projects/${project.id}/export`,{headers:{cookie}});assert.match(exported.headers.get('content-disposition'),/attachment/);
  const denied=await fetch(base+'/api/projects');assert.equal(denied.status,409);
  const stranger=await fetch(base+'/api/demo-session');const otherCookie=stranger.headers.get('set-cookie').split(';')[0];
  const isolated=await fetch(base+`/api/projects/${project.id}`,{headers:{cookie:otherCookie}});assert.equal(isolated.status,404);
  const csrf=await fetch(base+'/api/projects',{method:'POST',headers:{cookie,origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'});assert.equal(csrf.status,403);
  evidence.ok=true;evidence.summary={candidates:project.candidates.length,results:project.simulation.results.length,crmZones:project.crm.schema.zones.length,crmSlots:project.crm.schema.slots.length,registrations:project.crm.registrations.length,observations:project.observations.length,proposals:project.loop.proposals.length,externalCRM:false,uninitializedSessionStatus:denied.status,otherSessionStatus:isolated.status,foreignOriginStatus:csrf.status};
  console.log(JSON.stringify(evidence.summary));
}catch(error){evidence.ok=false;evidence.error=error.message;console.error(error.message);process.exitCode=1;}
finally{await mkdir(new URL('../.deployment/',import.meta.url),{recursive:true,mode:0o700});await writeFile(new URL('../.deployment/qa-evidence.json',import.meta.url),JSON.stringify(evidence,null,2),{mode:0o600});}
