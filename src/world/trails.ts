import * as THREE from 'three';
import { fbm } from './noise';
import { MAP_SIZE } from './terrain';

/**
 * The trails, as waypoints (x, z) out from the hilltop: to the great tree and the lake, on east over the river's ford,
 * north to the massif, west to the bay, and south by the pond to the shore.
 */
const TRAILS: [number, number][][] = [
  [[13, -10], [40, -32], [56, -42], [78, -52]],
  [[56, -42], [110, 0], [170, 20], [236, 22], [285, 60]],
  [[-6, -17], [-28, -80], [-55, -150], [-75, -200]],
  [[-17, 3], [-90, 22], [-165, 32]],
  [[3, 17], [-18, 95], [-52, 160], [-32, 250]],
];
/** A trail's width, m, and how far it wanders off the straight line between two waypoints, m. */
const WIDTH = 2.6;
const WANDER = 16;

/** Strokes the trails in `style` over a picture of the map `size` px a side. */
export function strokeTrails(ctx: CanvasRenderingContext2D, size: number, style: string): void {
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / MAP_SIZE, size / MAP_SIZE);
  Object.assign(ctx, { strokeStyle: style, lineWidth: WIDTH, lineCap: 'round', lineJoin: 'round' });
  for (const trail of TRAILS) {
    const points: [number, number][] = [];
    for (let i = 1; i < trail.length; i += 1) {
      const [[ax, az], [bx, bz]] = [trail[i - 1], trail[i]];
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 12);
      for (let step = 0; step < steps; step += 1) {
        const t = step / steps;
        const [x, z] = [ax + (bx - ax) * t, az + (bz - az) * t];
        // Sideways, and not at all at the waypoints, where trails meet.
        const sway = ((fbm(x * 0.05 + 3, z * 0.05) - 0.5) * WANDER * Math.sin(Math.PI * t)) / Math.hypot(bx - ax, bz - az);
        points.push([x - (bz - az) * sway, z + (bx - ax) * sway]);
      }
    }
    points.push(trail[trail.length - 1]);
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    // Curves through the midpoints, so the trail bends without corners.
    for (let i = 1; i < points.length - 1; i += 1) {
      ctx.quadraticCurveTo(...points[i], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
    }
    ctx.lineTo(...points[points.length - 1]);
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

/** How worn by a trail the ground at (x, z) is, 0 to 1. */
export const trailAt = (x: number, z: number): number => worn[(pixel(z) * SIZE + pixel(x)) * 4] / 255;

/** The same over the whole map, for the shaders, read by TRAIL_GLSL's `trail(spot)` from a `uTrails` uniform. */
export const trailTexture = new THREE.CanvasTexture(canvas);
trailTexture.flipY = false;
export const TRAIL_GLSL = /* glsl */ `
  uniform sampler2D uTrails;
  float trail(vec2 spot) { return smoothstep(0.1, 0.5, texture2D(uTrails, spot / ${MAP_SIZE.toFixed(1)} + 0.5).r); }`;
