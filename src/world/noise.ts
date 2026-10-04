const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** Smooth 2D value noise in [0, 1]. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in [0, 1]. */
export function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise2(x, y) * amplitude;
    norm += amplitude;
    x *= 2.03;
    y *= 2.03;
    amplitude *= 0.5;
  }
  return sum / norm;
}
