import * as THREE from 'three';
import { fbm } from './noise';

/** The land is a square heightfield of this side, m, centred on the hilltop: an island, its shores well inside. */
export const WORLD_SIZE = 1200;
export const CELLS = 480;
export const CELL = WORLD_SIZE / CELLS;
const HALF = WORLD_SIZE / 2;
/** The sea, the lake and the river all lie at this height. */
export const SEA_LEVEL = -12;

const { lerp, smoothstep, clamp } = THREE.MathUtils;
const mound = (x: number, z: number, cx: number, cz: number, radius: number) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / radius ** 2);

/** The river's course from the lake to the south-east shore, and how far its bends swing off the straight line, m. */
const RIVER = { x: 125, z: -55, toX: 0.8, toZ: 0.6, length: 300, swing: 24 };

/** Metres from (x, z) to the river's midline. */
function riverDistance(x: number, z: number): number {
  const along = clamp((x - RIVER.x) * RIVER.toX + (z - RIVER.z) * RIVER.toZ, 0, RIVER.length);
  const bend = Math.sin(along * 0.045) * RIVER.swing * smoothstep(along, 0, 50);
  return Math.hypot(x - RIVER.x - along * RIVER.toX + bend * RIVER.toZ, z - RIVER.z - along * RIVER.toZ - bend * RIVER.toX);
}

/**
 * The flat hilltop dips into a valley; beyond it lie rolling country, a ridged massif to the north and a lake to the
 * east, drained by a shallow river. The land falls away into the sea all round.
 */
function shape(x: number, z: number): number {
  let land = -4 + (fbm(x * 0.0035 + 3, z * 0.0035 - 7, 5) - 0.5) * 44 + (fbm(x * 0.014, z * 0.014) - 0.5) * 11;
  const ridge = 1 - Math.abs(fbm(x * 0.006 + 40, z * 0.006) * 2 - 1);
  land += mound(x, z, -80, -230, 120) * (10 + 78 * ridge * ridge + (fbm(x * 0.03, z * 0.03) - 0.5) * 16);
  land -= mound(x, z, RIVER.x, RIVER.z, 50) * 17 + mound(x, z, -60, 190, 30) * 12;
  // The river runs in a broad vale, its bed shallow enough to wade.
  const river = riverDistance(x, z);
  land = lerp(Math.min(land, SEA_LEVEL + 2.5), land, smoothstep(river, 16, 70));
  land = lerp(Math.min(land, SEA_LEVEL - 0.6), land, smoothstep(river, 3, 14));
  const r = Math.hypot(x, z);
  const shore = r + (fbm(x * 0.006 - 20, z * 0.006 + 11) - 0.5) * 110;
  land = lerp(land, -34, smoothstep(shore, 300, 440));
  return (fbm(x * 0.15, z * 0.15) - 0.5) * 0.25 - smoothstep(r, 16, 70) * 9 + (land + 9) * smoothstep(r, 45, 170);
}

/** Heights at the grid's corners, row by row from the north-west: the terrain mesh's vertices. */
export const heights = new Float32Array((CELLS + 1) ** 2);
for (let i = 0; i < heights.length; i += 1) heights[i] = shape((i % (CELLS + 1)) * CELL - HALF, Math.floor(i / (CELLS + 1)) * CELL - HALF);

/** Ground height at (x, z), exactly as the terrain mesh's triangles lie. */
export function groundHeight(x: number, z: number): number {
  const u = clamp((x + HALF) / CELL, 0, CELLS - 1e-6);
  const v = clamp((z + HALF) / CELL, 0, CELLS - 1e-6);
  const [fu, fv] = [u % 1, v % 1];
  const i = Math.floor(v) * (CELLS + 1) + Math.floor(u);
  const [east, south] = [heights[i + 1], heights[i + CELLS + 1]];
  return fu + fv < 1
    ? heights[i] + (east - heights[i]) * fu + (south - heights[i]) * fv
    : heights[i + CELLS + 2] + (south - heights[i + CELLS + 2]) * (1 - fu) + (east - heights[i + CELLS + 2]) * (1 - fv);
}

/** How the ground rises at (x, z), metres per metre east and south, into `target`. */
export function groundSlope(x: number, z: number, target: THREE.Vector2): THREE.Vector2 {
  return target.set(groundHeight(x + CELL, z) - groundHeight(x - CELL, z), groundHeight(x, z + CELL) - groundHeight(x, z - CELL)).divideScalar(2 * CELL);
}
