import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { normalizeMapResponse } from '../server/map-service.mjs';

const compiled=await build({entryPoints:[fileURLToPath(new URL('../client/MarketMap.jsx',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',loader:{'.css':'empty'}});
const loaded={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {default:MarketMap,mapContextForPosition,mapCollectionStatus}=loaded.exports;
const project={brief:{lat:37.5445,lng:127.052}};
const onAction=()=>assert.fail('Map rendering must never request data or save coordinates.');
function render(value=project,props={}){return renderToStaticMarkup(React.createElement(MarketMap,{project:value,onLocationChange:onAction,onRefresh:onAction,...props}));}
function makeContext(){return normalizeMapResponse({osm3s:{timestamp_osm_base:'2026-09-28T02:27:15Z'},elements:[{type:'node',id:123,lat:37.5445,lon:127.052,tags:{amenity:'cafe',name:'실제 시설 <공개 원본>'}}]},{latitude:37.5445,longitude:127.052,radiusMeters:500},'2026-09-28T02:28:28.249Z');}

test('map has genuine snapshot attribution and explicit coordinate collection, not address geocoding or fabricated live metrics',()=>{
  const html=render();
  for(const text of ['OPENSTREETMAP · SOURCE-AWARE','배경: 성수동 저장 지도','© OpenStreetMap contributors','이 좌표의 시설 조회','조회 위도','조회 경도','주소 검색이 아니며','실제 OSM 저장 스냅샷','유동인구·매출이 아니며','영업 여부는 미확인'])assert.ok(html.includes(text),text);
  assert.match(html, /<input aria-label="조회 위도"[^>]*step="any"/);
  assert.doesNotMatch(html, /카카오|실시간 유동인구|도보 \d+분|Nominatim/);
  const unavailable=render(project,{onRefresh:undefined});
  assert.match(unavailable, /<button type="submit" disabled=""/);
  assert.match(unavailable,/새 시설 조회 연결이 없습니다/);
});

test('persisted collection shows actual source, timestamps, query hash, coordinate scope and OSM object links',()=>{
  const context=makeContext(),html=render({...project,mapContext:context});
  assert.match(html,/500m 시설 조회 저장됨/);
  assert.match(html,/사용자 요청 수집 · 1개 객체/);
  assert.match(html,/Overpass API · ODbL-1.0/);
  assert.match(html,/OSM 원본 시점/);
  assert.match(html,/실제 시설 &lt;공개 원본&gt;/);
  assert.ok(html.includes(context.source.querySha256));
  assert.ok(html.includes('https://www.openstreetmap.org/node/123'));
  assert.match(html,/직선 0m/);
  assert.match(html,/실제 모든 사업장 목록이나 영업 확인이 아닙니다/);
  assert.match(render({...project,mapContext:{...context,cache:{hit:true}}}),/(?:24시간 캐시|이전 조회 저장본 · 새 조회 권장)/);
});

test('pending requests disable coordinate edits; out-of-basemap locations do not show Seongsu as another location',()=>{
  assert.match(render(project,{pending:true}),/<fieldset disabled="">/);
  const html=render({brief:{lat:37.5665,lng:126.978}});
  assert.match(html,/이 좌표의 배경지도는 포함되어 있지 않습니다/);
  assert.match(html,/<div class="live-geographic-map " hidden="">/);
  assert.match(html,/mlat=37.5665&amp;mlon=126.978/);
});

test('stale or invalid collection is not rendered as current and identical map components get unique clipping identifiers',()=>{
  const context=makeContext();
  assert.equal(mapContextForPosition({...project,mapContext:context}),context);
  for(const patch of [{coordinate:[]},{coordinate:[NaN,37.5445]},{coordinate:[127.051,37.5445]},{collectedAt:'invalid'},{radiusMeters:9999},{facilities:[{id:'node/2',name:'깨진 좌표',coordinates:null,distance:1}]},{stations:[{id:'node/2',name:'깨진 거리',coordinates:[127.052,37.5445],distance:NaN}]},{source:{provider:'Overpass API',querySha256:'bad'}}])assert.equal(mapContextForPosition({...project,mapContext:{...context,...patch}}),null);
  assert.doesNotMatch(render({brief:{lat:37.545,lng:127.052},mapContext:context}),/실제 시설 &lt;공개 원본&gt;/);
  assert.doesNotMatch(render({...project,mapContext:{...context,facilities:[{id:'node/2',name:'깨진 좌표',coordinates:null,distance:1}]}}),/깨진 좌표/);
  const html=renderToStaticMarkup(React.createElement('div',{},React.createElement(MarketMap,{project}),React.createElement(MarketMap,{project})));
  const ids=[...html.matchAll(/<clipPath id="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
});
test('saved map collection is labelled historical after cache expiry, not a fresh 24-hour hit',()=>{
  const context=makeContext(),first=Date.parse(context.collectedAt);
  assert.equal(mapCollectionStatus({...context,cache:{hit:true,expiresAt:new Date(first+86400000).toISOString()}},first+1000),'24시간 캐시');
  assert.equal(mapCollectionStatus({...context,cache:{hit:true,expiresAt:new Date(first+86400000).toISOString()}},first+86400001),'이전 조회 저장본 · 새 조회 권장');
  assert.equal(mapCollectionStatus(context,first+86400001),'이전 조회 저장본 · 새 조회 권장');
});

test('map coordinate and provenance styles remain scoped and responsive without changing app layout',async()=>{
  const css=await readFile(new URL('../client/map.css',import.meta.url),'utf8');
  assert.match(css,/\.market-map-component \.map-coordinate-form\{padding:16px/);
  assert.match(css,/@media\(max-width:600px\)/);
  assert.match(css,/\.market-map-component \[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(css,/--sidebar-width|\.brief-layout|\.sidebar\{/);
});
