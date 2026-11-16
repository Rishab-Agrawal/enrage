import * as THREE from 'three';
import { fbm } from './noise';
import { CELL, CELLS, MAP_SIZE, SEA_LEVEL, groundHeight } from './terrain';

/**
 * Where the trails lead from the hilltop: the lake, the east and north-east shores, the massif's ledges, the west bay,
 * and the south and south-west shores.
 */
const ENDS: [number, number][] = [[78, -52], [285, 60], [200, -200], [-75, -200], [-165, 32], [-32, 250], [-200, 200]];
/** Trails start at the arena's rim: this far from the hilltop's centre, m. */
const RIM = 18;
/** Metres between the points a trail is routed through. */
const STEP = CELL * 2;
const SIDE = CELLS / 2 + 1;
/** The steepest ground a trail takes, m risen per m, and the deepest water it fords, m. */
const STEEPEST = 0.45;
const FORD = 0.8;
const WIDTH = 1.9;

/**
 * The trails, each a line of points (x, z) from its end back to the hilltop's rim: the easiest ways over the land, as
 * feet would find them, keeping to gentle ground and wandering a little. They share their way where their ways agree.
 */
function routes(): [number, number][][] {
  const at = (node: number): [number, number] => [((node % SIDE) - (SIDE - 1) / 2) * STEP, (Math.floor(node / SIDE) - (SIDE - 1) / 2) * STEP];
  const node = (x: number, z: number) => Math.round(z / STEP + (SIDE - 1) / 2) * SIDE + Math.round(x / STEP + (SIDE - 1) / 2);
  const cost = new Float32Array(SIDE * SIDE).fill(Infinity);
  const back = new Int32Array(SIDE * SIDE).fill(-1);
  // Dijkstra from the hilltop, on a binary heap of [cost, node] pairs.
  const heap: [number, number][] = [[0, node(0, 0)]];
  cost[heap[0][1]] = 0;
  while (heap.length) {
    const [spent, here] = heap[0];
    const last = heap.pop()!;
    for (let i = 0; heap.length; ) {
      const child = [2 * i + 1, 2 * i + 2].filter((c) => c < heap.length).sort((a, b) => heap[a][0] - heap[b][0])[0];
      if (child === undefined || heap[child][0] >= last[0]) {
        heap[i] = last;
        break;
      }
      heap[i] = heap[child];
      i = child;
    }
    if (spent > cost[here]) continue;
    const [x, z] = at(here);
    const height = groundHeight(x, z);
    for (let turn = 0; turn < 8; turn += 1) {
      const [dx, dz] = [Math.round(Math.cos((turn * Math.PI) / 4)), Math.round(Math.sin((turn * Math.PI) / 4))];
      const [nx, nz] = [x + dx * STEP, z + dz * STEP];
      if (Math.max(Math.abs(nx), Math.abs(nz)) > MAP_SIZE / 2) continue;
      const [length, there] = [Math.hypot(dx, dz) * STEP, groundHeight(nx, nz)];
      // The steeper half of the way: a step in the land between two points counts in full.
      const middle = groundHeight((x + nx) / 2, (z + nz) / 2);
      const steep = Math.max(Math.abs(middle - height), Math.abs(there - middle)) / (length / 2);
      if (steep > STEEPEST || there < SEA_LEVEL - FORD) continue;
      // Slopes and water cost dear, and the going is easier here than there, so no trail runs straight.
      const toll = spent + length * (1 + 60 * steep * steep) * (there < SEA_LEVEL ? 4 : 1) * (0.6 + 0.8 * fbm(nx * 0.02 + 3, nz * 0.02));
      const next = node(nx, nz);
      if (toll >= cost[next]) continue;
      cost[next] = toll;
      back[next] = here;
      let i = heap.push([toll, next]) - 1;
      for (let parent = (i - 1) >> 1; i && heap[parent][0] > toll; i = parent, parent = (i - 1) >> 1) heap[i] = heap[parent];
      heap[i] = [toll, next];
    }
  }
  return ENDS.map(([x, z]) => {
    const trail: [number, number][] = [];
    for (let here = node(x, z); here >= 0 && Math.hypot(...at(here)) > RIM; here = back[here]) trail.push(at(here));
    return trail;
  }).filter((trail) => trail.length > 2);
}

const TRAILS = routes();

/** Strokes the trails in `style` over a picture of the map `size` px a side. */
export function strokeTrails(ctx: CanvasRenderingContext2D, size: number, style: string): void {
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / MAP_SIZE, size / MAP_SIZE);
  Object.assign(ctx, { strokeStyle: style, lineWidth: WIDTH, lineCap: 'round', lineJoin: 'round' });
  for (const trail of TRAILS) {
    ctx.beginPath();
    ctx.moveTo(...trail[0]);
    // Curves through the midpoints, so the trail bends without corners.
    for (let i = 1; i < trail.length - 1; i += 1) ctx.quadraticCurveTo(...trail[i], (trail[i][0] + trail[i + 1][0]) / 2, (trail[i][1] + trail[i + 1][1]) / 2);
    ctx.stroke();
  }
  ctx.restore();
}

const SIZE = 1024;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = SIZE;
const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
ctx.fillRect(0, 0, SIZE, SIZE);
ctx.filter = 'blur(1.5px)';
strokeTrails(ctx, SIZE, '#fff');
const worn = ctx.getImageData(0, 0, SIZE, SIZE).data;
const pixel = (metres: number) => THREE.MathUtils.clamp(Math.round((metres / MAP_SIZE + 0.5) * SIZE), 0, SIZE - 1);

/** How near the middle of a trail (x, z) lies, 0 to 1. */
export const trailAt = (x: number, z: number): number => worn[(pixel(z) * SIZE + pixel(x)) * 4] / 255;

/**
 * The same over the whole map, for the shaders. TRAIL_GLSL's `trail(spot)` reads it from a `uTrails` uniform as how
 * worn the ground is, 0 to 1: the trail's edges are ragged, and it narrows and widens along its way. Needs NOISE_GLSL.
 */
export const trailTexture = new THREE.CanvasTexture(canvas);
trailTexture.flipY = false;
export const TRAIL_GLSL = /* glsl */ `
  uniform sampler2D uTrails;
  float trail(vec2 spot) {
    float ragged = noise(spot * 0.9) * 0.3 + noise(spot * 0.13) * 0.3;
    return smoothstep(0.25 + ragged, 0.5 + ragged, texture2D(uTrails, spot / ${MAP_SIZE.toFixed(1)} + 0.5).r);
  }`;
