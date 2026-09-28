import test from "node:test";
import assert from "node:assert/strict";
import {
  generateCandidates,
  runBatch,
  validateAssumptions,
  MODEL_POLICY,
  simulateQueue,
} from "../shared/simulation.mjs";
import {
  makeVenue,
  normalizeSpace,
  createNavigation,
  createCrowd,
  stepCrowd,
} from "../shared/scene.mjs";

const candidates = generateCandidates({
  width: 24,
  depth: 18,
  height: 3.4,
  family: "gallery",
  booths: 3,
  staff: 6,
});
const batch = runBatch(candidates, { replications: 4 });

const queuePerson = (arrival, overrides = {}) => ({
  arrival,
  service: 60,
  patience: 1,
  walkingSpeed: 1,
  consent: 1,
  preference: 0,
  ...overrides,
});
const singleLane = {
  inaccessible: false,
  capacity: 1,
  checkInStaff: 1,
  intakeMeters: 0,
  zones: [{ capacity: 1, travelMeters: 0 }],
};
const closingAssumptions = { durationMinutes: 30, visitors: 2, consentRate: 0 };

test("post-close abandonment deadline stays unfinished and waiting at close", () => {
  const result = simulateQueue(
    closingAssumptions,
    [queuePerson(0), queuePerson(29)],
    singleLane,
  );
  assert.equal(result.completed, 0);
  assert.equal(result.abandoned, 0);
  assert.equal(result.unfinished, 2);
  assert.equal(result.waitingAtClose, 1);
  assert.equal(result.timeline.at(-1).waiting, 1);
});
test("pre-close abandonment still counts as abandoned, not waiting", () => {
  const result = simulateQueue(
    closingAssumptions,
    [queuePerson(0), queuePerson(28)],
    singleLane,
  );
  assert.equal(result.abandoned, 1);
  assert.equal(result.unfinished, 1);
  assert.equal(result.waitingAtClose, 0);
});
test("service queue whose next available slot is after close remains waiting", () => {
  const result = simulateQueue(
    closingAssumptions,
    [queuePerson(0, { patience: 180 }), queuePerson(29, { patience: 180 })],
    singleLane,
  );
  assert.equal(result.abandoned, 0);
  assert.equal(result.unfinished, 2);
  assert.equal(result.waitingAtClose, 1);
});
test("check-in queue preserves post-close deadlines and excludes in-service people", () => {
  const result = simulateQueue(
    { ...closingAssumptions, visitors: 3 },
    [
      queuePerson(29.7),
      queuePerson(29.71, { patience: 0.1 }),
      queuePerson(29.95, { patience: 0.2 }),
    ],
    singleLane,
  );
  assert.equal(result.abandoned, 1);
  assert.equal(result.unfinished, 2);
  assert.equal(result.waitingAtClose, 1);
  // The first intake is in progress, the second abandons before close, and
  // the third is still waiting for the occupied lane at minute 30.
});
test("unfinished intake travel is not incorrectly recorded as queue abandonment", () => {
  const result = simulateQueue(
    { ...closingAssumptions, visitors: 1 },
    [queuePerson(29)],
    { ...singleLane, intakeMeters: 120 },
  );
  assert.equal(result.abandoned, 0);
  assert.equal(result.unfinished, 1);
  assert.equal(result.waitingAtClose, 0);
});

test("16 unique alternatives: four families by four strategies", () => {
  assert.equal(candidates.length, 16);
  assert.equal(new Set(candidates.map((c) => c.id)).size, 16);
  for (const family of ["gallery", "courtyard", "forum", "festival"]) {
    const subset = candidates.filter((c) => c.family === family);
    assert.equal(subset.length, 4);
    assert.deepEqual(
      subset.map((c) => c.variant),
      [0, 1, 2, 3],
    );
  }
});
test("family and variant selected through the agent affect the baseline", () => {
  const cs = generateCandidates({
    family: "outdoor",
    variant: 3,
    booths: 2,
    staff: 5,
  });
  assert.equal(cs[0].family, "festival");
  assert.equal(cs[0].variant, 3);
  assert.equal(cs[0].booths, 2);
  assert.equal(cs[0].staff, 4);
  assert.equal(cs.length, 16);
});
test("one-person input remains one person; an unstaffed experience is never recommended", () => {
  const cs = generateCandidates({ staff: 1, booths: 1 });
  assert.equal(cs[0].staff, 1);
  assert.equal(cs[3].staff, 1);
  const result = runBatch([cs[0]], {
    visitors: 10,
    replications: 2,
    minCompletionRate: 0,
    minConsent: 0,
    maxWaitMinutes: 180,
    budget: 10000000000,
  });
  const baseline = result.results[0];
  assert.equal(baseline.geometry.checkInStaff, 1);
  assert.equal(baseline.geometry.serviceStaff, 0);
  assert.equal(baseline.geometry.serviceStations, 0);
  assert.equal(baseline.completed, 0);
  assert.equal(baseline.abandoned, 0);
  assert.equal(baseline.unfinished, 10);
  assert.equal(baseline.feasible, false);
  assert.ok(baseline.reasons.includes("체험 운영 인력 부족"));
  assert.equal(result.recommendedId, null);
});
test("input objects are never mutated", () => {
  const space = {
    width: 30,
    depth: 22,
    height: 4,
    family: "gallery",
    booths: 4,
    staff: 7,
  };
  const before = structuredClone(space);
  generateCandidates(space);
  assert.deepEqual(space, before);
});
test("same seed and assumptions produce byte-for-byte deterministic results", () => {
  assert.deepEqual(runBatch(candidates, { replications: 4 }), batch);
  assert.deepEqual(
    runBatch(candidates.slice().reverse(), { replications: 4 })
      .results.slice()
      .reverse(),
    batch.results,
  );
});
test("paired replication seeds are identical for every candidate", () => {
  const seeds = batch.results[0].samples.map((s) => s.seed);
  for (const result of batch.results)
    assert.deepEqual(
      result.samples.map((s) => s.seed),
      seeds,
    );
  assert.equal(batch.pairedSamples, true);
  assert.match(batch.policy.geometry, /not alternative operations inside one surveyed fixed building/);
});
test("different seeds change computed samples", () => {
  const changed = runBatch([candidates[2]], { replications: 4, seed: 93 });
  assert.notDeepEqual(changed.results[0].samples, batch.results[2].samples);
});
test("higher service time changes throughput, queue wait and abandonment", () => {
  const changed = runBatch([candidates[2]], {
    replications: 4,
    serviceMinutes: 12,
  });
  assert.ok(changed.results[0].completed < batch.results[2].completed);
  assert.ok(changed.results[0].abandoned > batch.results[2].abandoned);
});
test("arrival pattern changes actual event outcomes", () => {
  const changed = runBatch([candidates[1]], {
    replications: 4,
    arrivalPeak: 4,
  });
  assert.notDeepEqual(changed.results[0].samples, batch.results[1].samples);
});
test("shorter patience changes abandonment instead of manufacturing KPI fixtures", () => {
  const changed = runBatch([candidates[1]], {
    replications: 4,
    patienceMinutes: 2,
  });
  assert.ok(changed.results[0].abandoned > batch.results[1].abandoned);
});
test("dimensions scale scene geometry, camera contract and navigation bounds", () => {
  const c = generateCandidates({ width: 36, depth: 27, height: 4.8 })[0],
    v = c.scene;
  assert.equal(v.width, 36);
  assert.equal(v.depth, 27);
  assert.equal(v.height, 4.8);
  assert.equal(v.area, 972);
  assert.equal(v.items.find((p) => p.type === "wall").w, 36);
  assert.ok(v.items.some((p) => p.x > 24));
  const nav = createNavigation(v);
  assert.equal(nav.free(36.1, 12), false);
  assert.equal(nav.free(10, 27.1), false);
});
test("actual geometric paths and floor area change travel and cost", () => {
  const bigger = runBatch(generateCandidates({ width: 36, depth: 27 }), {
    replications: 4,
  });
  assert.notEqual(
    bigger.results[2].geometry.travelMeters,
    batch.results[2].geometry.travelMeters,
  );
  assert.ok(bigger.results[2].cost > batch.results[2].cost);
  assert.notEqual(
    bigger.results[2].samples[0].travelMinutes,
    batch.results[2].samples[0].travelMinutes,
  );
});
test("height updates architectural model and production cost", () => {
  const c = generateCandidates({ height: 5 })[0];
  assert.equal(c.scene.height, 5);
  assert.equal(c.scene.items.find((p) => p.type === "wall").h, 5);
  assert.ok(
    runBatch([c], { replications: 2 }).results[0].cost > batch.results[0].cost,
  );
});
test("default parameters have feasible candidate(s) from calculated outputs", () => {
  assert.ok(batch.recommendedId);
  assert.ok(
    batch.results.find((r) => r.candidateId === batch.recommendedId).feasible,
  );
  assert.ok(batch.results.some((r) => !r.feasible));
});
test("each replicate conserves visitors and bounds all metrics", () => {
  for (const r of batch.results)
    for (const s of r.samples) {
      assert.equal(s.completed + s.abandoned + s.unfinished, 1200);
      assert.ok(s.consents >= 0 && s.consents <= s.completed);
      for (const key of [
        "completed",
        "rate",
        "waitP90",
        "consents",
        "cost",
        "travelMinutes",
      ])
        assert.ok(Number.isFinite(s[key]) && s[key] >= 0);
      assert.ok(s.rate <= 100);
    }
});
test("range is calculated from replications, not a fixed ± interval", () => {
  for (const r of batch.results) {
    assert.ok(r.range.low <= r.range.high);
    assert.ok(r.range.low >= Math.min(...r.samples.map((s) => s.rate)) - 0.011);
    assert.ok(
      r.range.high <= Math.max(...r.samples.map((s) => s.rate)) + 0.011,
    );
    assert.equal(r.samples.length, 4);
  }
  assert.match(batch.rangeMeaning, /not a confidence interval/);
});
test("timeline is monotone, ends at calculated completions and respects horizon", () => {
  for (const r of batch.results) {
    assert.equal(r.timeline[0].minute, 0);
    assert.equal(r.timeline.at(-1).minute, 360);
    assert.equal(r.timeline.at(-1).completed, r.completed);
    for (let i = 1; i < r.timeline.length; i++) {
      assert.ok(r.timeline[i].completed >= r.timeline[i - 1].completed);
      assert.ok(r.timeline[i].waiting >= 0);
    }
  }
});
test("budget constraint, in KRW, blocks every over-budget candidate", () => {
  const b = runBatch(candidates, { replications: 2, budget: 1 });
  assert.equal(b.recommendedId, null);
  for (const r of b.results) {
    assert.equal(r.feasible, false);
    assert.ok(r.reasons.includes("예산 초과"));
  }
});
test("zero consent scenario cannot pass a positive consent constraint", () => {
  const b = runBatch(candidates, {
    replications: 2,
    consentRate: 0,
    minConsent: 1,
  });
  for (const r of b.results) {
    assert.equal(r.consents, 0);
    assert.equal(r.feasible, false);
    assert.ok(r.reasons.includes("명시 동의 목표 미달"));
  }
});
test("cost totals equal integer-KRW cost components", () => {
  for (const r of batch.results) {
    assert.equal(
      r.cost,
      Object.values(r.costBreakdown).reduce((a, b) => a + b, 0),
    );
    assert.ok(Number.isInteger(r.cost));
  }
});
test("staff-limited service capacities are modeled", () => {
  assert.ok(
    batch.results[3].geometry.serviceStations <
      batch.results[2].geometry.serviceStations,
  );
  assert.equal(MODEL_POLICY.boothParallelCapacity, 3);
  assert.equal(MODEL_POLICY.participantsPerFacilitator, 2);
});
test("invalid numeric inputs fail rather than silently clamp", () => {
  for (const a of [
    { visitors: NaN },
    { replications: 1 },
    { consentRate: 1.2 },
    { seed: -1 },
    { durationMinutes: 0 },
    { serviceMinutes: Infinity },
  ])
    assert.throws(() => validateAssumptions(a), RangeError);
  for (const space of [
    { width: 0 },
    { height: "3" },
    { booths: 2.5 },
    { family: "unknown" },
  ])
    assert.throws(() => normalizeSpace(space), RangeError);
});
test("unsupported candidate arrays fail explicitly", () => {
  assert.throws(() => runBatch([], {}));
  assert.throws(() => runBatch([candidates[0], candidates[0]], {}));
  assert.throws(() =>
    runBatch([{ ...candidates[0], family: "arbitrary" }], {}),
  );
});
test("unreachable small layouts are blocked, never reported feasible", () => {
  const b = runBatch(generateCandidates({ width: 8, depth: 8 }), {
    replications: 2,
  });
  for (const r of b.results.filter((r) => !r.geometry.reachable)) {
    assert.equal(r.feasible, false);
    assert.match(r.reasons[0], /접근/);
  }
});

for (const c of candidates)
  test(`${c.id}: rendered geometry and navigation agree; 24 articulated agents remain valid`, () => {
    const venue = makeVenue(c),
      nav = createNavigation(venue);
    assert.equal(venue.actualBooths, c.booths);
    assert.deepEqual(
      venue.items
        .filter((p) => p.type === "booth")
        .map((p) => p.id)
        .sort(),
      Array.from(
        { length: c.booths },
        (_, i) => `${c.id}-booth-${i + 1}`,
      ).sort(),
    );
    for (const s of venue.stops.filter((s) => s.zone)) {
      const route = nav.path(venue.entrance, [s.x, s.z]);
      assert.ok(route.length > 1);
      for (let i = 1; i < route.length; i++)
        assert.ok(nav.segmentFree(route[i - 1], route[i]));
    }
    const crowd = createCrowd(venue, 24);
    assert.equal(crowd.agents.length, 24);
    for (let i = 0; i < 120; i++) stepCrowd(crowd, 1 / 30);
    for (const a of crowd.agents) {
      assert.ok(nav.free(a.x, a.z));
      assert.ok(Number.isFinite(a.heading));
      assert.ok(a.speed >= 0 && a.speed < 2);
      assert.ok(a.walkBlend >= 0 && a.walkBlend <= 1);
    }
  });
