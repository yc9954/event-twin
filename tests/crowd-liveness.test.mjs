import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCandidates,runBatch} from '../shared/simulation.mjs';
import {makeVenue,createCrowd,stepCrowd,createNavigation} from '../shared/scene.mjs';

const candidates=generateCandidates({width:24,depth:18,height:3.4,family:'gallery',variant:0,booths:3,staff:6});
for(const candidate of candidates){
  test(`${candidate.id} ${candidate.family}: meaningful movement persists at 60 and 300 seconds`,()=>{
    const crowd=createCrowd(makeVenue(candidate),24);let before;
    for(let frame=0;frame<9000;frame++){
      if(frame===1500||frame===8700)before=crowd.agents.map(a=>({x:a.x,z:a.z,distance:a.distance}));
      stepCrowd(crowd,1/30);
      if(frame===1799||frame===8999){
        const moving=crowd.agents.filter((a,i)=>Math.hypot(a.x-before[i].x,a.z-before[i].z)>.25);
        assert.ok(moving.length>=12,`${(frame+1)/30}s: only ${moving.length}/24 translated >25cm during the last 10s`);
        for(const [i,a]of crowd.agents.entries()){
          assert.ok(crowd.nav.free(a.x,a.z),`agent ${i} must not penetrate obstacles`);
          assert.ok(Number.isFinite(a.speed)&&a.speed>=0&&a.speed<2);
          if(a.distance-before[i].distance<1e-6)assert.equal(a.speed,0,`agent ${i} cannot keep walking without translating`);
        }
      }
    }
  });
}
test('off-grid route starts from the actual visitor position and never snaps across a corner',()=>{
  const venue=makeVenue(candidates.find(c=>c.id==='O')),nav=createNavigation(venue);
  const from=[4.859854940385992,4.873475147300358],to=[12,4.5];
  assert.ok(nav.free(...from));const path=nav.path(from,to);
  assert.ok(path.length>1);assert.deepEqual(path[0],from);
  for(let i=1;i<path.length;i++)assert.ok(nav.segmentFree(path[i-1],path[i]));
});
test('optimized segment clearance agrees with the original 12 cm sampling rule',()=>{
  const original=(nav,a,b)=>{
    const n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.12);
    for(let i=0;i<=n;i++){
      const t=n?i/n:0;
      if(!nav.free(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t))return false;
    }
    return true;
  };
  let state=987654321;
  const rand=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/4294967296);
  for(const c of [candidates[0],candidates[4],candidates[8],candidates[12]]){
    const venue=makeVenue(c),nav=createNavigation(venue);
    for(let i=0;i<160;i++){
      const a=[rand()*venue.width,rand()*venue.depth];
      const b=[rand()*venue.width,rand()*venue.depth];
      assert.equal(nav.segmentFree(a,b),original(nav,a,b),`${c.id} segment ${i}`);
    }
  }
});
test('visual crowd recovery does not change paired simulation baseline metrics',()=>{
  const result=runBatch(candidates).results.find(r=>r.candidateId==='O');
  assert.deepEqual({completed:result.completed,rate:result.rate,waitP90:result.waitP90,cost:result.cost},
    {completed:1191,rate:99.28,waitP90:5.83,cost:39960624});
});
test('a blocked visitor cannot advance its gait without translating; zero dt changes nothing',()=>{
  const agent={id:0,x:0,z:0,y:0,heading:Math.PI/2,speed:1,stride:0,distance:0,target:0,path:[[0,0],[1,0]],index:1,wait:0,activity:'이동',walkBlend:1,maxSpeed:1,cycle:0};
  const crowd={agents:[agent],stops:[{x:1,z:0,activity:'관람'}],nav:{segmentFree:()=>false,free:()=>false,path:()=>[[0,0],[1,0]]}};
  const original=structuredClone(agent);stepCrowd(crowd,0);assert.deepEqual(agent,original);
  for(let i=0;i<20;i++)stepCrowd(crowd,1/30);
  assert.equal(agent.speed,0);assert.equal(agent.stride,0);assert.equal(agent.distance,0);
  assert.equal(agent.x,0);assert.equal(agent.z,0);assert.ok(agent.walkBlend<.02);
});
