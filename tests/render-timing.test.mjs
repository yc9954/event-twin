import test from 'node:test';
import assert from 'node:assert/strict';
import {planAnimationFrame, resetFrameClock, presentationSize, previewFrameRate, shouldPaint, selectFollowTarget} from '../client/render-timing.mjs';
import {makeVenue, createCrowd, stepCrowd} from '../shared/scene.mjs';

for (const fps of [5, 10, 15, 30, 60, 120]) {
  test(`fixed physics follows one wall-clock second at ${fps} paint opportunities per second`, () => {
    let clock=resetFrameClock(), steps=0;
    for(let i=0;i<=fps;i++) { const plan=planAnimationFrame(clock,i*1000/fps);clock=plan.clock;steps+=plan.steps;assert.ok(plan.stepSeconds<=.05); }
    assert.equal(steps,60);
    assert.ok(clock.accumulator<1e-8);
  });
}
test('pause/hidden reset does not replay minutes of missed simulation on return', () => {
  let clock=planAnimationFrame(resetFrameClock(),0).clock;
  clock=planAnimationFrame(clock,100).clock;
  clock=planAnimationFrame(clock,200,false).clock;
  const resumed=planAnimationFrame(clock,300000);
  assert.equal(resumed.steps,0);
  assert.equal(planAnimationFrame(resumed.clock,300000+1000/60).steps,1);
});
test('long foreground stall catches up at most 250ms and discards excess debt', () => {
  const plan=planAnimationFrame({lastNow:0,accumulator:0},5000);
  assert.equal(plan.steps,15);assert.equal(plan.droppedSeconds,4.75);
  assert.equal(planAnimationFrame(plan.clock,5000+1000/60).steps,1);
});
test('capture bitmap is exactly 1080p independent of CSS size or DPR', () => {
  for(const ratio of [1,2,3])assert.deepEqual(presentationSize({width:850,height:315},{width:1920,height:1080},ratio),{width:1920,height:1080});
  assert.deepEqual(presentationSize({width:850,height:315},null,2),{width:1700,height:630});
  assert.deepEqual(presentationSize({width:4000,height:2000},null,2),{width:2560,height:1280});
  assert.throws(()=>presentationSize({width:850,height:315},{width:10000,height:10000}),RangeError);
});
test('detail/capture paints at 60Hz, compact previews at 30Hz, explicit updates paint immediately', () => {
  const state={dirty:true,forcePaint:false,lastPaintAt:0,now:1000/60};
  assert.equal(shouldPaint({...state,priority:true}),true);
  assert.equal(shouldPaint({...state,priority:false}),false);
  assert.equal(shouldPaint({...state,now:1000/30,priority:false}),true);
  assert.equal(shouldPaint({...state,forcePaint:true,priority:false}),true);
  assert.equal(shouldPaint({...state,dirty:false,forcePaint:true}),false);
});
test('sixteen visible previews have a bounded aggregate cadence while detail remains 60Hz', () => {
  assert.equal(previewFrameRate(1),30);
  assert.equal(previewFrameRate(8),30);
  assert.equal(previewFrameRate(16),15);
  const state={dirty:true,forcePaint:false,lastPaintAt:0,now:1000/30,previewFps:15};
  assert.equal(shouldPaint({...state,priority:false}),false);
  assert.equal(shouldPaint({...state,now:1000/15,priority:false}),true);
  assert.equal(shouldPaint({...state,priority:true}),true);
});
test('follow targets an actually moving visitor and stays stable through brief stops', () => {
  const agents=[{id:0,speed:0,wait:2},{id:1,speed:.6,wait:0},{id:2,speed:1,wait:0}];
  let selected=selectFollowTarget(agents,null,0);assert.equal(selected.id,2);
  agents[1].speed=1.2; selected=selectFollowTarget(agents,selected,1);assert.equal(selected.id,2);
  agents[2].speed=0;agents[2].wait=4;
  selected=selectFollowTarget(agents,selected,2);assert.equal(selected.id,2);
  selected=selectFollowTarget(agents,selected,5);assert.equal(selected.id,1);
  assert.equal(selectFollowTarget([],null,0),null);
});
test('5fps drawing opportunities and 60fps produce identical crowd coordinates after 5 seconds', () => {
  const venue=makeVenue({id:'timing',family:'gallery',variant:0,booths:3,staff:6,space:{width:24,depth:18,height:3.4}});
  const advance=fps=>{const crowd=createCrowd(venue,24);let clock=resetFrameClock();for(let i=0;i<=fps*5;i++){const plan=planAnimationFrame(clock,i*1000/fps);clock=plan.clock;for(let s=0;s<plan.steps;s++)stepCrowd(crowd,plan.stepSeconds);}return crowd.agents.map(a=>[a.x,a.z,a.stride]);};
  assert.deepEqual(advance(5),advance(60));
});
