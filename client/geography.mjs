import geography from "../shared/seongsu-geography.json" with { type: "json" };

export const WIDTH = 900,
  HEIGHT = 580;
export const center = [127.052, 37.5445];
const R = 6378137;
export function mercator([lng, lat]) {
  return [
    (R * lng * Math.PI) / 180,
    R *
      Math.log(
        Math.tan(
          Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360,
        ),
      ),
  ];
}
export function unproject([x, y]) {
  return [
    ((x / R) * 180) / Math.PI,
    ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI,
  ];
}
const origin = mercator(center);
// Isotropic projected metres: real coordinates and all overlays share one transform.
export const BASE_SCALE = 0.245;
export function project(coordinates) {
  const [x, y] = mercator(coordinates);
  return [
    (x - origin[0]) * BASE_SCALE + WIDTH / 2,
    (origin[1] - y) * BASE_SCALE + HEIGHT / 2,
  ];
}
export function geometryPath(coordinates, closed = false) {
  return (
    coordinates
      .map((c, i) => {
        const p = project(c);
        return `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`;
      })
      .join(" ") + (closed ? " Z" : "")
  );
}
const [west, south, east, north] = geography.source.bbox;
const northwest = project([west, north]);
const southeast = project([east, south]);

function constrainAxis(offset, minimum, maximum, viewportSize, scale) {
  const halfView = viewportSize / (2 * scale);
  const low = minimum + halfView - viewportSize / 2;
  const high = maximum - halfView - viewportSize / 2;
  // At 1× the collected extent is slightly narrower than the SVG. Center it
  // instead of allowing a drag to expose a larger, empty map margin.
  const constrained =
    low > high
      ? (minimum + maximum - viewportSize) / 2
      : Math.max(low, Math.min(high, offset));
  return Math.abs(constrained) < 1e-8 ? 0 : constrained;
}

export function constrainCamera(camera = {}) {
  const scale = Math.max(
    1,
    Math.min(3.5, Number.isFinite(camera.scale) ? camera.scale : 1),
  );
  return {
    ...camera,
    scale,
    x: constrainAxis(
      Number.isFinite(camera.x) ? camera.x : 0,
      northwest[0],
      southeast[0],
      WIDTH,
      scale,
    ),
    y: constrainAxis(
      Number.isFinite(camera.y) ? camera.y : 0,
      northwest[1],
      southeast[1],
      HEIGHT,
      scale,
    ),
  };
}

export function zoomCamera(camera, direction) {
  const current = constrainCamera(camera);
  const delta = Number.isFinite(direction) ? direction * 0.5 : 0;
  return constrainCamera({ ...current, scale: current.scale + delta });
}
export function panCamera(camera, dx, dy) {
  const current = constrainCamera(camera);
  return constrainCamera({
    ...current,
    x: current.x - (Number.isFinite(dx) ? dx : 0) / current.scale,
    y: current.y - (Number.isFinite(dy) ? dy : 0) / current.scale,
  });
}
export function cameraTransform(camera) {
  return `translate(${WIDTH / 2} ${HEIGHT / 2}) scale(${camera.scale}) translate(${-WIDTH / 2 - camera.x} ${-HEIGHT / 2 - camera.y})`;
}
export function metresInView(metres, camera) {
  return (
    (metres / Math.cos((center[1] * Math.PI) / 180)) * BASE_SCALE * camera.scale
  );
}
export function labelPoint(feature) {
  const a = feature.coordinates;
  return project(a[Math.floor(a.length / 2)]);
}
