import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Original architectural scale-model geometry. No colored fit-out assets.
const white = new THREE.MeshStandardMaterial({
  color: "#f1f2f3",
  roughness: 0.83,
});
const inset = new THREE.MeshStandardMaterial({
  color: "#dfe3e6",
  roughness: 0.8,
});
const glass = new THREE.MeshStandardMaterial({
  color: "#b7d0dc",
  transparent: true,
  opacity: 0.45,
  roughness: 0.16,
  metalness: 0.08,
  depthWrite: false,
});
function box(g, w, h, d, x, y, z, material = white, radius = 0) {
  const mesh = new THREE.Mesh(
    radius
      ? new RoundedBoxGeometry(w, h, d, 3, radius)
      : new THREE.BoxGeometry(w, h, d),
    material,
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = material !== glass;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
function cylinder(g, radius, height, x, y, z, top = radius) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(top, radius, height, 32),
    white,
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
function chair(g, x, z, rotation = 0) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  box(group, 0.48, 0.1, 0.48, 0, 0.44, 0, white, 0.04);
  box(group, 0.48, 0.48, 0.07, 0, 0.69, -0.22, white, 0.035);
  for (const dx of [-0.19, 0.19])
    for (const dz of [-0.18, 0.18]) box(group, 0.035, 0.41, 0.035, dx, 0.2, dz);
  g.add(group);
}
function glazing(g, length, x, z, rotation = 0) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  const height = 2.75;
  box(group, length, height, 0.025, 0, height / 2, 0, glass);
  for (let i = 0; i <= 4; i++)
    box(
      group,
      0.045,
      height,
      0.09,
      -length / 2 + (i * length) / 4,
      height / 2,
      0,
    );
  for (const y of [0.045, height]) box(group, length, 0.07, 0.09, 0, y, 0);
  box(group, length, 0.035, 0.055, 0, 1.9, 0);
  g.add(group);
}
export function whiteFixture(n) {
  const g = new THREE.Group();
  if (n.kind === "booth") {
    box(g, 2, 1.16, 1.2, 0, 0.58, 0, white, 0.045);
    box(g, 2, 0.04, 1.2, 0, 1.18, 0, white, 0.015);
    for (let i = -8; i <= 8; i++)
      box(g, 0.019, 0.88, 0.018, i * 0.105, 0.53, 0.608);
    box(g, 0.48, 0.035, 0.31, -0.45, 1.22, 0.05, inset, 0.015);
    box(g, 0.34, 0.4, 0.045, 0.42, 1.45, -0.18, white, 0.025);
    box(g, 0.29, 0.32, 0.012, 0.42, 1.45, -0.153, inset, 0.01);
    cylinder(g, 0.055, 0.28, 0.42, 1.26, -0.18);
  } else if (n.kind === "backdrop") {
    // Architectural wall relief, not a branded green backdrop.
    for (const x of [-4, -1, 2]) {
      box(g, 2.55, 2.7, 0.06, x, 1.45, 0);
      box(g, 2.2, 0.025, 0.035, x, 2.62, 0.065);
      box(g, 0.025, 2.3, 0.035, x - 1.1, 1.47, 0.065);
      box(g, 0.025, 2.3, 0.035, x + 1.1, 1.47, 0.065);
    }
  } else if (n.kind === "plant") {
    cylinder(g, 0.27, 0.55, 0, 0.275, 0, 0.33);
    cylinder(g, 0.035, 1.28, 0, 1.06, 0);
    for (let i = 0; i < 12; i++) {
      const a = i * 2.399,
        y = 0.93 + (i % 5) * 0.17;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), white);
      leaf.scale.set(0.21, 0.09, 0.42);
      leaf.position.set(Math.sin(a) * 0.27, y, Math.cos(a) * 0.27);
      leaf.rotation.set(0.35, a, 0.3);
      leaf.castShadow = true;
      leaf.receiveShadow = true;
      g.add(leaf);
    }
  } else if (n.kind === "lounge") {
    box(g, 2.25, 0.23, 0.86, 0, 0.27, 0, white, 0.11);
    box(g, 2.25, 0.55, 0.22, 0, 0.6, -0.36, white, 0.1);
    for (const x of [-1.02, 1.02])
      box(g, 0.2, 0.48, 0.82, x, 0.47, 0, white, 0.08);
    for (const x of [-0.49, 0.49])
      box(g, 0.92, 0.14, 0.6, x, 0.43, 0.06, white, 0.06);
    cylinder(g, 0.53, 0.055, 0, 0.42, 1.1);
    cylinder(g, 0.15, 0.37, 0, 0.21, 1.1);
    chair(g, -1.55, 1.3, Math.PI / 2);
    chair(g, 1.55, 1.3, -Math.PI / 2);
  } else if (n.kind === "pedestal") {
    cylinder(g, 0.43, 0.85, 0, 0.425, 0);
    box(g, 0.3, 0.36, 0.3, 0, 1.03, 0, white, 0.025);
  } else if (n.kind === "entry") {
    box(g, 1.4, 0.95, 0.6, 0, 0.475, 0, white, 0.035);
    box(g, 0.32, 0.025, 0.22, 0.25, 0.976, 0, inset, 0.015);
  } else if (n.kind === "column") {
    box(g, 0.5, 3.4, 0.5, 0, 1.7, 0);
  } else if (n.kind === "screen") {
    box(g, 0.06, 1.2, 0.06, 0, 0.6, 0);
    box(g, 0.7, 0.035, 0.45, 0, 0.02, 0, white, 0.015);
    box(g, 1, 0.65, 0.075, 0, 1.4, 0, white, 0.025);
    box(g, 0.91, 0.56, 0.009, 0, 1.4, 0.042, inset, 0.01);
  } else if (n.kind === "decor") {
    // Neutral white piers, header and transparent glazing articulate the envelope.
    for (const z of [0.25, 3.9, 7.65]) box(g, 0.23, 3.4, 0.25, 0.17, 1.7, z);
    box(g, 0.28, 0.19, 7.8, 0.16, 3.15, 4);
    glazing(g, 3.45, 11.94, 2.05, Math.PI / 2);
    glazing(g, 3.45, 11.94, 5.68, Math.PI / 2);
    box(g, 0.2, 3.15, 0.2, 11.9, 1.575, 3.9);
    box(g, 0.22, 0.16, 7.55, 11.9, 2.9, 3.85);
    // Partial front wall with a real doorway opening; the rest is cut away for inspection.
    box(g, 2.4, 2.75, 0.16, 10.7, 1.375, 7.9);
    box(g, 1.8, 0.35, 0.16, 8.6, 2.575, 7.9);
    box(g, 0.17, 2.4, 0.17, 7.78, 1.2, 7.9);
  } else if (n.kind === "floorDetails") {
    for (let x = 1.2; x < 12; x += 1.2)
      box(g, 0.004, 0.001, 8, x, 0.003, 4, inset);
    for (let z = 1.2; z < 8; z += 1.2)
      box(g, 12, 0.001, 0.004, 6, 0.003, z, inset);
    // Model plinth under the 12 × 8m interior footprint.
    box(g, 12.6, 0.16, 8.6, 6, -0.23, 4, white, 0.025);
  }
  return g;
}
