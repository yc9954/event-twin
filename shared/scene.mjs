// Adapted from this project's original v12 geometry/motion, not external editor code.
// Metres, Y-up. Parameterized concepts, not surveyed/photo-reconstructed buildings.
export const WIDTH = 24,
  DEPTH = 18;
export const families = [
  { id: "gallery", name: "복합 갤러리" },
  { id: "courtyard", name: "중정 캠퍼스" },
  { id: "forum", name: "복층 포럼" },
  { id: "festival", name: "야외 페스티벌" },
];
export function normalizeSpace(input = {}) {
  const defaults = {
    width: 24,
    depth: 18,
    height: 3.4,
    family: "gallery",
    variant: 0,
    booths: 3,
    staff: 6,
    confirmed: false,
  };
  const s = { ...defaults, ...input };
  s.family =
    { outdoor: "festival", atrium: "forum", pavilion: "courtyard" }[s.family] ||
    s.family;
  for (const [key, min, max] of [
    ["width", 8, 100],
    ["depth", 8, 100],
    ["height", 2, 12],
    ["booths", 1, 12],
    ["staff", 1, 40],
    ["variant", 0, 3],
  ]) {
    if (
      typeof s[key] !== "number" ||
      !Number.isFinite(s[key]) ||
      s[key] < min ||
      s[key] > max ||
      (["booths", "staff", "variant"].includes(key) &&
        !Number.isInteger(s[key]))
    )
      throw new RangeError(
        `${key}: ${min}–${max} 범위의 ${["booths", "staff", "variant"].includes(key) ? "정수" : "숫자"}가 필요합니다.`,
      );
  }
  if (!families.some((f) => f.id === s.family))
    throw new RangeError("지원하지 않는 공간 유형입니다.");
  return s;
}
export function makeVenue(candidate) {
  const space = normalizeSpace({
    ...(candidate.space || candidate),
    family: candidate.family || candidate.space?.family || "gallery",
    variant: candidate.variant ?? candidate.space?.variant ?? 0,
    booths: candidate.booths ?? candidate.space?.booths ?? 3,
    staff: candidate.staff ?? candidate.space?.staff ?? 6,
  });
  const family = space.family;
  const variant = space.variant;
  const items = [],
    obstacles = [],
    stops = [];
  function block(x, z, w, d, h = 3.4, type = "wall", y = 0, solid = true) {
    items.push({ type, x, z, w, d, h, y });
    if (solid && y < 1.7)
      obstacles.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
  }
  function fixture(type, x, z, rotation = 0) {
    items.push({ type, x, z, rotation });
    const sizes = {
      booth: [2.2, 1.35],
      lounge: [4.2, 3.3],
      tree: [1, 1],
      entry: [1.6, 0.8],
      pedestal: [1, 1],
    };
    if (sizes[type]) {
      const [w, d] = sizes[type];
      obstacles.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2]);
    }
  }
  if (family === "gallery") {
    block(12, 0.15, 24, 0.3);
    block(0.15, 9, 0.3, 18);
    block(23.85, 5.2, 0.15, 10.4, 3.1, "glass");
    for (const x of [8, 16]) block(x, 3.3, 0.2, 6.2);
    for (const x of [3.4, 11.4, 19.4]) {
      block(x, 7, 5.9, 0.18, 1.1); // cutaway partitions leave real doorways
      block(x, 0.37, 4.7, 0.08, 2.3, "relief", 0.6, false);
    }
    block(16.8, 14, 0.2, 4.2, 1.2);
    fixture("lounge", 20.5, 14);
    fixture("tree", 1.1, 15.9);
  } else if (family === "courtyard") {
    for (const [x, w, d] of [
      [3.2, 5.8, 8],
      [12, 7.8, 5.4],
      [20.8, 5.8, 8],
    ]) {
      block(x, 0.2, w, 0.2);
      block(x - w / 2, d / 2, 0.18, d);
      block(x + w / 2, d / 2, 0.12, d, 2.8, "glass");
      block(x, 0.7, w + 0.2, 1.1, 0.18, "roof", 3.5, false);
      block(x - w / 2, d - 0.3, 0.24, 0.24, 3.5);
      block(x + w / 2, d - 0.3, 0.24, 0.24, 3.5);
    }
    block(12, 9, 5.4, 3.4, 0.2, "garden");
    fixture("tree", 10.7, 8.6);
    fixture("tree", 13.3, 9.3);
    block(12, 12.4, 4.6, 0.7, 0.45, "bench");
    fixture("lounge", 20.5, 14);
  } else if (family === "forum") {
    block(12, 0.15, 24, 0.3, 6.9);
    block(0.15, 9, 0.3, 18, 4.2);
    block(8, 3, 0.2, 5.6, 3.4);
    block(4, 5.9, 5.4, 0.18, 1.2);
    block(17.5, 3.1, 12, 6, 0.22, "mezzanine", 3.55, false);
    for (const x of [12, 23]) block(x, 5.7, 0.28, 0.28, 3.55);
    block(17.4, 6.05, 9.7, 0.06, 1.1, "glass", 3.77, false);
    // Stairs are a reserved circulation volume, not a walk-through obstacle.
    block(22, 9.3, 2.2, 6.5, 3.6, "stairs");
    block(17.6, 2, 7, 0.08, 1.1, "glass", 3.77, false);
    items.push({ type: "upperLounge", x: 17.2, z: 2.2, y: 3.77 });
    fixture("lounge", 4, 13.6);
  } else {
    for (const [x, z] of [
      [3, 3],
      [12, 3],
      [21, 3],
      [3, 10],
      [21, 10],
    ]) {
      block(x, z - 1.5, 4.4, 0.2, 2.6);
      for (const dx of [-2.2, 2.2]) block(x + dx, z, 0.12, 3.2, 2.9);
      block(x, z - 1.1, 4.8, 1, 0.16, "roof", 2.95, false);
    }
    block(12, 9, 5.2, 3, 0.35, "stage");
    block(12, 7.45, 5.2, 0.12, 2.6, "relief");
    for (const x of [7.5, 16.5]) {
      fixture("tree", x, 12);
      block(x, 14, 2.4, 0.6, 0.45, "bench");
    }
    fixture("tree", 1.1, 16.5);
    fixture("tree", 22.9, 16.5);
  }
  let positions =
    family === "gallery"
      ? variant === 0
        ? [
            [3, 10],
            [10.5, 10],
            [19, 3],
          ]
        : variant === 3
          ? [
              [3, 3],
              [11, 3],
              [19, 10],
            ]
          : [
              [3, 3],
              [11, 3],
              [19, 3],
              [11, 11],
              [3, 11],
            ]
      : family === "courtyard"
        ? variant === 0
          ? [
              [3, 11],
              [8, 13.8],
              [20.8, 10],
            ]
          : [
              [3, 3],
              [12, 2.5],
              [20.8, 3],
              [3, 11],
              [20.8, 10],
            ]
        : family === "forum"
          ? variant === 0
            ? [
                [4, 3],
                [11, 11],
                [17, 11],
              ]
            : [
                [4, 3],
                [11, 8.5],
                [17, 8.5],
                [13, 13],
                [17, 13],
              ]
          : variant === 0
            ? [
                [8, 4.3],
                [12, 4.3],
                [16, 4.3],
              ]
            : [
                [3, 3],
                [12, 3],
                [21, 3],
                [3, 10],
                [21, 10],
              ];
  // The template supplies up to five program positions. Larger programs add
  // validated free positions below instead of silently dropping requested booths.
  positions = positions.slice(0, space.booths);
  positions.forEach(([x, z], i) => {
    fixture("booth", x, z);
    items.at(-1).id = `${candidate.id || "SPACE"}-booth-${i + 1}`;
    stops.push({ x, z: z + 1.55, activity: "체험", zone: i + 1 });
  });
  fixture("entry", 10, 16.4);
  fixture("entry", variant === 1 ? 15 : 12.2, 16.4);
  stops.push(
    { x: 8, z: 16.4, activity: "접수" },
    { x: 15.8, z: 15.2, activity: "대기" },
  );
  const sx = space.width / WIDTH,
    sz = space.depth / DEPTH,
    sy = space.height / 3.4;
  for (const p of items) {
    p.x *= sx;
    p.z *= sz;
    if (p.w !== undefined) p.w *= sx;
    if (p.d !== undefined) p.d *= sz;
    if (p.h !== undefined) p.h *= sy;
    if (p.y !== undefined) p.y *= sy;
    p.scale = [sx, 1, sz]; // Furniture remains human-height; height controls architecture.
  }
  for (const o of obstacles) {
    o[0] *= sx;
    o[2] *= sx;
    o[1] *= sz;
    o[3] *= sz;
  }
  for (const stop of stops) {
    stop.x *= sx;
    stop.z *= sz;
  }
  const addedWidth = Math.min(2.2 * sx, 2.8),
    addedDepth = Math.min(1.35 * sz, 1.8);
  for (
    let z = space.depth - 4 * sz;
    positions.length < space.booths && z > 2;
    z -= addedDepth + 1.6
  )
    for (
      let x = 2;
      positions.length < space.booths && x < space.width - 2;
      x += addedWidth + 1.5
    ) {
      const a = [
        x - addedWidth / 2,
        z - addedDepth / 2,
        x + addedWidth / 2,
        z + addedDepth / 2,
      ];
      if (
        obstacles.some(
          ([l, t, r, b]) =>
            a[0] < r + 0.6 && a[2] > l - 0.6 && a[1] < b + 1 && a[3] + 1.4 > t,
        )
      )
        continue;
      positions.push([x, z]);
      const zone = positions.length;
      items.push({
        type: "booth",
        x,
        z,
        rotation: 0,
        scale: [addedWidth / 2.2, 1, addedDepth / 1.35],
        id: `${candidate.id || "SPACE"}-booth-${zone}`,
      });
      obstacles.push(a);
      stops.unshift({ x, z: z + addedDepth / 2 + 0.7, activity: "체험", zone });
    }
  const venue = {
    family,
    variant,
    width: space.width,
    depth: space.depth,
    height: space.height,
    area: space.width * space.depth,
    items,
    obstacles,
    stops,
    entrance: [12.6 * sx, 17.15 * sz],
    requestedBooths: space.booths,
    actualBooths: positions.length,
    scale: [sx, sy, sz],
  };
  return venue;
}
export const buildScene = makeVenue;

// A deterministic 0.5 m navigation grid with body clearance; no imported simulator code.
export function createNavigation(venue) {
  const step = 0.5,
    radius = 0.28,
    cols = Math.floor(venue.width / step) + 1,
    rows = Math.floor(venue.depth / step) + 1;
  const free = (x, z) =>
    x >= 0.55 &&
    x <= venue.width - 0.55 &&
    z >= 0.55 &&
    z <= venue.depth - 0.55 &&
    !venue.obstacles.some(
      ([a, b, c, d]) =>
        x > a - radius && x < c + radius && z > b - radius && z < d + radius,
    );
  const cells = new Uint8Array(cols * rows);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < cols; x++)
      cells[z * cols + x] = free(x * step, z * step) ? 1 : 0;
  function nearest(p, visibleFrom = null) {
    const gx = Math.round(p[0] / step), gz = Math.round(p[1] / step);
    const onGrid = gx >= 0 && gz >= 0 && gx < cols && gz < rows &&
      Math.abs(gx * step - p[0]) < 1e-9 && Math.abs(gz * step - p[1]) < 1e-9;
    if (onGrid && cells[gz * cols + gx] &&
      (!visibleFrom || segmentFree(visibleFrom, p))) return gz * cols + gx;
    let best = -1,
      dist = Infinity;
    for (let i = 0; i < cells.length; i++)
      if (cells[i]) {
        const d =
          ((i % cols) * step - p[0]) ** 2 +
          (Math.floor(i / cols) * step - p[1]) ** 2;
        const point = [(i % cols) * step, Math.floor(i / cols) * step];
        if (d < dist && (!visibleFrom || segmentFree(visibleFrom, point))) {
          best = i;
          dist = d;
        }
      }
    return best;
  }
  function segmentFree(a, b) {
    const inside = ([x, z]) =>
      x >= 0.55 && x <= venue.width - 0.55 &&
      z >= 0.55 && z <= venue.depth - 0.55;
    // The allowed outer bounds are convex. Reject endpoints once, then check
    // only obstacles that could intersect this segment's bounding box.
    if (!inside(a) || !inside(b)) return false;
    const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
    const minZ = Math.min(a[1], b[1]), maxZ = Math.max(a[1], b[1]);
    const nearby = venue.obstacles.filter(
      ([left, top, right, bottom]) =>
        maxX > left - radius && minX < right + radius &&
        maxZ > top - radius && minZ < bottom + radius,
    );
    if (!nearby.length) return true;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.12);
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      if (nearby.some(([left, top, right, bottom]) =>
        x > left - radius && x < right + radius &&
        z > top - radius && z < bottom + radius))
        return false;
    }
    return true;
  }
  function path(a, b) {
    const start = nearest(a, free(...a) ? a : null),
      goal = nearest(b),
      queue = [start],
      prev = new Int32Array(cells.length).fill(-1);
    if (start < 0 || goal < 0) return [];
    prev[start] = start;
    const directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    for (let q = 0; q < queue.length && prev[goal] < 0; q++) {
      const i = queue[q],
        x = i % cols,
        z = Math.floor(i / cols);
      for (const [dx, dz] of directions) {
        const nx = x + dx,
          nz = z + dz,
          j = nz * cols + nx;
        if (
          nx < 0 ||
          nz < 0 ||
          nx >= cols ||
          nz >= rows ||
          !cells[j] ||
          prev[j] >= 0
        )
          continue;
        if (dx && dz && (!cells[z * cols + nx] || !cells[nz * cols + x]))
          continue;
        prev[j] = i;
        queue.push(j);
      }
    }
    if (prev[goal] < 0) return [];
    const raw = [];
    for (let i = goal; ; i = prev[i]) {
      raw.push([(i % cols) * step, Math.floor(i / cols) * step]);
      if (i === start) break;
    }
    raw.reverse();
    // An off-grid walker must not be snapped across a wall/corner. Simulation
    // endpoints are already on-grid, so their route lengths remain unchanged.
    if (free(...a) && Math.hypot(raw[0][0] - a[0], raw[0][1] - a[1]) > 1e-8) raw.unshift([...a]);
    const smoothed = [raw[0]];
    for (let i = 0; i < raw.length - 1;) {
      let j = raw.length - 1;
      while (j > i + 1 && !segmentFree(raw[i], raw[j])) j--;
      smoothed.push(raw[j]);
      i = j;
    }
    return smoothed;
  }
  return {
    free,
    path,
    segmentFree,
    nearestPoint: (p) => {
      const i = nearest(p);
      return i < 0 ? null : [(i % cols) * step, Math.floor(i / cols) * step];
    },
  };
}

export function createCrowd(venue, count = 24) {
  const nav = createNavigation(venue);
  const stops = venue.stops
    .map((s) => {
      const p = nav.nearestPoint([s.x, s.z]);
      return p ? { ...s, x: p[0], z: p[1] } : null;
    })
    .filter(Boolean);
  if (!stops.length) return { agents: [], nav, stops };
  const agents = Array.from({ length: count }, (_, i) => {
    const from = stops[i % stops.length],
      to = stops[(i + 1) % stops.length];
    const path = nav.path([from.x, from.z], [to.x, to.z]);
    const startIndex = Math.floor((path.length - 1) * ((i % 5) / 5));
    const p = path[startIndex] || venue.entrance;
    return {
      id: i,
      x: p[0],
      z: p[1],
      y: 0,
      heading: i * 0.8,
      speed: 0,
      stride: i * 0.4,
      distance: 0,
      target: (i + 1) % stops.length,
      path,
      index: startIndex + 1,
      wait: (i % 4) * 0.8,
      activity: "대기",
      walkBlend: 0,
      maxSpeed: 0.92 + (i % 7) * 0.055,
      cycle: 0,
      blockedFor: 0,
      progressFor: 0,
      progressOrigin: [...p],
    };
  });
  // Spread arrivals on the same valid route network; avoids all people spawning at one counter.
  for (let t = 0; t < 240; t++) stepCrowd({ agents, nav, stops }, 1 / 30);
  return { agents, nav, stops };
}
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
export function stepCrowd(crowd, dt) {
  dt = Math.min(Math.max(dt, 0), 0.05);
  if (!Number.isFinite(dt) || dt <= 0) return;
  const { agents, nav, stops } = crowd;
  for (const a of agents) {
    let desired = 0, moved = 0;
    if (a.wait > 0) {
      a.wait -= dt;
      a.activity = stops[a.target]?.activity || "관람";
    } else {
      let point = a.path[a.index];
      if (!point) {
        a.cycle++;
        a.target = (a.target + 1 + (a.id % 2)) % stops.length;
        const stop = stops[a.target];
        const queuePoint = [
          stop.x + ((a.id % 3) - 1) * 0.65,
          stop.z + Math.floor((a.id % 9) / 3) * 0.6,
        ];
        a.destination = nav.free(...queuePoint) ? queuePoint : [stop.x, stop.z];
        a.path = nav.path(
          [a.x, a.z],
          a.destination,
        );
        // Return to the snapped route start before following its smoothed segment.
        // Starting at index 1 can cut across a corner after crowd separation.
        a.index = 0;
        point = a.path[0];
      }
      if (point) {
        const dx = point[0] - a.x,
          dz = point[1] - a.z,
          dist = Math.hypot(dx, dz);
        let vx = dx / Math.max(dist, 0.001),
          vz = dz / Math.max(dist, 0.001);
        for (const other of agents)
          if (other !== a) {
            const ox = a.x - other.x,
              oz = a.z - other.z,
              d = Math.hypot(ox, oz);
            if (d < 1.05 && d > 0.001) {
              const pressure = (1.05 - d) * 1.45;
              vx += (ox / d) * pressure;
              vz += (oz / d) * pressure;
            }
          }
        const vLength = Math.hypot(vx, vz);
        vx /= Math.max(vLength, 0.001);
        vz /= Math.max(vLength, 0.001);
        const targetHeading = Math.atan2(vx, vz);
        a.heading += angleDelta(a.heading, targetHeading) * Math.min(1, dt * 7);
        desired =
          a.maxSpeed *
          Math.min(1, dist / 0.65) *
          Math.max(0.2, Math.cos(angleDelta(a.heading, targetHeading)));
        for (const other of agents)
          if (other !== a) {
            const ox = other.x - a.x,
              oz = other.z - a.z,
              d = Math.hypot(ox, oz);
            const ahead =
              (ox * Math.sin(targetHeading) + oz * Math.cos(targetHeading)) /
              Math.max(0.001, d);
            if (d < 0.95 && ahead > 0.45)
              desired *= Math.max(0.16, (d - 0.42) / 0.53);
          }
        // Always advance on the collision-checked segment, with smooth facing independent of translation.
        const speed = a.speed + (desired - a.speed) * Math.min(1, dt * 4.8);
        const step = Math.min(dist, speed * dt);
        let nx = a.x + vx * step, nz = a.z + vz * step;
        let free = nav.segmentFree([a.x, a.z], [nx, nz]);
        if (!free) {
          // A separation vector must not pin a walker against an obstacle forever.
          nx = a.x + dx / Math.max(dist, 0.001) * step;
          nz = a.z + dz / Math.max(dist, 0.001) * step;
          free = nav.segmentFree([a.x, a.z], [nx, nz]);
        }
        if (free) {
          moved = Math.hypot(nx - a.x, nz - a.z);
          a.x = nx;
          a.z = nz;
          a.distance += moved;
        }
        a.blockedFor = moved < 0.001 && dist > 0.2 ? (a.blockedFor || 0) + dt : 0;
        a.progressFor = (a.progressFor || 0) + dt;
        const anchor = a.progressOrigin || [a.x, a.z];
        const stalled = a.progressFor >= 2 && Math.hypot(a.x - anchor[0], a.z - anchor[1]) < 0.15;
        if (a.blockedFor > 0.5 || stalled) {
          a.replanAttempts = (a.replanAttempts || 0) + 1;
          // A bounded visual visitor can choose another stop when a local queue
          // stays blocked; never teleport or walk through architectural obstacles.
          if (a.replanAttempts >= 3) {
            a.target = (a.target + 1) % stops.length;
            a.destination = [stops[a.target].x, stops[a.target].z];
            a.replanAttempts = 0;
          }
          const destination = a.destination || a.path.at(-1) || [stops[a.target].x, stops[a.target].z];
          a.path = nav.path([a.x, a.z], destination);
          a.index = 0;
          a.blockedFor = 0;
          a.progressFor = 0;
          a.progressOrigin = [a.x, a.z];
        } else if (dist < (a.index === a.path.length - 1 ? 0.55 : 0.16)) {
          a.index++;
          if (a.index >= a.path.length) {
            a.wait = 2 + (a.id % 5) * 0.6;
            a.activity = stops[a.target].activity;
          }
        } else a.activity = "이동";
        if (a.progressFor >= 2) {
          a.replanAttempts = 0;
          a.progressFor = 0;
          a.progressOrigin = [a.x, a.z];
        }
      }
    }
    // Walking pose follows successful translation, not a blocked desired velocity.
    a.speed = dt > 0 ? moved / dt : 0;
    a.walkBlend +=
      (Math.min(1, a.speed / 0.65) - a.walkBlend) * Math.min(1, dt * 6);
    a.stride += moved * 5.9; // distance-linked gait, never accelerated by KPI replay
  }
  // Short-range separation is local motion hygiene, not a calibrated crowd-density model.
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i],
        b = agents[j],
        dx = a.x - b.x,
        dz = a.z - b.z,
        d = Math.hypot(dx, dz);
      if (d < 0.42) {
        const angle = (i + j) * 2.399,
          ux = d > 0.001 ? dx / d : Math.cos(angle),
          uz = d > 0.001 ? dz / d : Math.sin(angle),
          push = (0.42 - d) * 0.51;
        if (nav.free(a.x + ux * push, a.z + uz * push)) {
          a.x += ux * push;
          a.z += uz * push;
        }
        if (nav.free(b.x - ux * push, b.z - uz * push)) {
          b.x -= ux * push;
          b.z -= uz * push;
        }
      }
    }
}
