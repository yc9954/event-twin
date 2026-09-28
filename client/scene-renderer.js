import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { whiteFixture } from "./white-fixtures.js";
import { planAnimationFrame, resetFrameClock, presentationSize, previewFrameRate, shouldPaint, selectFollowTarget } from "./render-timing.mjs";
// Reused from this project's own v12 renderer; no external editor or GLB assets.
import { makeVenue, createCrowd, stepCrowd } from "./venue-navigation.mjs";

const white = new THREE.MeshStandardMaterial({
  color: 0xf1f2f1,
  roughness: 0.75,
});
const stone = new THREE.MeshStandardMaterial({
  color: 0xd7dcd9,
  roughness: 0.94,
});
const trim = new THREE.MeshStandardMaterial({
  color: 0xd1d7d9,
  roughness: 0.68,
});
const glass = new THREE.MeshStandardMaterial({
  color: 0xabc6cf,
  transparent: true,
  opacity: 0.31,
  roughness: 0.2,
  metalness: 0.08,
  depthWrite: false,
});
const actorMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.8,
});
const unitBox = new THREE.BoxGeometry(1, 1, 1),
  sphere = new THREE.SphereGeometry(1, 12, 10),
  cylinder = new THREE.CylinderGeometry(1, 1, 1, 10);
const temp = new THREE.Object3D(),
  up = new THREE.Vector3(0, 1, 0),
  aVec = new THREE.Vector3(),
  bVec = new THREE.Vector3();
function box(g, x, y, z, w, h, d, mat = white) {
  const m = new THREE.Mesh(unitBox, mat);
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  m.castShadow = mat !== glass;
  m.receiveShadow = true;
  g.add(m);
  return m;
}
function staticModel(venue) {
  const g = new THREE.Group();
  const { width: w, depth: d } = venue;
  box(g, w / 2, -0.24, d / 2, w + 0.65, 0.34, d + 0.65, white);
  box(g, w / 2, -0.05, d / 2, w, 0.08, d, white);
  for (let x = 0; x <= w; x += 2)
    box(g, x, 0.002, d / 2, 0.008, 0.006, d, trim);
  for (let z = 0; z <= d; z += 2)
    box(g, w / 2, 0.002, z, w, 0.006, 0.008, trim);
  for (const p of venue.items) {
    if (["booth", "entry", "lounge", "pedestal"].includes(p.type)) {
      const object = whiteFixture({ kind: p.type });
      object.position.set(p.x, 0, p.z);
      object.rotation.y = p.rotation || 0;
      if (p.scale) object.scale.set(...p.scale);
      g.add(object);
    } else if (p.type === "tree") {
      box(g, p.x, 0.22, p.z, 1, 0.44, 1, white);
      const trunk = new THREE.Mesh(cylinder, trim);
      trunk.position.set(p.x, 1.35, p.z);
      trunk.scale.set(0.09, 2.4, 0.09);
      g.add(trunk);
      for (let k = 0; k < 6; k++) {
        const m = new THREE.Mesh(sphere, white);
        m.scale.set(0.66, 0.75, 0.63);
        m.position.set(
          p.x + Math.sin(k * 2.4) * 0.45,
          2.5 + (k % 3) * 0.3,
          p.z + Math.cos(k * 2.4) * 0.45,
        );
        m.castShadow = true;
        g.add(m);
      }
    } else if (p.type === "upperLounge") {
      const o = whiteFixture({ kind: "lounge" });
      o.position.set(p.x, p.y, p.z);
      if (p.scale) o.scale.set(...p.scale);
      g.add(o);
    } else if (p.type === "stairs") {
      for (let i = 0; i < 20; i++) {
        const h = ((i + 1) * p.h * 3.77) / 3.6 / 20;
        box(
          g,
          p.x,
          h / 2,
          p.z + p.d / 2 - ((i + 0.5) * p.d) / 20,
          p.w,
          h,
          p.d / 20,
        );
      }
      for (const sign of [-1, 1])
        for (let i = 0; i <= 10; i++)
          box(
            g,
            p.x + (sign * p.w) / 2,
            (i * p.h * 3.77) / 3.6 / 10 + 0.5,
            p.z + p.d / 2 - (i * p.d) / 10,
            0.025,
            1,
            0.025,
            trim,
          );
    } else {
      const mat =
        p.type === "glass" ? glass : p.type === "garden" ? stone : white;
      box(g, p.x, (p.y || 0) + p.h / 2, p.z, p.w, p.h, p.d, mat);
      if (p.type === "glass") {
        const alongX = p.w > p.d,
          length = Math.max(p.w, p.d),
          n = Math.ceil(length / 1.7);
        for (let i = 0; i <= n; i++)
          box(
            g,
            p.x + (alongX ? (i / n - 0.5) * length : 0),
            (p.y || 0) + p.h / 2,
            p.z + (!alongX ? (i / n - 0.5) * length : 0),
            0.04,
            p.h,
            0.04,
            white,
          );
        box(
          g,
          p.x,
          (p.y || 0) + p.h,
          p.z,
          p.w + 0.035,
          0.055,
          p.d + 0.035,
          white,
        );
      }
      if (p.type === "relief")
        for (let i = 0; i < 6; i++)
          box(
            g,
            p.x - p.w / 2 + 0.15 + (i * p.w) / 6,
            (p.y || 0) + p.h / 2,
            p.z + 0.06,
            0.035,
            p.h * 0.85,
            0.08,
            trim,
          );
    }
  }
  // Batch architectural meshes by material to keep sixteen live views inexpensive.
  g.updateMatrixWorld(true);
  const batches = new Map(),
    originals = new Set();
  g.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.material.uuid;
    if (!batches.has(key))
      batches.set(key, { material: o.material, geometries: [] });
    const geometry = (
      o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()
    ).applyMatrix4(o.matrixWorld);
    geometry.deleteAttribute("uv");
    batches.get(key).geometries.push(geometry);
    if (
      o.geometry !== unitBox &&
      o.geometry !== sphere &&
      o.geometry !== cylinder
    )
      originals.add(o.geometry);
  });
  const result = new THREE.Group();
  for (const { material, geometries } of batches.values()) {
    const geo = mergeGeometries(geometries, false),
      mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = material !== glass;
    mesh.receiveShadow = true;
    result.add(mesh);
    geometries.forEach((g) => g.dispose());
  }
  originals.forEach((g) => g.dispose());
  return result;
}

const bodyParts = [
  "torso",
  "hip",
  "head",
  "hair",
  "neck",
  "leftThigh",
  "rightThigh",
  "leftShin",
  "rightShin",
  "leftFoot",
  "rightFoot",
  "leftUpper",
  "rightUpper",
  "leftFore",
  "rightFore",
  "leftHand",
  "rightHand",
  "nose",
];
const tops = [0x788782, 0x9b8776, 0x626f80, 0xb19a85, 0x859593, 0x87828f];
const skins = [0xc49b7f, 0x996e55, 0xe1bba0, 0xb68263];
function makeRigBatch(scene, count) {
  const parts = {};
  for (const part of bodyParts) {
    const mesh = new THREE.InstancedMesh(
      /Thigh|Shin|Upper|Fore/.test(part) ? cylinder : sphere,
      actorMaterial,
      count,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    for (let i = 0; i < count; i++) {
      const color = /head|neck|Hand|nose/.test(part)
        ? skins[i % 4]
        : part === "hair"
          ? 0x403c38
          : /Foot/.test(part)
            ? 0x3c4244
            : /Shin|Thigh|hip/.test(part)
              ? 0x56616b
              : tops[i % tops.length];
      mesh.setColorAt(i, new THREE.Color(color));
    }
    scene.add(mesh);
    parts[part] = mesh;
  }
  return parts;
}
function pointMatrix(rig, i, origin, x, y, z, sx, sy, sz, rx = 0) {
  temp.position.set(x, y, z);
  temp.rotation.set(rx, 0, 0);
  temp.scale.set(sx, sy, sz);
  temp.updateMatrix();
  temp.matrix.premultiply(origin);
  rig.setMatrixAt(i, temp.matrix);
}
function boneMatrix(rig, i, origin, from, to, radius) {
  aVec.fromArray(from);
  bVec.fromArray(to);
  temp.position.copy(aVec).add(bVec).multiplyScalar(0.5);
  bVec.sub(aVec);
  temp.quaternion.setFromUnitVectors(up, bVec.clone().normalize());
  temp.scale.set(radius, bVec.length(), radius);
  temp.updateMatrix();
  temp.matrix.premultiply(origin);
  rig.setMatrixAt(i, temp.matrix);
}
function knee(hip, foot) {
  const dy = foot[1] - hip[1],
    dz = foot[2] - hip[2],
    d = Math.min(0.865, Math.max(0.01, Math.hypot(dy, dz)));
  const along = (0.44 ** 2 - 0.435 ** 2 + d * d) / (2 * d),
    bend = Math.sqrt(Math.max(0, 0.44 ** 2 - along * along));
  return [
    hip[0],
    hip[1] + (dy / d) * along + (dz / d) * bend,
    hip[2] + (dz / d) * along - (dy / d) * bend,
  ];
}
const origin = new THREE.Object3D();
function animatePeople(rigs, agents, time) {
  agents.forEach((a, i) => {
    const blend = a.walkBlend,
      height = 0.96 + (i % 5) * 0.017;
    origin.position.set(a.x, a.y || 0, a.z);
    origin.rotation.set(0, a.heading, 0);
    origin.scale.setScalar(height);
    origin.updateMatrix();
    const m = origin.matrix;
    const breathe = Math.sin(time * 1.6 + i) * 0.006,
      bob = 0.008 * Math.cos(a.stride * 2) * blend;
    pointMatrix(rigs.hip, i, m, 0, 0.9 + bob, 0, 0.19, 0.13, 0.12);
    pointMatrix(
      rigs.torso,
      i,
      m,
      0,
      1.21 + bob + breathe,
      0.015,
      0.235,
      0.32,
      0.135,
      -0.025 * blend,
    );
    pointMatrix(rigs.neck, i, m, 0, 1.49 + bob, 0, 0.07, 0.09, 0.07);
    pointMatrix(rigs.head, i, m, 0, 1.66 + bob, 0.015, 0.125, 0.17, 0.12);
    pointMatrix(rigs.hair, i, m, 0, 1.735 + bob, -0.005, 0.13, 0.102, 0.123);
    pointMatrix(rigs.nose, i, m, 0, 1.65 + bob, 0.137, 0.025, 0.03, 0.032);
    for (const side of [-1, 1]) {
      const name = side < 0 ? "left" : "right",
        phase =
          (((a.stride / (Math.PI * 2) + (side < 0 ? 0 : 0.5)) % 1) + 1) % 1;
      let fz, fy;
      if (phase < 0.62) {
        fz = 0.33 - (0.66 * phase) / 0.62;
        fy = 0;
      } else {
        const t = (phase - 0.62) / 0.38;
        const smooth = t * t * (3 - 2 * t);
        fz = -0.33 + 0.66 * smooth;
        fy = Math.sin(t * Math.PI) * 0.16;
      }
      const foot = [side * 0.11, 0.075 + fy * blend, fz * blend],
        hip = [side * 0.095, 0.91 + bob, 0],
        k = knee(hip, foot);
      boneMatrix(rigs[name + "Thigh"], i, m, hip, k, 0.081);
      boneMatrix(rigs[name + "Shin"], i, m, k, foot, 0.059);
      pointMatrix(
        rigs[name + "Foot"],
        i,
        m,
        foot[0],
        foot[1] - 0.024,
        foot[2] + 0.06,
        0.077,
        0.048,
        0.16,
      );
      const swing =
        -Math.sin(a.stride + (side < 0 ? 0 : Math.PI)) * 0.22 * blend;
      const gesture =
        (1 - blend) *
        (a.activity === "체험" ? 0.17 + 0.07 * Math.sin(time * 2 + i) : 0);
      const shoulder = [side * 0.235, 1.43 + bob, 0],
        elbow = [side * 0.285, 1.16 + bob, swing * 0.5 + gesture],
        hand = [side * 0.27, 0.94 + bob + gesture, swing + gesture * 1.8];
      boneMatrix(rigs[name + "Upper"], i, m, shoulder, elbow, 0.069);
      boneMatrix(rigs[name + "Fore"], i, m, elbow, hand, 0.052);
      pointMatrix(rigs[name + "Hand"], i, m, ...hand, 0.045, 0.073, 0.041);
    }
  });
  Object.values(rigs).forEach((m) => (m.instanceMatrix.needsUpdate = true));
}
function createWorld(candidate, compact = false) {
  const venue = makeVenue(candidate),
    scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe7eaec);
  scene.add(staticModel(venue));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(venue.width * 4, venue.depth * 4),
    new THREE.MeshStandardMaterial({ color: 0xe7eaec, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(venue.width / 2, -0.43, venue.depth / 2);
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(new THREE.HemisphereLight(0xfaffff, 0x8993a1, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 3.1);
  const size = Math.max(venue.width, venue.depth);
  sun.position.set(-size * 0.13, size, venue.depth * 0.85);
  sun.target.position.set(venue.width / 2, 0, venue.depth / 2);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, {
    left: -size,
    right: size,
    top: size,
    bottom: -size,
    near: 1,
    far: size * 4,
  });
  // Compact comparison cards do not need a 2048² shadow target each. Sixteen
  // such maps can exhaust GPU memory even though the canvases are small.
  sun.shadow.mapSize.set(compact ? 1024 : 2048, compact ? 1024 : 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.018;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xe3efff, 0.7);
  fill.position.set(30, 10, -8);
  scene.add(fill);
  const crowd = createCrowd(venue, 24),
    rigs = makeRigBatch(scene, crowd.agents.length);
  animatePeople(rigs, crowd.agents, 0);
  const camera = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, size * 8);
  return { scene, camera, crowd, rigs, venue, time: 0, sun };
}
function cameraFor(world, width, height, view) {
  const { camera, crowd } = world,
    aspect = width / height;
  if (view === "follow" && crowd.agents.length) {
    world.followTarget = selectFollowTarget(crowd.agents, world.followTarget, world.time);
    const a = crowd.agents.find(agent => agent.id === world.followTarget.id),
      target = new THREE.Vector3(a.x, a.y + 0.85, a.z);
    const position = new THREE.Vector3(a.x + 8, a.y + 6.5, a.z + 10);
    if (world.cameraView !== "follow") {
      camera.position.copy(position);
      world.followLookAt = target;
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, world.time - world.cameraTime) * 7);
      camera.position.lerp(position, alpha);
      world.followLookAt.lerp(target, alpha);
    }
    camera.lookAt(world.followLookAt);
    const extent = 4.8;
    camera.left = -extent * aspect;
    camera.right = extent * aspect;
    camera.top = extent;
    camera.bottom = -extent;
  } else {
    const { width: w, depth: d, height: h } = world.venue,
      size = Math.max(w, d);
    if (view === "top") camera.position.set(w / 2, size * 2, d / 2 + 0.001);
    else if (view === "entry")
      camera.position.set(
        w / 2 + size * 0.85,
        size * 0.55,
        d / 2 + size * 1.15,
      );
    else camera.position.set(w / 2 + size, size * 1.16, d / 2 + size * 1.16);
    camera.lookAt(
      w / 2,
      world.venue.family === "forum" ? h * 0.6 : h * 0.3,
      d / 2,
    );
    const extent =
      view === "top"
        ? Math.max(d * 0.56, (w * 0.56) / aspect)
        : Math.max(d * 0.33 + w * 0.21 + h * 0.45, ((w + d) * 0.43) / aspect);
    camera.left = -extent * aspect;
    camera.right = extent * aspect;
    camera.top = extent;
    camera.bottom = -extent;
  }
  world.cameraView = view;
  world.cameraTime = world.time;
  camera.updateProjectionMatrix();
}

// One pooled WebGL renderer; lossless, device-pixel-sized 2D presentation surfaces.
// Sixteen cards must never allocate sixteen WebGL contexts.
const views = new Map();
let renderer = null,
  frame = 0,
  disposedAt = 0;
function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  renderer.setSize(2560, 1536, false);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setScissorTest(true);
}
function cleanupWorld(world) {
  if (!world) return;
  world.scene.traverse((o) => {
    if (o.geometry && ![unitBox, sphere, cylinder].includes(o.geometry))
      o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
  world.sun.shadow.map?.dispose();
}
function resetClocks() {
  for (const v of views.values()) {
    v.clock = resetFrameClock();
    v.lastPaintAt = null;
  }
}
function tick(now) {
  frame = requestAnimationFrame(tick);
  if (document.hidden) {
    resetClocks();
    return;
  }
  // Native dialog has an implicit accessibility role, not a role attribute.
  const modal = document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]');
  const orderedViews = [...views.values()].map(v => ({
    v,
    rect: v.element.getBoundingClientRect(),
    compact: Boolean(v.element.closest(".candidate-visual")),
  })).sort((a, b) =>
    Number(Boolean(b.v.props.captureSize || modal?.contains(b.v.element))) -
    Number(Boolean(a.v.props.captureSize || modal?.contains(a.v.element))) ||
    (a.v.lastPaintAt ?? -Infinity) - (b.v.lastPaintAt ?? -Infinity));
  const visiblePreviews = orderedViews.filter(({v,rect,compact}) => compact &&
    (!modal || modal.contains(v.element)) && rect.width >= 10 && rect.height >= 10 &&
    rect.bottom >= 0 && rect.top <= innerHeight && rect.right >= 0 && rect.left <= innerWidth).length;
  const previewFps = previewFrameRate(visiblePreviews);
  let offscreenPreviewBudget = 1, visiblePreviewBudget = 4;
  for (const {v,rect,compact} of orderedViews) {
    if (rect.width < 10 || rect.height < 10 || (modal && !modal.contains(v.element))) {
      v.clock = resetFrameClock();
      continue;
    }
    const visible =
      rect.bottom >= 0 &&
      rect.top <= innerHeight &&
      rect.right >= 0 &&
      rect.left <= innerWidth;
    // One first-paint thumbnail per frame ensures all sixteen cards have a printable preview.
    if (!visible) {
      v.clock = resetFrameClock();
      if (v.painted || offscreenPreviewBudget-- <= 0) continue;
    }
    if (visible && compact && visiblePreviewBudget <= 0) continue;
    try {
      ensureRenderer();
      if (!v.world) {
        v.world = createWorld(v.props.candidate, compact);
        v.dirty = true;
        v.forcePaint = true;
        v.clock = resetFrameClock();
      }
      const { width: w, height: h } = presentationSize(rect, v.props.captureSize, window.devicePixelRatio);
      if (renderer.domElement.width < w || renderer.domElement.height < h) {
        renderer.setSize(Math.max(renderer.domElement.width, w), Math.max(renderer.domElement.height, h), false);
      }
      if (v.canvas.width !== w || v.canvas.height !== h) {
        v.canvas.width = w;
        v.canvas.height = h;
        v.dirty = true;
        v.forcePaint = true;
      }
      const world = v.world;
      const timing = planAnimationFrame(v.clock, now, visible && v.props.moving !== false);
      v.clock = timing.clock;
      for (let i = 0; i < timing.steps; i++) {
        stepCrowd(world.crowd, timing.stepSeconds);
        world.time += timing.stepSeconds;
      }
      if (timing.steps) {
        v.dirty = true;
      }
      if (!shouldPaint({ dirty: v.dirty, forcePaint: v.forcePaint, lastPaintAt: v.lastPaintAt,
        now, priority: !compact || Boolean(v.props.captureSize || modal?.contains(v.element)), previewFps })) continue;
      animatePeople(world.rigs, world.crowd.agents, world.time);
      cameraFor(world, w, h, v.props.view);
      renderer.setViewport(0, 0, w, h);
      renderer.setScissor(0, 0, w, h);
      renderer.clear();
      renderer.render(world.scene, world.camera);
      v.context.drawImage(renderer.domElement, 0, renderer.domElement.height - h, w, h, 0, 0, w, h);
      v.paintCount++;
      v.canvas.dataset.resolution = `${w}×${h}`;
      v.canvas.dataset.agents = world.crowd.agents.length;
      v.canvas.dataset.frame = String(v.paintCount);
      v.canvas.dataset.simulationTime = world.time.toFixed(3);
      v.canvas.dataset.followAgent = v.props.view === "follow" ? String(world.followTarget?.id ?? "") : "";
      v.canvas.dataset.renderFps = v.lastPaintAt === null ? "0" : (1000 / Math.max(1, now - v.lastPaintAt)).toFixed(1);
      v.canvas.dataset.motion = v.props.moving === false ? "paused" : "playing";
      v.canvas.dataset.captureReady = v.props.captureSize ? "true" : "false";
      v.lastPaintAt = now;
      v.dirty = false;
      v.forcePaint = false;
      v.painted = true;
      if (visible && compact) visiblePreviewBudget--;
      if (v.element.dataset.renderError) {
        delete v.element.dataset.renderError;
        v.props.onError?.("");
      }
      if (!visible) {
        cleanupWorld(v.world);
        v.world = null;
      }
    } catch (error) {
      v.canvas.dataset.captureReady = "false";
      v.element.dataset.renderError = error.message;
      v.props.onError?.(error.message);
    }
  }
  // Dispose scenes that leave the visible window for a while; geometry can be regenerated.
  if (now - disposedAt > 15000) {
    disposedAt = now;
    for (const v of views.values()) {
      const r = v.element.getBoundingClientRect();
      if (v.world && (r.bottom < -1200 || r.top > innerHeight + 1200)) {
        cleanupWorld(v.world);
        v.world = null;
      }
    }
  }
}
export function registerView(element, canvas, props) {
  const id = Symbol("view"),
    v = {
      element,
      canvas,
      context: canvas.getContext("2d", { alpha: false }),
      props,
      world: null,
      dirty: true,
      forcePaint: true,
      painted: false,
      paintCount: 0,
      lastPaintAt: null,
      clock: resetFrameClock(),
    };
  views.set(id, v);
  if (!frame) {
    document.addEventListener("visibilitychange", resetClocks);
    frame = requestAnimationFrame(tick);
  }
  return {
    update(next) {
      const changed =
        JSON.stringify(next.candidate) !== JSON.stringify(v.props.candidate);
      if (changed) {
        cleanupWorld(v.world);
        v.world = null;
        v.painted = false;
        v.clock = resetFrameClock();
      }
      if (next.moving !== v.props.moving) v.clock = resetFrameClock();
      v.props = next;
      v.dirty = true;
      v.forcePaint = true;
      v.canvas.dataset.captureReady = "false";
    },
    dispose() {
      cleanupWorld(v.world);
      views.delete(id);
      if (!views.size) {
        cancelAnimationFrame(frame);
        frame = 0;
        document.removeEventListener("visibilitychange", resetClocks);
        renderer?.dispose();
        renderer = null;
      }
    },
  };
}
