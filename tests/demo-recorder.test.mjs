import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const compiled=await build({entryPoints:[new URL('../client/DemoRecorder.jsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const mod={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {default:DemoRecorder,createTabRecorder,chooseRecordingMime,TAB_CAPTURE_OPTIONS}=mod.exports;
function harness({surface='browser',audio=false,denied=false,delayed=false}={}){
  let clock=0,calls=0,constructed=0,resolveRequest;
  const updates=[],created=[],ready=[],revoked=[],timers=new Map(),intervals=new Map(),listeners=new Map();
  const video={readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended';},getSettings:()=>({displaySurface:surface,width:1920,height:1080,frameRate:30}),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const audioTrack={stops:0,stop(){this.stops++;}};
  const stream={getTracks:()=>audio?[video,audioTrack]:[video],getVideoTracks:()=>[video],getAudioTracks:()=>audio?[audioTrack]:[]};
  let recorder;
  class Recorder{
    static isTypeSupported(type){return type==='video/webm;codecs=vp8';}
    constructor(value,options){constructed++;this.stream=value;this.options=options;this.mimeType=options.mimeType;this.state='inactive';recorder=this;}
    start(timeslice){this.timeslice=timeslice;this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['real-stream-chunk'],{type:this.mimeType})});this.onstop?.();}
  }
  const controller=createTabRecorder({mediaDevices:{getDisplayMedia:async options=>{calls++;assert.equal(options,TAB_CAPTURE_OPTIONS);if(denied)throw Object.assign(new Error('cancelled'),{name:'NotAllowedError'});if(delayed)return new Promise(resolve=>resolveRequest=resolve);return stream;}},Recorder,urls:{createObjectURL:blob=>{created.push(blob);return `blob:test-${created.length}`;},revokeObjectURL:url=>revoked.push(url)},now:()=>clock,onUpdate:s=>updates.push(s),onReady:blob=>ready.push(blob),setIntervalFn:(fn,ms)=>{const key=Symbol();intervals.set(key,{fn,ms});return key;},clearIntervalFn:key=>intervals.delete(key),setTimeoutFn:(fn,ms)=>{const key=Symbol();timers.set(key,{fn,ms});return key;},clearTimeoutFn:key=>timers.delete(key)});
  return {controller,video,audioTrack,stream,updates,created,ready,revoked,timers,intervals,listeners,setClock:v=>clock=v,get recorder(){return recorder;},get calls(){return calls;},get constructed(){return constructed;},resolve:()=>resolveRequest(stream)};
}

test('SSR is inert, exposes explicit accessible start action and no hidden recording',()=>{
  const html=renderToStaticMarkup(React.createElement(DemoRecorder));
  assert.match(html,/class="demo-recorder /);assert.match(html,/aria-label="전체 화면 데모 녹화"/);assert.match(html,/data-recording-state="idle"/);
  assert.doesNotMatch(html,/<video|<canvas|demo-recorder-panel/);
});
test('real media request is explicitly tab-preferred, silent and has no monitor or surface-switching option',()=>{
  assert.equal(TAB_CAPTURE_OPTIONS.audio,false);assert.equal(TAB_CAPTURE_OPTIONS.monitorTypeSurfaces,'exclude');assert.equal(TAB_CAPTURE_OPTIONS.surfaceSwitching,'exclude');assert.equal(TAB_CAPTURE_OPTIONS.systemAudio,'exclude');assert.equal(TAB_CAPTURE_OPTIONS.video.displaySurface,'browser');
  assert.equal(chooseRecordingMime({isTypeSupported:()=>false}),null);
  assert.equal(chooseRecordingMime({isTypeSupported:type=>type==='video/mp4'}),'video/mp4');
});
test('accepts verified browser tab, uses 16mbps, records timed chunks then offers actual local Blob',async()=>{
  const h=harness();assert.equal(h.calls,0);await h.controller.start();
  assert.equal(h.calls,1);assert.equal(h.controller.getState().status,'recording');assert.equal(h.recorder.options.videoBitsPerSecond,16000000);assert.equal(h.recorder.timeslice,1000);
  assert.deepEqual(h.controller.getState().settings,{displaySurface:'browser',width:1920,height:1080,frameRate:30});
  await h.controller.start();assert.equal(h.calls,1);
  h.setClock(5210);h.controller.stop();
  assert.equal(h.controller.getState().status,'ready');assert.equal(h.controller.getState().elapsedMs,5210);assert.equal(h.created.length,1);assert.equal(h.ready.length,1);assert.equal(h.ready[0],h.created[0]);assert.equal(await h.created[0].text(),'real-stream-chunk');assert.match(h.controller.getState().filename,/\.webm$/);
  assert.equal(h.video.stops,1);assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
  h.controller.dispose();assert.deepEqual(h.revoked,['blob:test-1']);
});
test('window, monitor and unidentifiable sources are stopped before constructing or starting recorder',async()=>{
  for(const surface of ['window','monitor',undefined]){const h=harness({surface});if(surface===undefined)h.video.getSettings=()=>({width:1920,height:1080});await h.controller.start();assert.equal(h.controller.getState().status,'error');assert.equal(h.constructed,0);assert.equal(h.video.stops,1);assert.equal(h.created.length,0);assert.match(h.controller.getState().error,/브라우저 탭만/);}
});
test('unexpected audio is rejected and all tracks are released without recording',async()=>{
  const h=harness({audio:true});await h.controller.start();assert.equal(h.constructed,0);assert.equal(h.video.stops,1);assert.equal(h.audioTrack.stops,1);assert.match(h.controller.getState().error,/오디오 트랙/);
});
test('permission denial does not fallback or retry and delayed grant after unmount is immediately stopped',async()=>{
  const denied=harness({denied:true});await denied.controller.start();assert.equal(denied.calls,1);assert.equal(denied.constructed,0);assert.match(denied.controller.getState().error,/취소되었거나/);
  const h=harness({delayed:true});const pending=h.controller.start();assert.equal(h.controller.getState().status,'requesting');h.controller.dispose();const length=h.updates.length;h.resolve();await pending;assert.equal(h.video.stops,1);assert.equal(h.constructed,0);assert.equal(h.updates.length,length);
});
test('sharing revocation produces a stopped partial clip and ten-minute deadline is enforced without hidden recording',async()=>{
  const h=harness();await h.controller.start();h.setClock(3100);h.listeners.get('ended')();assert.equal(h.controller.getState().reason,'sharing-ended');assert.equal(h.controller.getState().status,'ready');assert.equal(h.video.stops,1);
  const limit=harness();await limit.controller.start();const deadline=[...limit.timers.values()].find(timer=>timer.ms===600000);assert.ok(deadline);limit.setClock(600000);deadline.fn();assert.equal(limit.controller.getState().reason,'time-limit');assert.equal(limit.controller.getState().status,'ready');assert.equal(limit.video.stops,1);
});
test('recorder error discards incomplete data and unmount closes recording resources',async()=>{
  const h=harness();await h.controller.start();h.recorder.ondataavailable({data:new Blob(['incomplete'])});h.recorder.onerror({error:new Error('encode failed')});assert.equal(h.controller.getState().status,'error');assert.equal(h.created.length,0);assert.equal(h.video.stops,1);assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);
  const active=harness();await active.controller.start();const count=active.updates.length;active.controller.dispose();assert.equal(active.video.stops,1);assert.equal(active.recorder.state,'inactive');assert.equal(active.created.length,0);assert.equal(active.updates.length,count);assert.equal(active.intervals.size,0);assert.equal(active.timers.size,0);
});
test('a recorder with no output cannot become a successful download',async()=>{
  const h=harness();await h.controller.start();h.recorder.stop=function(){this.state='inactive';this.onstop?.();};h.controller.stop();assert.equal(h.controller.getState().status,'error');assert.equal(h.created.length,0);assert.match(h.controller.getState().error,/저장할 영상 데이터/);
});
test('a stuck recorder finalization times out with no downloadable fake success',async()=>{
  const h=harness();await h.controller.start();h.recorder.stop=function(){this.state='inactive';};h.controller.stop();assert.equal(h.controller.getState().status,'stopping');assert.equal(h.video.stops,1);
  const deadline=[...h.timers.values()].find(timer=>timer.ms===10000);assert.ok(deadline);deadline.fn();assert.equal(h.controller.getState().status,'error');assert.equal(h.created.length,0);assert.equal(h.timers.size,0);assert.match(h.controller.getState().error,/마무리가 완료되지/);
});
