import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ASSUMPTIONS,
  MODEL_POLICY,
  generateCandidates,
  runBatch,
  simulateQueue,
  validateAssumptions,
} from "../shared/simulation.mjs";
import { normalizeSpace } from "../shared/scene.mjs";

const space = { width: 24, depth: 18, height: 3.4, family: "gallery", variant: 0, booths: 3, staff: 6 };

test("empty inputs use explicit defaults, while every numeric assumption accepts both endpoints and rejects outside", () => {
  assert.deepEqual(validateAssumptions({}), DEFAULT_ASSUMPTIONS);
  assert.deepEqual(normalizeSpace({}), { ...space, confirmed: false });
  const bounds = {
    visitors: [1, 20000, true], durationMinutes: [30, 1440, false],
    serviceMinutes: [0.2, 60, false], arrivalPeak: [0.1, 8, false],
    patienceMinutes: [0.1, 180, false], consentRate: [0, 1, false],
    budget: [0, 10000000000, true], minCompletionRate: [0, 100, false],
    maxWaitMinutes: [0, 180, false], minConsent: [0, 20000, true],
    seed: [0, 4294967295, true], replications: [2, 40, true],
  };
  for (const [key, [low, high, integer]] of Object.entries(bounds)) {
    assert.equal(validateAssumptions({ [key]: low })[key], low, `${key} minimum`);
    assert.equal(validateAssumptions({ [key]: high })[key], high, `${key} maximum`);
    const step = integer ? 1 : 0.01;
    assert.throws(() => validateAssumptions({ [key]: low - step }), RangeError, `${key} below`);
    assert.throws(() => validateAssumptions({ [key]: high + step }), RangeError, `${key} above`);
    assert.throws(() => validateAssumptions({ [key]: "1" }), RangeError, `${key} string`);
    if (integer) assert.throws(() => validateAssumptions({ [key]: low + 0.5 }), RangeError, `${key} fraction`);
  }
});

test("all spatial minimum and maximum boundaries remain exact, not silently clamped", () => {
  const bounds = {
    width: [8, 100, false], depth: [8, 100, false], height: [2, 12, false],
    booths: [1, 12, true], staff: [1, 40, true], variant: [0, 3, true],
  };
  for (const [key, [low, high, integer]] of Object.entries(bounds)) {
    assert.equal(normalizeSpace({ [key]: low })[key], low);
    assert.equal(normalizeSpace({ [key]: high })[key], high);
    const step = integer ? 1 : 0.01;
    assert.throws(() => normalizeSpace({ [key]: low - step }), RangeError);
    assert.throws(() => normalizeSpace({ [key]: high + step }), RangeError);
    if (integer) assert.throws(() => normalizeSpace({ [key]: low + 0.5 }), RangeError);
  }
  assert.equal(generateCandidates({ ...space, booths: 1, staff: 1 })[0].staff, 1);
  assert.ok(generateCandidates({ ...space, booths: 12, staff: 40 }).every((c) => c.booths <= 12 && c.staff <= 40));
});

test("direct queue kernel handles zero population without a division by zero and rejects mismatched counts", () => {
  const a = { visitors: 0, durationMinutes: 30, consentRate: 0 };
  const p = {
    inaccessible: false, capacity: 1, checkInStaff: 1, intakeMeters: 0,
    zones: [{ capacity: 1, travelMeters: 0 }],
  };
  const r = simulateQueue(a, [], p);
  for (const key of ["completed", "rate", "consents", "abandoned", "unfinished", "meanWait", "travelMinutes"])
    assert.equal(r[key], 0, key);
  assert.equal(r.timeline.length, 25);
  assert.throws(() => simulateQueue({ ...a, visitors: 1 }, [], p), RangeError);
  assert.throws(() => simulateQueue({ ...a, visitors: -1 }, [], p), RangeError);
  assert.throws(() => runBatch([generateCandidates(space)[0]], { visitors: 0 }), RangeError);
});

test("malformed or incomparable candidate contracts are rejected before simulation", () => {
  const cs = generateCandidates(space);
  const base = cs[0];
  const changed = (patch) => [{ ...base, ...patch }];
  for (const sample of [null, {}, { ...base, id: " " }, { ...base, variant: 4 },
    { ...base, booths: 0 }, { ...base, staff: 41 },
    { ...base, space: { ...base.space, booths: base.booths + 1 } },
    { ...base, space: { ...base.space, staff: base.staff + 1 } },
    { ...base, space: { ...base.space, family: "forum" } },
    { ...base, space: { ...base.space, variant: 1 } },
    { ...base, space: { ...base.space, width: undefined } },
    { ...base, space: { ...base.space, height: undefined } },
    { ...base, space: { width: base.space.width } }])
    assert.throws(() => runBatch([sample], { visitors: 1, replications: 2 }), RangeError);
  assert.throws(() => runBatch([base, { ...cs[1], space: { ...cs[1].space, width: 25 } }]), RangeError);
  assert.throws(() => runBatch([base, { ...cs[1], space: { ...cs[1].space, depth: 19 } }]), RangeError);
  assert.throws(() => runBatch([base, { ...cs[1], space: { ...cs[1].space, height: 4 } }]), RangeError);
  assert.throws(() => runBatch(changed({ id: "A" }).concat(cs[1], cs[1])), RangeError);
});

test("all 16 alternatives conserve visitors and modeled capacity across replication counts and edge populations", () => {
  const cs = generateCandidates(space);
  const rates = MODEL_POLICY.costRates;
  for (const [visitors, replications, seed] of [[1, 2, 0], [13, 3, 42], [1200, 2, 4294967295]]) {
    const batch = runBatch(cs, { visitors, replications, seed });
    assert.equal(batch.results.length, 16);
    assert.equal(batch.assumptions.visitors, visitors);
    for (const [i, r] of batch.results.entries()) {
      const c = cs[i];
      assert.equal(r.completed + r.abandoned + r.unfinished, visitors, `${c.id} aggregate`);
      assert.equal(r.samples.length, replications);
      for (const s of r.samples) {
        assert.equal(s.completed + s.abandoned + s.unfinished, visitors, `${c.id} replication ${s.replication}`);
        assert.ok(s.consents <= s.completed && s.consents >= 0);
      }
      assert.equal(r.timeline.at(-1).completed, r.completed);
      assert.equal(r.cost, Object.values(r.costBreakdown).reduce((sum, value) => sum + value, 0));
      const area = c.space.width * c.space.depth;
      const factor = rates.familyFactors[c.family];
      assert.equal(r.costBreakdown.venue, Math.round(area * rates.venuePerM2 * factor));
      assert.equal(r.costBreakdown.production,
        Math.round(area * rates.productionPerM2 * factor * c.space.height / rates.referenceHeight));
      assert.equal(r.costBreakdown.equipment, c.booths * rates.booth);
      assert.equal(r.costBreakdown.staff,
        Math.round(c.staff * (batch.assumptions.durationMinutes / 60 + rates.staffingSetupHours) * rates.staffHourly));
      assert.equal(r.geometry.serviceStations,
        r.geometry.zoneCapacities.reduce((sum, z) => sum + z.capacity, 0));
      assert.ok(r.geometry.serviceStations <= r.geometry.modeledBooths * MODEL_POLICY.boothParallelCapacity);
      assert.ok(r.geometry.serviceStations <= r.geometry.serviceStaff * MODEL_POLICY.participantsPerFacilitator);
      assert.equal(r.geometry.checkInStaff + r.geometry.serviceStaff, c.staff);
      assert.equal(r.geometry.width, c.space.width);
      assert.equal(r.geometry.depth, c.space.depth);
      assert.equal(r.geometry.height, c.space.height);
    }
    assert.deepEqual(runBatch(cs, { visitors, replications, seed }), batch, "repeat run deterministic");
  }
});

test("max visitors and repetitions execute with finite metrics and conserved population", () => {
  const c = generateCandidates({ width: 100, depth: 100, height: 12, booths: 12, staff: 40 })[15];
  const b = runBatch([c], {
    visitors: 20000, replications: 40, seed: 4294967295,
    budget: 10000000000, minCompletionRate: 0, maxWaitMinutes: 180, minConsent: 0,
  });
  const r = b.results[0];
  assert.equal(r.samples.length, 40);
  assert.equal(r.completed + r.abandoned + r.unfinished, 20000);
  assert.ok([r.rate, r.waitP90, r.cost, r.range.low, r.range.high].every(Number.isFinite));
  assert.ok(r.samples.every((s) => s.completed + s.abandoned + s.unfinished === 20000));
});

test("zero completions cannot become recommended even under fully lenient goals", () => {
  const c = generateCandidates({ ...space, staff: 1, booths: 1 })[0];
  const b = runBatch([c], {
    visitors: 1, replications: 2, minCompletionRate: 0,
    minConsent: 0, maxWaitMinutes: 180, budget: 10000000000,
  });
  assert.equal(b.recommendedId, null);
  assert.ok(b.results[0].reasons.includes("체험 완료 인원 없음"));
});
