import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const MAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 4 * 1024 * 1024, MAX_ELEMENTS = 3000;
const AMENITIES = ['cafe', 'restaurant', 'theatre', 'arts_centre', 'library'];
const TOURISM = ['museum', 'gallery'];
const sha = value => createHash('sha256').update(value).digest('hex');
export class MapDataError extends Error {
  constructor(message, code = 'MAP_UPSTREAM_UNAVAILABLE', status = 502) { super(message); this.name = 'MapDataError'; this.code = code; this.status = status; }
}
export function validateMapRequest({ latitude, longitude, radiusMeters = 500 } = {}) {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 85 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new MapDataError('위도(-85~85)·경도(-180~180)를 숫자로 입력하세요.', 'MAP_COORDINATES_INVALID', 400);
  if (!Number.isInteger(radiusMeters) || radiusMeters < 100 || radiusMeters > 1000) throw new MapDataError('조회 반경은 100~1,000m 정수여야 합니다.', 'MAP_RADIUS_INVALID', 400);
  return { latitude: +latitude.toFixed(6), longitude: +longitude.toFixed(6), radiusMeters };
}
export function mapQuery(input) {
  const { latitude, longitude, radiusMeters } = validateMapRequest(input);
  const around = `(around:${radiusMeters},${latitude},${longitude})`;
  return `[out:json][timeout:20][maxsize:16777216];\n(\n nwr["amenity"~"^(${AMENITIES.join('|')})$"]${around};\n nwr["tourism"~"^(${TOURISM.join('|')})$"]${around};\n nwr["railway"="station"]${around};\n nwr["public_transport"="station"]${around};\n);\nout center tags;`;
}
function distance(a, b) {
  const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dp = (b[1] - a[1]) * r;
  const v = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));
}
export function normalizeMapResponse(raw, input, collectedAt) {
  const request = validateMapRequest(input), coordinate = [request.longitude, request.latitude];
  if (!raw || !Array.isArray(raw.elements) || raw.remark) throw new MapDataError('Overpass가 완전한 조회 응답을 반환하지 않았습니다. 이전 자료로 대체하지 않습니다.', 'MAP_RESPONSE_INCOMPLETE');
  if (raw.elements.length > MAX_ELEMENTS) throw new MapDataError('조회 객체가 너무 많습니다. 반경을 줄여 다시 요청하세요.', 'MAP_RESULT_TOO_LARGE');
  if (!raw.osm3s?.timestamp_osm_base || !Number.isFinite(Date.parse(raw.osm3s.timestamp_osm_base))) throw new MapDataError('원본 데이터 시점이 없는 응답은 사용하지 않습니다.', 'MAP_PROVENANCE_MISSING');
  const facilities = [], stations = [], seen = new Set();
  for (const element of raw.elements) {
    if (!['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id) || element.id <= 0) throw new MapDataError('OSM 객체 식별자가 잘못된 응답입니다.', 'MAP_RESPONSE_INVALID');
    const id = `${element.type}/${element.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = element.tags || {}, point = element.type === 'node' ? element : element.center;
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 85 || Math.abs(point.lon) > 180) throw new MapDataError('좌표가 누락된 OSM 응답은 사용하지 않습니다.', 'MAP_RESPONSE_INVALID');
    const coordinates = [point.lon, point.lat], metres = distance(coordinate, coordinates);
    // A way can intersect the query circle while its reported bounding-box centre is outside.
    if (metres > request.radiusMeters) continue;
    const isStation = tags.railway === 'station' || tags.public_transport === 'station';
    const kind = AMENITIES.includes(tags.amenity) ? tags.amenity : TOURISM.includes(tags.tourism) ? tags.tourism : isStation ? 'station' : null;
    if (!kind) continue;
    const name = String(tags['name:ko'] || tags.name || '이름 미등록 객체').slice(0, 200);
    const item = { id, name, kind, coordinates, distance: Math.round(metres), distanceMethod: 'haversine-straight-line', coordinateMethod: element.type === 'node' ? 'osm-node' : 'osm-bounding-box-centre', osmUrl: `https://www.openstreetmap.org/${id}`, address: ['addr:city', 'addr:district', 'addr:street', 'addr:housenumber'].map(key => tags[key]).filter(value => typeof value === 'string').join(' ').slice(0, 400) || null };
    (isStation ? stations : facilities).push(item);
  }
  facilities.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  stations.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const query = mapQuery(request), deltaLat = request.radiusMeters / 6371000 * 180 / Math.PI, deltaLng = deltaLat / Math.cos(request.latitude * Math.PI / 180);
  const coverage = { status: 'full', complete: true, queryComplete: true, realWorldComplete: false, radius: request.radiusMeters, coordinate, bbox: [request.longitude - deltaLng, request.latitude - deltaLat, request.longitude + deltaLng, request.latitude + deltaLat], categories: [...AMENITIES, ...TOURISM, 'station'], meaning: '선택 반경·조회 분류에 대한 OSM 응답. 실제 모든 사업장 목록이나 영업 확인이 아닙니다.' };
  return { schemaVersion: 1, ...request, coordinate, radius: request.radiusMeters, collectedAt, source: { mode: 'overpass-query', name: 'OpenStreetMap contributors via Overpass API', provider: 'Overpass API', endpoint: OVERPASS_ENDPOINT, url: 'https://www.openstreetmap.org/copyright', license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', collectedAt, capturedAt: collectedAt, osmBaseTimestamp: raw.osm3s.timestamp_osm_base, query, querySha256: sha(query) }, coverage, facilities, stations, returnedElementCount: raw.elements.length, warning: 'OSM 객체 수는 고유 사업장 수·유동인구·매출이 아닙니다. 같은 장소가 중복 등록될 수 있으며 영업 여부는 미확인입니다. 거리는 도보 경로가 아닌 직선거리이고 면 객체의 위치는 외곽 상자 중심점일 수 있습니다.' };
}
async function boundedJSON(response) {
  if (+response.headers.get('content-length') > MAX_BYTES) throw new MapDataError('지도 응답 크기 제한을 초과했습니다.', 'MAP_RESULT_TOO_LARGE');
  if (!response.body?.getReader) throw new MapDataError('지도 응답 본문이 없습니다.', 'MAP_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BYTES) { await reader.cancel(); throw new MapDataError('지도 응답 크기 제한을 초과했습니다.', 'MAP_RESULT_TOO_LARGE'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MapDataError('지도 서비스가 유효한 JSON을 반환하지 않았습니다.', 'MAP_RESPONSE_INVALID'); }
}

/** Manual, single-user requests only. No geocoding, autocomplete, retries or provider fallback. */
export function createMapService({ fetchImpl = globalThis.fetch, cacheDir = fileURLToPath(new URL('../data/map-cache/', import.meta.url)), now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), minIntervalMs = 1100, timeoutMs = 25000, ttlMs = MAP_CACHE_TTL_MS, dailyLimit = 200 } = {}) {
  const cache = new Map(), inFlight = new Map();
  let queue = Promise.resolve(), nextRequestAt = 0, day = '', requestCount = 0;
  async function readCache(key, request) {
    let entry = cache.get(key);
    if (!entry && cacheDir) { try { entry = JSON.parse(await readFile(join(cacheDir, `${key}.json`), 'utf8')); } catch {} }
    if (!entry || entry.schemaVersion !== 1 || entry.source?.provider !== 'Overpass API' || entry.latitude !== request.latitude || entry.longitude !== request.longitude || entry.radiusMeters !== request.radiusMeters || !Array.isArray(entry.facilities) || !Array.isArray(entry.stations)) return null;
    const age = now() - Date.parse(entry.collectedAt);
    if (!Number.isFinite(age) || age < 0 || age >= ttlMs) return null;
    cache.set(key, entry);
    return { ...structuredClone(entry), cache: { hit: true, expiresAt: new Date(Date.parse(entry.collectedAt) + ttlMs).toISOString() } };
  }
  async function query(request, key) {
    const cached = await readCache(key, request); if (cached) return cached;
    const currentDay = new Date(now()).toISOString().slice(0, 10);
    if (day !== currentDay) { day = currentDay; requestCount = 0; }
    if (requestCount >= dailyLimit) throw new MapDataError('공공 지도 조회의 일일 파일럿 한도에 도달했습니다. 저장된 자료를 이용하거나 자체 제공자를 구성하세요.', 'MAP_DAILY_LIMIT', 429);
    const delay = Math.max(0, nextRequestAt - now()); if (delay) await sleep(delay);
    nextRequestAt = now() + minIntervalMs; requestCount += 1;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    let data;
    try {
      const response = await fetchImpl(OVERPASS_ENDPOINT, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'EventTwinLocalPilot/0.1 (single-user manual offline-event geographic analysis)' }, body: new URLSearchParams({ data: mapQuery(request) }), signal: controller.signal });
      if (!response.ok) throw new MapDataError(`지도 제공자 조회 실패 (HTTP ${response.status}). 저장된 자료로 자동 대체하지 않았습니다.`, response.status === 429 ? 'MAP_UPSTREAM_RATE_LIMIT' : 'MAP_UPSTREAM_UNAVAILABLE', response.status === 429 ? 429 : 502);
      data = normalizeMapResponse(await boundedJSON(response), request, new Date(now()).toISOString());
    } catch (error) {
      if (error instanceof MapDataError) throw error;
      throw new MapDataError(controller.signal.aborted ? '지도 조회 시간이 초과되었습니다. 자동 재시도하지 않았습니다.' : '공공 지도 제공자에 연결하지 못했습니다. 예시 데이터로 대체하지 않았습니다.', controller.signal.aborted ? 'MAP_TIMEOUT' : 'MAP_UPSTREAM_UNAVAILABLE', controller.signal.aborted ? 504 : 502);
    } finally { clearTimeout(timeout); }
    cache.set(key, data);
    let persisted = false;
    if (cacheDir) {
      try { await mkdir(cacheDir, { recursive: true, mode: 0o700 }); const temporary = join(cacheDir, `${key}.${randomUUID()}.tmp`); await writeFile(temporary, JSON.stringify(data), { mode: 0o600 }); await rename(temporary, join(cacheDir, `${key}.json`)); persisted = true; } catch { /* In-memory cache still prevents repeated provider calls during this process. */ }
    }
    return { ...structuredClone(data), cache: { hit: false, persisted, expiresAt: new Date(Date.parse(data.collectedAt) + ttlMs).toISOString() } };
  }
  async function fetchMapContext(input) {
    const request = validateMapRequest(input), key = sha(`map-v1:${mapQuery(request)}`);
    const cached = await readCache(key, request); if (cached) return cached;
    if (inFlight.has(key)) return structuredClone(await inFlight.get(key));
    const pending = queue.catch(() => {}).then(() => query(request, key)); queue = pending;
    inFlight.set(key, pending);
    try { return await pending; } finally { inFlight.delete(key); }
  }
  return { fetchMapContext };
}
const service = createMapService();
export const fetchMapContext = input => service.fetchMapContext(input);
