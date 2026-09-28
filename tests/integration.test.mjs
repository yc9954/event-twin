import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppServer} from '../server/http.mjs';

test('real engine + API: full event-to-CRM workflow, research and restart persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'event-twin-integration-'));
 let app=await createAppServer({dataDir:dir,port:0,scheduler:false});
 let address=await app.listen(),url=`http://127.0.0.1:${address.port}`;
 const request=async(path,body)=>{const r=await fetch(url+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,`${r.status} ${JSON.stringify(data)}`);return data;};
 try{
 let p=(await request('/api/projects',{name:'통합 검수 행사'})).project;
 const action=async(type,payload={})=>{const response=await request(`/api/projects/${p.id}/actions`,{type,payload,expectedVersion:p.version});p=response.project;return response.result;};
 await action('RUN_RESEARCH');assert.ok(p.research.facilities.length>0);
 await action('UPDATE_SPACE',{confirmed:true});
 await action('GENERATE_CANDIDATES');assert.equal(p.candidates.length,16);
 await action('RUN_SIMULATION');assert.equal(p.simulation.results.length,16);assert.ok(p.simulation.recommendedId);
 const candidateId=p.simulation.recommendedId;
 await action('APPROVE_PLAN',{candidateId});assert.equal(p.approval.candidateId,candidateId);
 await action('BUILD_CRM');assert.ok(p.crm.schema.zones.length>0);assert.ok(p.crm.schema.slots.length>0);
 await action('DEPLOY_CRM');const deployed=p.crm.deployment.id;
 await action('ADD_PERSON',{name:'로컬 검수 참가자',email:'qa@example.invalid',marketingConsent:false});
 const personId=p.crm.people[0].id,registrationId=p.crm.registrations[0].id;
 await action('SET_CONSENT',{personId,granted:true});
 await action('UPDATE_REGISTRATION',{registrationId,status:'waiting',zoneId:p.crm.deployment.schema.zones[0].id});assert.ok(p.crm.tasks.length>0);
 await action('UPDATE_REGISTRATION',{registrationId,status:'completed'});
 const observedStart=Date.parse(p.crm.deployment.appliedAt);
 await action('ADD_OBSERVATION',{visitors:300,completed:120,waitP90:20,consents:60,cost:1000000,completeness:.98,notes:'입력 테스트 / 실제 행사 아님',windowStart:new Date(observedStart).toISOString(),windowEnd:new Date(observedStart+1000).toISOString()});
 await action('RUN_LOOP');assert.equal(p.loop.proposals.length,1);assert.equal(p.loop.proposals[0].status,'pending');assert.equal(p.crm.deployment.id,deployed);
 const persistedId=p.id,persistedVersion=p.version;
 await app.close();app=await createAppServer({dataDir:dir,port:0,scheduler:false});address=await app.listen();url=`http://127.0.0.1:${address.port}`;
 p=(await request(`/api/projects/${persistedId}`)).project;assert.equal(p.version,persistedVersion);assert.equal(p.crm.people[0].name,'로컬 검수 참가자');assert.equal(p.crm.registrations[0].status,'completed');assert.equal(p.crm.consents.at(-1).granted,true);
 await action('UPDATE_ASSUMPTIONS',{visitors:1300});assert.equal(p.simulation,null);assert.equal(p.approval,null);assert.equal(p.crm.deployment.id,deployed);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
