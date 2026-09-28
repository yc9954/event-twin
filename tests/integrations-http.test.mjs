import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../server/http.mjs";
import { normalizeMapResponse, MapDataError } from "../server/map-service.mjs";

async function fixture(t, dependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), "event-twin-connection-test-"));
  const app = await createAppServer({
    dataDir: dir,
    port: 0,
    scheduler: false,
    modelConfigured: false,
    dependencies,
  });
  const address = await app.listen(),
    base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return async (path, body) => {
    const response = await fetch(
      base + path,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    return { status: response.status, data: await response.json() };
  };
}
test("model verification is explicitly opted in and missing configuration cannot become successful", async (t) => {
  const request = await fixture(t);
  assert.equal((await request("/api/integrations/check", {})).status, 400);
  const connectionId = (await request("/api/health")).data.provider
    .connectionId;
  const result = await request("/api/integrations/check", {
    confirm: true,
    expectedConnectionId: connectionId,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.check.status, "not-configured");
  assert.equal(result.data.check.connectionId, connectionId);
  const health = (await request("/api/health")).data;
  assert.equal(health.runtime.inference.verified, false);
  assert.equal(health.integrationCheck.inferenceVerified, false);
  assert.equal(health.integrationCheck.connectionId, health.provider.connectionId);
  assert.equal("apiKey" in health.provider, false);
});
test("map refresh saves server-fetched provenance and coordinates; stale versions do not fetch", async (t) => {
  let calls = 0;
  const request = await fixture(t, {
    fetchMapContext: async (input) => {
      calls++;
      return normalizeMapResponse(
        {
          elements: [
            {
              type: "node",
              id: 42,
              lat: input.latitude,
              lon: input.longitude,
              tags: { name: "테스트 fixture 카페", amenity: "cafe" },
            },
          ],
          osm3s: { timestamp_osm_base: new Date().toISOString() },
        },
        input,
        new Date().toISOString(),
      );
    },
  });
  const p = (await request("/api/projects", { name: "지도 계약 테스트" })).data
    .project;
  const body = {
    expectedVersion: p.version,
    latitude: 37.54,
    longitude: 127.05,
    radiusMeters: 300,
  };
  const result = await request(`/api/projects/${p.id}/map-refresh`, body);
  assert.equal(result.status, 200);
  const updated = result.data.project;
  assert.equal(updated.brief.lat, body.latitude);
  assert.equal(updated.mapContext.source.provider, "Overpass API");
  assert.ok(updated.research);
  assert.equal(updated.mapContext.facilities.length, 1);
  assert.equal(
    (await request(`/api/projects/${p.id}/map-refresh`, body)).status,
    409,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await request(`/api/projects/${p.id}/map-refresh`, {
        ...body,
        expectedVersion: updated.version,
        endpoint: "https://evil.invalid",
      })
    ).status,
    400,
  );
  assert.equal(calls, 1);
});
test("map upstream failures roll back every project change and preserve previous data", async (t) => {
  const request = await fixture(t, {
    fetchMapContext: async () => {
      throw new MapDataError("상위 서비스 제한", "MAP_RATE_LIMITED", 429);
    },
  });
  const p = (await request("/api/projects", { name: "지도 실패 테스트" })).data
    .project;
  const result = await request(`/api/projects/${p.id}/map-refresh`, {
    expectedVersion: p.version,
    latitude: 37.55,
    longitude: 127.04,
    radiusMeters: 500,
  });
  assert.equal(result.status, 429);
  assert.equal(result.data.code, "MAP_RATE_LIMITED");
  assert.deepEqual((await request(`/api/projects/${p.id}`)).data.project, p);
});
