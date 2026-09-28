import {
  normalizeSpace,
  makeVenue,
  createNavigation,
  families,
} from "./scene.mjs";

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  visitors: 1200,
  durationMinutes: 360,
  serviceMinutes: 4,
  arrivalPeak: 1.5,
  patienceMinutes: 20,
  consentRate: 0.55,
  budget: 60000000,
  minCompletionRate: 40,
  maxWaitMinutes: 12,
  minConsent: 240,
  seed: 42,
  replications: 12,
});
export const MODEL_POLICY = Object.freeze({
  boothParallelCapacity: 3,
  participantsPerFacilitator: 2,
  checkInMinutes: 0.35,
  checkInStaffRatio: 0.2,
  stage: "one experience per visitor",
  calibration: "uncalibrated",
  geometry:
    "Four parametric venue templates share entered dimensions, visitor assumptions and paired seeds, but change walls, fixtures and circulation. They are not alternative operations inside one surveyed fixed building.",
  costBasis:
    "fixed documented engineering cost assumptions; not editable provider quotes",
  costRates: {
    venuePerM2: 30000,
    productionPerM2: 19000,
    booth: 1800000,
    staffHourly: 25000,
    staffingSetupHours: 2,
    fixed: 4500000,
    contingencyRate: 0.1,
    referenceHeight: 3.4,
    familyFactors: { gallery: 1, courtyard: 1.04, forum: 1.3, festival: 0.88 },
  },
  queue:
    "FCFS check-in and zone service; shortest projected finish from booked service lanes at decision time (in-transit visitors are not reserved); no calibrated pedestrian congestion",
});
const strategyNames = ["기준 구성", "동선 분산", "처리량 확대", "비용 효율"];

export function validateAssumptions(input = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...input };
  const rules = [
    ["visitors", 1, 20000, true],
    ["durationMinutes", 30, 1440, false],
    ["serviceMinutes", 0.2, 60, false],
    ["arrivalPeak", 0.1, 8, false],
    ["patienceMinutes", 0.1, 180, false],
    ["consentRate", 0, 1, false],
    ["budget", 0, 10000000000, true],
    ["minCompletionRate", 0, 100, false],
    ["maxWaitMinutes", 0, 180, false],
    ["minConsent", 0, 20000, true],
    ["seed", 0, 4294967295, true],
    ["replications", 2, 40, true],
  ];
  for (const [key, min, max, integer] of rules)
    if (
      typeof a[key] !== "number" ||
      !Number.isFinite(a[key]) ||
      a[key] < min ||
      a[key] > max ||
      (integer && !Number.isInteger(a[key]))
    )
      throw new RangeError(
        `${key}: ${min}–${max} 범위의 ${integer ? "정수" : "숫자"}가 필요합니다.`,
      );
  return a;
}

export function generateCandidates(input) {
  const base = normalizeSpace(input);
  const familyOrder = [
    ...families.filter((f) => f.id === base.family),
    ...families.filter((f) => f.id !== base.family),
  ];
  const variants = [
    base.variant,
    ...[0, 1, 2, 3].filter((v) => v !== base.variant),
  ];
  return familyOrder.flatMap((family, f) =>
    variants.map((variant, v) => {
      const id = String.fromCharCode(65 + f * 4 + v);
      const booths = Math.min(
        12,
        Math.max(1, base.booths + [0, 1, 3, 0][variant]),
      );
      const staff = Math.min(
        40,
        Math.max(1, base.staff + [0, 2, 6, -1][variant]),
      );
      const space = { ...base, family: family.id, variant, booths, staff };
      const candidate = {
        id,
        name: `${family.name} · ${strategyNames[variant]}`,
        family: family.id,
        familyName: family.name,
        variant,
        space,
        booths,
        staff,
        sceneId: `SCENE-${id}`,
      };
      return { ...candidate, scene: makeVenue(candidate) };
    }),
  );
}

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function arrivalsFor(a, replication) {
  const rng = random((a.seed + Math.imul(replication + 1, 0x9e3779b9)) >>> 0);
  const weights = [1, 1.2, a.arrivalPeak, a.arrivalPeak, 1.1, 0.6],
    sum = weights.reduce((s, v) => s + v, 0);
  return Array.from({ length: a.visitors }, (_, id) => {
    let weighted = rng() * sum,
      bucket = 0;
    while (bucket < 5 && weighted > weights[bucket])
      weighted -= weights[bucket++];
    const arrival =
      ((bucket + weighted / weights[bucket]) * a.durationMinutes) / 6;
    // Common random numbers are generated once per visitor/replicate, then reused unchanged by all alternatives.
    const serviceFactor = 0.55 + (rng() + rng() + rng()) * 0.3;
    return {
      id,
      arrival,
      service: a.serviceMinutes * serviceFactor,
      patience: a.patienceMinutes * (0.8 + 0.4 * rng()),
      walkingSpeed: 0.9 + 0.5 * rng(),
      consent: rng(),
      preference: rng(),
    };
  }).sort((x, y) => x.arrival - y.arrival || x.id - y.id);
}
function percentile(values, p) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y),
    x = (a.length - 1) * p,
    i = Math.floor(x);
  return a[i] + (a[Math.min(i + 1, a.length - 1)] - a[i]) * (x - i);
}
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const length = (path) =>
  path
    .slice(1)
    .reduce(
      (sum, p, i) => sum + Math.hypot(p[0] - path[i][0], p[1] - path[i][1]),
      0,
    );

function prepareCandidate(c, a) {
  const scene = makeVenue(c),
    nav = createNavigation(scene);
  const reception = scene.stops.find((s) => s.activity === "접수");
  const entrance = nav.nearestPoint(scene.entrance);
  const desk = nav.nearestPoint([reception.x, reception.z]);
  const intakePath = nav.path(entrance, desk);
  const zones = scene.stops
    .filter((s) => s.zone)
    .sort((x, y) => x.zone - y.zone)
    .map((s) => {
      const target = nav.nearestPoint([s.x, s.z]),
        route = nav.path(desk, target),
        exit = nav.path(target, entrance);
      return {
        id: s.zone,
        route,
        exit,
        travelMeters: route.length ? length(route) : Infinity,
        exitMeters: exit.length ? length(exit) : Infinity,
      };
    });
  const inaccessible =
    scene.actualBooths !== c.booths ||
    !intakePath.length ||
    zones.some((z) => !Number.isFinite(z.travelMeters + z.exitMeters));
  const checkInStaff = Math.max(
    1,
    Math.round(c.staff * MODEL_POLICY.checkInStaffRatio),
  );
  const serviceStaff = Math.max(0, c.staff - checkInStaff);
  const capacity = Math.min(
    zones.length * MODEL_POLICY.boothParallelCapacity,
    serviceStaff * MODEL_POLICY.participantsPerFacilitator,
  );
  zones.forEach((z, i) => {
    z.capacity =
      Math.floor(capacity / zones.length) +
      (i < capacity % zones.length ? 1 : 0);
  });
  const area = c.space.width * c.space.depth;
  const rates = MODEL_POLICY.costRates;
  const familyFactor = rates.familyFactors[c.family];
  const venueCost = Math.round(area * rates.venuePerM2 * familyFactor),
    production = Math.round(
      (area * rates.productionPerM2 * familyFactor * c.space.height) / rates.referenceHeight,
    ),
    equipment = c.booths * rates.booth;
  const staffCost = Math.round(
      c.staff * (a.durationMinutes / 60 + rates.staffingSetupHours) * rates.staffHourly,
    ),
    fixed = rates.fixed;
  const subtotal = venueCost + production + equipment + staffCost + fixed;
  const contingency = Math.round(subtotal * rates.contingencyRate),
    cost = subtotal + contingency;
  return {
    scene,
    zones,
    checkInStaff,
    capacity,
    intakeMeters: length(intakePath),
    inaccessible,
    cost,
    costBreakdown: {
      venue: venueCost,
      production,
      equipment,
      staff: staffCost,
      fixed,
      contingency,
    },
    travelMeters: round(
      zones.reduce(
        (s, z) => s + (Number.isFinite(z.travelMeters) ? z.travelMeters : 0),
        0,
      ) / Math.max(1, zones.length),
    ),
  };
}

// A tiny stable priority queue is sufficient for local-pilot bounded event counts.
class EventQueue {
  items = [];
  order = 0;
  push(event) {
    const a = this.items;
    event.order = this.order++;
    a.push(event);
    let i = a.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (!this.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  before(a, b) {
    return a.time < b.time || (a.time === b.time && a.order < b.order);
  }
  pop() {
    const a = this.items;
    if (!a.length) return null;
    const first = a[0],
      last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      while (true) {
        let j = i,
          l = i * 2 + 1,
          r = l + 1;
        if (l < a.length && this.before(a[l], a[j])) j = l;
        if (r < a.length && this.before(a[r], a[j])) j = r;
        if (j === i) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    }
    return first;
  }
}

// Deterministic single-replication kernel. runBatch validates the external inputs.
export function simulateQueue(a, people, p) {
  if (!Number.isInteger(a?.visitors) || a.visitors < 0 ||
    !Array.isArray(people) || people.length !== a.visitors)
    throw new RangeError("방문자 수와 시뮬레이션 개별 입력 수가 일치해야 합니다.");
  if (p.inaccessible || !p.capacity)
    return {
      completed: 0,
      rate: 0,
      waitP90: 0,
      consents: 0,
      // An impossible layout or unstaffed experience is not an observed
      // patience-based abandonment. No service could begin in this scenario.
      abandoned: 0,
      unfinished: a.visitors,
      waitingAtClose: 0,
      timeline: Array.from({ length: 25 }, (_, i) => ({
        minute: (a.durationMinutes * i) / 24,
        completed: 0,
        waiting: 0,
      })),
      meanWait: 0,
      travelMinutes: 0,
    };
  const events = new EventQueue(),
    entry = Array(p.checkInStaff).fill(0),
    queues = p.zones.map((z) => Array(z.capacity).fill(0));
  const completions = [],
    waits = [],
    waitIntervals = [];
  let consents = 0,
    abandoned = 0,
    unfinished = 0,
    travelTotal = 0;
  for (const person of people)
    events.push({ kind: "arrival", time: person.arrival, person });
  let event;
  while ((event = events.pop())) {
    const v = event.person;
    if (event.time >= a.durationMinutes) {
      unfinished++;
      continue;
    }
    if (event.kind === "arrival") {
      const at = event.time + p.intakeMeters / v.walkingSpeed / 60;
      if (at >= a.durationMinutes) {
        unfinished++;
        continue;
      }
      let lane = 0;
      for (let i = 1; i < entry.length; i++)
        if (entry[i] < entry[lane]) lane = i;
      const begin = Math.max(at, entry[lane]),
        wait = begin - at;
      if (wait > v.patience) {
        const departure = at + v.patience;
        if (departure <= a.durationMinutes) abandoned++;
        else unfinished++;
        waitIntervals.push([at, departure]);
        continue;
      }
      if (begin + MODEL_POLICY.checkInMinutes > a.durationMinutes) {
        unfinished++;
        // An intake already started still occupies its lane at closing time.
        if (begin < a.durationMinutes)
          entry[lane] = begin + MODEL_POLICY.checkInMinutes;
        if (wait > 0) waitIntervals.push([at, begin]);
        continue;
      }
      entry[lane] = begin + MODEL_POLICY.checkInMinutes;
      if (wait > 0) waitIntervals.push([at, begin]);
      // Route choice sees only already-booked work. It does not see future arrivals.
      let best = null;
      p.zones.forEach((z, i) => {
        if (!queues[i].length) return;
        const ready = entry[lane] + z.travelMeters / v.walkingSpeed / 60;
        const finish = Math.max(ready, Math.min(...queues[i])) + v.service;
        const score =
          finish + Math.abs(i / (p.zones.length || 1) - v.preference) * 0.04;
        if (!best || score < best.score)
          best = {
            zone: i,
            ready,
            score,
            travel: z.travelMeters / v.walkingSpeed / 60,
          };
      });
      travelTotal += best.travel;
      events.push({
        kind: "service",
        time: best.ready,
        person: v,
        zone: best.zone,
        priorWait: wait,
      });
    } else {
      const servers = queues[event.zone];
      let lane = 0;
      for (let i = 1; i < servers.length; i++)
        if (servers[i] < servers[lane]) lane = i;
      const begin = Math.max(event.time, servers[lane]),
        wait = begin - event.time;
      const remainingPatience = Math.max(0, v.patience - event.priorWait);
      if (wait > remainingPatience) {
        const departure = event.time + remainingPatience;
        if (departure <= a.durationMinutes) abandoned++;
        else unfinished++;
        waitIntervals.push([event.time, departure]);
        continue;
      }
      const finish = begin + v.service;
      if (begin > a.durationMinutes) {
        unfinished++;
        waitIntervals.push([event.time, begin]);
        continue;
      }
      servers[lane] = finish;
      if (wait > 0) waitIntervals.push([event.time, begin]);
      if (finish > a.durationMinutes) {
        unfinished++;
        continue;
      }
      completions.push(finish);
      waits.push(wait + event.priorWait);
      if (v.consent < a.consentRate) consents++;
    }
  }
  completions.sort((x, y) => x - y);
  const timeline = Array.from({ length: 25 }, (_, i) => {
    const minute = (a.durationMinutes * i) / 24;
    return {
      minute: round(minute),
      completed: completions.filter((t) => t <= minute).length,
      waiting: waitIntervals.filter(
        ([start, end]) => start <= minute && end > minute,
      ).length,
    };
  });
  return {
    completed: completions.length,
    rate: a.visitors ? (completions.length / a.visitors) * 100 : 0,
    waitP90: percentile(waits, 0.9),
    consents,
    abandoned,
    unfinished,
    waitingAtClose: timeline.at(-1).waiting,
    timeline,
    meanWait: waits.reduce((s, v) => s + v, 0) / Math.max(1, waits.length),
    travelMinutes: a.visitors ? travelTotal / a.visitors : 0,
  };
}

export function runBatch(candidates, input = {}) {
  const a = validateAssumptions(input);
  if (
    !Array.isArray(candidates) ||
    !candidates.length ||
    candidates.length > 16
  )
    throw new RangeError("1–16개 후보가 필요합니다.");
  const baseline = candidates[0]?.space;
  if (!baseline || typeof baseline !== "object")
    throw new RangeError("후보 공간 입력이 필요합니다.");
  const requiredSpaceFields = [
    "width", "depth", "height", "family", "variant", "booths", "staff",
  ];
  const footprint = normalizeSpace(baseline);
  for (const c of candidates) {
    if (!c || typeof c !== "object" || !c.space || typeof c.space !== "object")
      throw new RangeError("후보 공간 입력이 필요합니다.");
    if (requiredSpaceFields.some((key) => !Object.hasOwn(c.space, key)))
      throw new RangeError("후보의 공간 치수·유형·부스·인력이 필요합니다.");
    const s = normalizeSpace(c.space);
    if (typeof c.id !== "string" || !c.id.trim() ||
      !families.some((f) => f.id === c.family) ||
      !Number.isInteger(c.variant) || c.variant < 0 || c.variant > 3 ||
      !Number.isInteger(c.booths) || c.booths < 1 || c.booths > 12 ||
      !Number.isInteger(c.staff) || c.staff < 1 || c.staff > 40 ||
      s.family !== c.family || s.variant !== c.variant ||
      s.booths !== c.booths || s.staff !== c.staff ||
      s.width !== footprint.width || s.depth !== footprint.depth ||
      s.height !== footprint.height)
      throw new RangeError("후보의 공간 치수·유형·부스·인력 계약이 일치해야 합니다.");
  }
  if (new Set(candidates.map((c) => c.id)).size !== candidates.length)
    throw new RangeError("후보 ID가 중복되었습니다.");
  const pool = Array.from({ length: a.replications }, (_, i) =>
    arrivalsFor(a, i),
  );
  const results = candidates.map((c) => {
    const prep = prepareCandidate(c, a);
    const samples = pool.map((people, i) => ({
      replication: i + 1,
      seed: (a.seed + Math.imul(i + 1, 0x9e3779b9)) >>> 0,
      ...simulateQueue(a, people, prep),
      cost: prep.cost,
    }));
    const mean = (key) =>
      samples.reduce((s, v) => s + v[key], 0) / samples.length;
    const completed = Math.round(mean("completed"));
    const abandoned = Math.min(a.visitors - completed, Math.round(mean("abandoned")));
    const result = {
      candidateId: c.id,
      completed,
      rate: round(mean("rate")),
      waitP90: round(mean("waitP90")),
      cost: prep.cost,
      consents: Math.round(mean("consents")),
      abandoned,
      unfinished: a.visitors - completed - abandoned,
      range: {
        low: round(
          percentile(
            samples.map((s) => s.rate),
            0.1,
          ),
        ),
        high: round(
          percentile(
            samples.map((s) => s.rate),
            0.9,
          ),
        ),
      },
      feasible: false,
      reasons: [],
      timeline: samples[0].timeline.map((t, i) => ({
        minute: t.minute,
        completed: Math.round(
          samples.reduce((sum, s) => sum + s.timeline[i].completed, 0) /
            samples.length,
        ),
        waiting: Math.round(
          samples.reduce((sum, s) => sum + s.timeline[i].waiting, 0) /
            samples.length,
        ),
      })),
      samples: samples.map(({ timeline, ...s }) => ({
        ...s,
        rate: round(s.rate),
        waitP90: round(s.waitP90),
        meanWait: round(s.meanWait),
        travelMinutes: round(s.travelMinutes),
      })),
      geometry: {
        width: prep.scene.width,
        depth: prep.scene.depth,
        height: prep.scene.height,
        area: prep.scene.area,
        reachable: !prep.inaccessible,
        travelMeters: prep.travelMeters,
        modeledBooths: prep.scene.actualBooths,
        serviceStations: prep.capacity,
        checkInStaff: prep.checkInStaff,
        serviceStaff: c.staff - prep.checkInStaff,
        zoneCapacities: prep.zones.map((z) => ({
          zone: z.id,
          capacity: z.capacity,
        })),
      },
      costBreakdown: prep.costBreakdown,
    };
    if (prep.inaccessible)
      result.reasons.push("공간 내 체험 지점 접근 불가 또는 부스 배치 부족");
    if (!prep.capacity) result.reasons.push("체험 운영 인력 부족");
    if (!completed) result.reasons.push("체험 완료 인원 없음");
    if (result.cost > a.budget) result.reasons.push("예산 초과");
    if (mean("rate") < a.minCompletionRate)
      result.reasons.push("완료율 목표 미달");
    if (mean("waitP90") > a.maxWaitMinutes)
      result.reasons.push("P90 대기 한도 초과");
    if (mean("consents") < a.minConsent)
      result.reasons.push("명시 동의 목표 미달");
    result.feasible = result.reasons.length === 0;
    return result;
  });
  const recommended = [...results]
    .filter((r) => r.feasible)
    .sort((x, y) => y.completed - x.completed || x.cost - y.cost)[0];
  return {
    method: "paired-seeded-discrete-event-v1 (uncalibrated)",
    seed: a.seed,
    replications: a.replications,
    results,
    recommendedId: recommended?.candidateId ?? null,
    policy: MODEL_POLICY,
    assumptions: { ...a },
    rangeMeaning:
      "10th–90th percentile of replicated completion rates; not a confidence interval or forecast guarantee",
    waitMeaning:
      "mean of per-replication P90 total queue waits among completed visitors; abandonments reported separately",
    consentMeaning:
      "Bernoulli scenario draw among completers, not permission to contact any real person",
    pairedSamples: true,
  };
}
