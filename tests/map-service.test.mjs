import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMapService, validateMapRequest, mapQuery, normalizeMapResponse, OVERPASS_ENDPOINT, MAP_CACHE_TTL_MS } from '../server/map-service.mjs';

const request = { latitude: 37.5445, longitude: 127.052, radiusMeters: 500 };
const timestamp = '2026-09-28T02:27:15Z';
const collectedAt = '2026-09-28T02:28:28.249Z';
const element = (id, overrides = {}) => ({ type: 'node', id, lat: request.latitude, lon: request.longitude, tags: { amenity: 'cafe', name: `원본 카페 ${id}` }, ...overrides });
const raw = (elements = [element(1)]) => ({ osm3s: { timestamp_osm_base: timestamp }, elements });
const response = (body = raw(), options) => new Response(JSON.stringify(body), options);
const fixedNow = () => Date.parse(collectedAt);

test('map query accepts explicit numeric coordinates only and caps radius without user-controlled endpoints', () => {
  assert.deepEqual(validateMapRequest({ latitude: 37.54451234, longitude: 127.05201234 }), { latitude: 37.544512, longitude: 127.052012, radiusMeters: 500 });
  for (const input of [{ ...request, latitude: '37.5' }, { ...request, longitude: Infinity }, { ...request, latitude: NaN }, { ...request, latitude: 86 }, { ...request, longitude: 181 }, { ...request, radiusMeters: 1001 }, { ...request, radiusMeters: 499.5 }]) assert.throws(() => validateMapRequest(input), { status: 400 });
  assert.match(mapQuery(request), /around:500,37\.5445,127\.052/);
  assert.match(mapQuery(request), /out center tags/);
  assert.throws(() => mapQuery({ ...request, latitude: '0);out;' }), { code: 'MAP_COORDINATES_INVALID' });
});

test('normalization retains actual object identity, coordinates, provenance and straight distances, not fictional commercial metrics', () => {
  const data = normalizeMapResponse(raw([
    element(1, { tags: { amenity: 'cafe', 'name:ko': '성수 공개 카페', name: 'Public cafe', 'addr:street': '성수이로', 'addr:housenumber': '1' } }),
    element(1),
    element(2, { type: 'way', lat: undefined, lon: undefined, center: { lat: 37.5446, lon: 127.0521 }, tags: { tourism: 'gallery' } }),
    element(3, { tags: { railway: 'station', name: '성수' } }),
    element(4, { lat: 37.6 }),
  ]), request, collectedAt);
  assert.equal(data.facilities.length, 2);
  assert.equal(data.stations.length, 1);
  assert.deepEqual(data.facilities[0].coordinates, [127.052, 37.5445]);
  assert.equal(data.facilities[0].name, '성수 공개 카페');
  assert.equal(data.facilities[0].address, '성수이로 1');
  assert.equal(data.facilities[0].osmUrl, 'https://www.openstreetmap.org/node/1');
  assert.equal(data.facilities[0].distanceMethod, 'haversine-straight-line');
  assert.equal(data.facilities[1].coordinateMethod, 'osm-bounding-box-centre');
  assert.equal(data.facilities[1].name, '이름 미등록 객체');
  assert.equal(data.collectedAt, collectedAt);
  assert.equal(data.source.osmBaseTimestamp, timestamp);
  assert.equal(data.source.provider, 'Overpass API');
  assert.match(data.source.querySha256, /^[a-f0-9]{64}$/);
  assert.equal(data.coverage.queryComplete, true);
  assert.equal(data.coverage.realWorldComplete, false);
  assert.match(data.coverage.meaning, /모든 사업장 목록이나 영업 확인이 아닙니다/);
  for (const key of ['footfall', 'sales', 'walkMinutes', 'population']) assert.equal(data[key], undefined);
});

test('partial provider responses, invalid geometry, excessive objects and missing provenance fail closed', () => {
  assert.throws(() => normalizeMapResponse({ ...raw(), remark: 'runtime error: timeout' }, request, collectedAt), { code: 'MAP_RESPONSE_INCOMPLETE' });
  assert.throws(() => normalizeMapResponse({ elements: [] }, request, collectedAt), { code: 'MAP_PROVENANCE_MISSING' });
  assert.throws(() => normalizeMapResponse(raw([element(1, { lat: undefined })]), request, collectedAt), { code: 'MAP_RESPONSE_INVALID' });
  assert.throws(() => normalizeMapResponse(raw(Array.from({ length: 3001 }, (_, i) => element(i + 1))), request, collectedAt), { code: 'MAP_RESULT_TOO_LARGE' });
  assert.deepEqual(normalizeMapResponse(raw([]), request, collectedAt).facilities, []);
});

test('fixed Overpass endpoint and identified request are used once; concurrent and subsequent requests reuse genuine cached data', async () => {
  let calls = 0;
  const service = createMapService({ cacheDir: null, now: fixedNow, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, OVERPASS_ENDPOINT);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.match(options.headers['User-Agent'], /EventTwinLocalPilot/);
    assert.equal(options.body.get('data'), mapQuery(request));
    return response();
  } });
  const [first, second] = await Promise.all([service.fetchMapContext(request), service.fetchMapContext(request)]);
  const cached = await service.fetchMapContext(request);
  assert.equal(calls, 1);
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.collectedAt, first.collectedAt);
  assert.deepEqual(second.facilities, first.facilities);
  first.facilities[0].name = 'consumer mutation';
  assert.equal((await service.fetchMapContext(request)).facilities[0].name, '원본 카페 1');
});

test('provider requests are spaced and per-process daily limit is enforced', async () => {
  let clock = fixedNow(), calls = 0;
  const waits = [];
  const service = createMapService({ cacheDir: null, dailyLimit: 2, now: () => clock, sleep: async ms => { waits.push(ms); clock += ms; }, fetchImpl: async () => { calls += 1; return response(raw([])); } });
  await service.fetchMapContext(request);
  await service.fetchMapContext({ ...request, radiusMeters: 250 });
  await assert.rejects(service.fetchMapContext({ ...request, radiusMeters: 1000 }), { code: 'MAP_DAILY_LIMIT', status: 429 });
  assert.deepEqual(waits, [1100]);
  assert.equal(calls, 2);
});

test('expired cache is not used as a fake successful fallback after provider failure; 429 is not retried', async () => {
  let clock = fixedNow(), calls = 0;
  const service = createMapService({ cacheDir: null, now: () => clock, fetchImpl: async () => { calls += 1; return calls === 1 ? response() : new Response('rate limited', { status: 429 }); } });
  await service.fetchMapContext(request);
  clock += MAP_CACHE_TTL_MS + 1;
  await assert.rejects(service.fetchMapContext(request), { code: 'MAP_UPSTREAM_RATE_LIMIT', status: 429 });
  assert.equal(calls, 2);
});

test('cache persists across service instances without changing its collection timestamp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-twin-map-test-'));
  try {
    const first = await createMapService({ cacheDir: directory, now: fixedNow, fetchImpl: async () => response() }).fetchMapContext(request);
    assert.equal(first.cache.persisted, true);
    const second = await createMapService({ cacheDir: directory, now: fixedNow, fetchImpl: async () => assert.fail('fresh disk cache must not call upstream') }).fetchMapContext(request);
    assert.equal(second.cache.hit, true);
    assert.equal(second.collectedAt, first.collectedAt);
    assert.equal(second.source.querySha256, first.source.querySha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed JSON, excessive body and aborted requests report real failures without fabricated results', async () => {
  const badJSON = createMapService({ cacheDir: null, fetchImpl: async () => new Response('not json') });
  await assert.rejects(badJSON.fetchMapContext(request), { code: 'MAP_RESPONSE_INVALID' });
  const oversized = createMapService({ cacheDir: null, fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }) });
  await assert.rejects(oversized.fetchMapContext(request), { code: 'MAP_RESULT_TOO_LARGE' });
  const timedOut = createMapService({ cacheDir: null, timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(timedOut.fetchMapContext(request), { code: 'MAP_TIMEOUT', status: 504 });
});
