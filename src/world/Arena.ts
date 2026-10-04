import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';
import { fbm, noise2 } from './noise';
import { addOutline, toonGradient } from './toon';

/** Late-afternoon sun, shared by the light rig, sky and far layers. */
export const SUN_DIRECTION = new THREE.Vector3(-0.75, 0.45, 0.45).normalize();
const HORIZON = new THREE.Color('#f3dfb8');
const SUNLIT = new THREE.Color('#ffe2b8');

/** Ground height: a flat hilltop dipping into a valley, with rolling hills rising beyond it. */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const dip = THREE.MathUtils.smoothstep(r, 16, 70) * 9;
  const hills = (fbm(x * 0.008 + 3, z * 0.008 - 7) - 0.3) * 55 * THREE.MathUtils.smoothstep(r, 45, 220);
  return (fbm(x * 0.15, z * 0.15) - 0.5) * 0.25 - dip + hills;
}

/** The fighters' grass push-out: the arena reads the two positions every frame. */
export type GrassBenders = { a: THREE.Vector3; b: THREE.Vector3 };

export class Arena {
  readonly group = new THREE.Group();
  private readonly time = { value: 0 };
  private readonly motes: THREE.Points;

  constructor(benders: GrassBenders) {
    const rng = createSeededRandom(7);
    this.group.add(createSky(), createMountains(), ...createClouds(rng), createTerrain(), createDirtPatch());
    this.group.add(createGrass(rng, this.time, benders), ...createFlowers(rng), ...createRocks(rng));
    this.motes = createMotes(rng);
    this.group.add(this.motes);
  }

  update(elapsed: number): void {
    this.time.value = elapsed;
    this.motes.rotation.y = elapsed * 0.01;
    this.motes.position.y = Math.sin(elapsed * 0.3) * 0.3;
  }
}

function createSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color('#5d8fd0') },
      uMid: { value: new THREE.Color('#a9c7e6') },
      uHorizon: { value: HORIZON },
      uSun: { value: SUN_DIRECTION },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uMid, uHorizon, uSun;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, h));
        col = mix(col, uTop, smoothstep(0.18, 0.75, h));
        float sun = max(dot(normalize(vDir), uSun), 0.0);
        col += vec3(1.0, 0.85, 0.6) * (pow(sun, 6.0) * 0.35 + pow(sun, 60.0) * 0.6);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), material);
  sky.frustumCulled = false;
  return sky;
}

/** Two painted mountain ranges, lit and hazed in vertex colour. */
function createMountains(): THREE.Group {
  const group = new THREE.Group();
  const ranges = [
    { radius: 950, height: 175, base: '#8a93c4', peak: '#e2dcef', seed: 11, haze: 0.45 },
    { radius: 640, height: 80, base: '#6d7aa6', peak: '#c7c3dc', seed: 23, haze: 0.25 },
  ];
  const sun = new THREE.Vector3();
  const color = new THREE.Color();
  for (const range of ranges) {
    const segments = 360;
    const rows = 6;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      const ridge = 1 - Math.abs(noise2(i * 0.06, range.seed) * 2 - 1);
      const peak = range.height * (0.35 + 0.65 * fbm(i * 0.035, range.seed, 5)) * (0.7 + 0.3 * ridge);
      for (let j = 0; j <= rows; j += 1) {
        const t = j / rows;
        const r = range.radius - t * 70 + noise2(i * 0.2, j + range.seed) * 25;
        positions.push(Math.cos(angle) * r, -60 + (peak + 60) * Math.pow(t, 0.8), Math.sin(angle) * r);
      }
    }
    for (let i = 0; i < segments; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const a = i * (rows + 1) + j;
        const b = a + rows + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal');
    const colors = new Float32Array(positions.length);
    const base = new THREE.Color(range.base);
    const peak = new THREE.Color(range.peak);
    for (let v = 0; v < normals.count; v += 1) {
      const height = THREE.MathUtils.clamp((positions[v * 3 + 1] + 20) / (range.height + 20), 0, 1);
      sun.set(normals.getX(v), normals.getY(v), normals.getZ(v));
      // Faces toward the camera side sit in shade; sun-facing slopes catch warm light.
      const lit = THREE.MathUtils.smoothstep(sun.dot(SUN_DIRECTION), -0.2, 0.5);
      color.copy(base).lerp(peak, height * 0.7).lerp(SUNLIT, lit * height * 0.5).multiplyScalar(0.8 + lit * 0.3);
      color.lerp(HORIZON, range.haze * (1 - height * 0.5));
      color.toArray(colors, v * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));
  }
  return group;
}

function paintCloud(rng: () => number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const puffs: [number, number, number][] = [];
  for (let i = 0; i < 26; i += 1) {
    const x = 70 + rng() * 372;
    const lift = Math.sin(((x - 70) / 372) * Math.PI);
    puffs.push([x, 200 - lift * (60 + rng() * 70), 26 + lift * (30 + rng() * 34)]);
  }
  // Shadowed underside first, sunlit cream on top: the key-art's cumulus.
  for (const [layer, offset, inner, outer] of [
    [0, 10, '#b6aec4', '#c8c0d0'],
    [1, 0, '#fff7e6', '#ead9c4'],
  ] as const) {
    for (const [x, y, r] of puffs) {
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4 - layer * 6, r * 0.1, x, y, r);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y + offset, r * (layer ? 0.92 : 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Flat base.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(0, 214, 512, 42);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createClouds(rng: () => number): THREE.Sprite[] {
  const textures = [paintCloud(rng), paintCloud(rng), paintCloud(rng)];
  const clouds: THREE.Sprite[] = [];
  for (let i = 0; i < 11; i += 1) {
    const material = new THREE.SpriteMaterial({ map: textures[i % 3], fog: false, depthWrite: false, opacity: 0.95 });
    const cloud = new THREE.Sprite(material);
    const angle = (i / 11) * Math.PI * 2 + rng() * 0.4;
    const distance = 1150 + rng() * 150;
    const width = 380 + rng() * 300;
    cloud.scale.set(width, width / 2, 1);
    cloud.position.set(Math.cos(angle) * distance, 200 + rng() * 260, Math.sin(angle) * distance);
    clouds.push(cloud);
  }
  return clouds;
}

function createTerrain(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(700, 700, 220, 220);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const meadow = new THREE.Color('#5f8f34');
  const lush = new THREE.Color('#3f7a2c');
  const golden = new THREE.Color('#c9ad52');
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, groundHeight(x, z));
    const r = Math.hypot(x, z);
    const gold = THREE.MathUtils.smoothstep(r, 25, 120) * (0.55 + 0.45 * fbm(x * 0.02, z * 0.02));
    color.copy(meadow).lerp(lush, fbm(x * 0.08 + 9, z * 0.08) * 0.8).lerp(golden, gold);
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true;
  return terrain;
}

/** The worn fighting ground in the middle of the meadow. */
function createDirtPatch(): THREE.Mesh {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size - 0.5;
      const v = y / size - 0.5;
      const edge = Math.hypot(u * 1.15, v) * 2 + (fbm(x * 0.02, y * 0.02) - 0.5) * 0.55;
      const alpha = THREE.MathUtils.smoothstep(1, 0.72, edge);
      const grain = fbm(x * 0.09, y * 0.09, 3);
      const i = (y * size + x) * 4;
      image.data[i] = 140 + grain * 50;
      image.data[i + 1] = 108 + grain * 40;
      image.data[i + 2] = 70 + grain * 26;
      image.data[i + 3] = alpha * 235;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const patch = new THREE.Mesh(
    new THREE.PlaneGeometry(9.5, 7.5),
    new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.y = 0.02;
  patch.receiveShadow = true;
  return patch;
}

function createGrass(rng: () => number, time: { value: number }, benders: GrassBenders): THREE.InstancedMesh {
  // One tapered three-segment blade; uv.y runs base to tip.
  const blade = new THREE.BufferGeometry();
  const w = [0.032, 0.026, 0.016, 0];
  const verts: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const t = i / 3;
    if (i < 3) verts.push(-w[i], t, 0, w[i], t, 0);
    else verts.push(0, 1, 0);
    if (i < 3) uvs.push(0, t, 1, t);
    else uvs.push(0.5, 1);
  }
  blade.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  blade.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]);

  const count = 60000;
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBase: { value: new THREE.Color('#355f22') },
        uTip: { value: new THREE.Color('#c9d873') },
        uSun: { value: SUN_DIRECTION },
      },
    ]),
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uBenderA, uBenderB;
      varying float vHeight;
      varying vec3 vTint;
      #include <fog_pars_vertex>
      vec3 bend(vec3 world, vec3 bender, float h) {
        vec3 away = world - bender; away.y = 0.0;
        float d = length(away);
        return d < 0.9 && d > 0.001 ? away / d * (0.9 - d) * h * 0.9 : vec3(0.0);
      }
      void main() {
        vHeight = uv.y;
        vTint = instanceColor;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        float h = uv.y * uv.y;
        float gust = sin(uTime * 1.7 + world.x * 0.35 + world.z * 0.22) + 0.5 * sin(uTime * 3.1 + world.z * 0.9);
        world.x += gust * 0.09 * h;
        world.z += gust * 0.05 * h;
        world.xyz += bend(world.xyz, uBenderA, h) + bend(world.xyz, uBenderB, h);
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uTip;
      varying float vHeight;
      varying vec3 vTint;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec3 col = mix(uBase, uTip, smoothstep(0.0, 1.0, vHeight)) * vTint;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  material.uniforms.uTime = time;
  material.uniforms.uBenderA = { value: benders.a };
  material.uniforms.uBenderB = { value: benders.b };

  const grass = new THREE.InstancedMesh(blade, material, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const tint = new THREE.Color();
  let placed = 0;
  while (placed < count) {
    // Denser near the arena, sparse on the far slopes.
    const r = Math.pow(rng(), 0.85) * 55;
    const angle = rng() * Math.PI * 2;
    spot.set(Math.cos(angle) * r * 1.0, 0, Math.sin(angle) * r);
    const dirt = Math.hypot(spot.x / 4.6, spot.z / 3.6) + (fbm(spot.x * 0.3, spot.z * 0.3) - 0.5) * 0.6;
    if (dirt < 1 && rng() > (dirt - 0.6) * 2.5) continue;
    spot.y = groundHeight(spot.x, spot.z);
    // Short, trampled grass where they fight; long grass past the boulder ring.
    const tall = THREE.MathUtils.smoothstep(r, 10, 15) * 0.5 + fbm(spot.x * 0.2, spot.z * 0.2) * 0.2;
    const height = 0.1 + tall * 0.8 + rng() * 0.1;
    euler.set((rng() - 0.5) * 0.5, rng() * Math.PI, (rng() - 0.5) * 0.5);
    quaternion.setFromEuler(euler);
    scale.set(0.9 + rng() * 0.6, height, 1);
    matrix.compose(spot, quaternion, scale);
    grass.setMatrixAt(placed, matrix);
    const warm = THREE.MathUtils.smoothstep(r, 14, 45) * 0.45 + fbm(spot.x * 0.12 + 5, spot.z * 0.12) * 0.35;
    const shade = 0.75 + rng() * 0.3;
    tint.setRGB(shade * (0.85 + warm * 0.45), shade * (0.92 + warm * 0.12), shade * (0.85 - warm * 0.25), THREE.SRGBColorSpace);
    grass.setColorAt(placed, tint);
    placed += 1;
  }
  grass.frustumCulled = false;
  return grass;
}

function petalTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.translate(32, 32);
  for (let i = 0; i < 5; i += 1) {
    ctx.rotate((Math.PI * 2) / 5);
    const g = ctx.createRadialGradient(0, -14, 2, 0, -14, 16);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#d8d8d8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -14, 11, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#3b2a12';
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Poppies, buttercups and daisies as tilted petal cards; lupines as spikes. Clustered like the key art. */
function createFlowers(rng: () => number): THREE.InstancedMesh[] {
  const heads = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.22, 0.22).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: petalTexture(), alphaTest: 0.5, side: THREE.DoubleSide, emissive: '#3a2a1a' }),
    1600,
  );
  const lupineGeometry = new THREE.ConeGeometry(0.05, 0.42, 6, 4);
  lupineGeometry.translate(0, 0.21, 0);
  const lupines = new THREE.InstancedMesh(lupineGeometry, new THREE.MeshLambertMaterial({ emissive: '#2c2050' }), 220);
  const palette = ['#ff4a26', '#ff4a26', '#ffd23a', '#ffd23a', '#fffaf0'].map((c) => new THREE.Color(c));
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const spot = new THREE.Vector3();
  const scale = new THREE.Vector3();

  const clusters = Array.from({ length: 34 }, () => {
    const angle = rng() * Math.PI * 2;
    const r = 8.5 + rng() * 14;
    return { x: Math.cos(angle) * r, z: Math.sin(angle) * r, kind: Math.floor(rng() * palette.length) };
  });
  for (let i = 0; i < heads.count; i += 1) {
    const cluster = clusters[i % clusters.length];
    spot.set(cluster.x + (rng() - 0.5) * 3.2, 0, cluster.z + (rng() - 0.5) * 3.2);
    spot.y = groundHeight(spot.x, spot.z) + 0.25 + rng() * 0.35;
    // Heads turn toward the sky at a tilt so they still read from a low camera.
    euler.set((rng() - 0.5) * 2, rng() * Math.PI * 2, (rng() - 0.5) * 2);
    quaternion.setFromEuler(euler);
    scale.setScalar(0.8 + rng() * 0.6);
    heads.setMatrixAt(i, matrix.compose(spot, quaternion, scale));
    heads.setColorAt(i, palette[(cluster.kind + (rng() < 0.2 ? 1 : 0)) % palette.length]);
  }
  for (let i = 0; i < lupines.count; i += 1) {
    const cluster = clusters[(i * 7) % clusters.length];
    spot.set(cluster.x + (rng() - 0.5) * 4, 0, cluster.z + (rng() - 0.5) * 4);
    spot.y = groundHeight(spot.x, spot.z) + 0.2;
    quaternion.setFromEuler(euler.set((rng() - 0.5) * 0.2, 0, (rng() - 0.5) * 0.2));
    scale.set(1, 0.8 + rng() * 0.8, 1);
    lupines.setMatrixAt(i, matrix.compose(spot, quaternion, scale));
    lupines.setColorAt(i, new THREE.Color().setHSL(0.72 + rng() * 0.08, 0.5, 0.55 + rng() * 0.15));
  }
  return [heads, lupines];
}

function boulderGeometry(rng: () => number, size: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  const position = geometry.getAttribute('position');
  const seed = rng() * 100;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    const lumps = 0.78 + fbm(v.x * 1.4 + seed, v.z * 1.4 + v.y * 1.1, 3) * 0.5;
    v.multiplyScalar(lumps);
    v.y = Math.max(v.y * 0.72, -0.25);
    position.setXYZ(i, v.x * size * 1.2, v.y * size, v.z * size);
  }
  geometry.computeVertexNormals();
  // Moss settles on the upward faces.
  const normal = geometry.getAttribute('normal');
  const colors = new Float32Array(position.count * 3);
  const stone = new THREE.Color('#b0a998');
  const moss = new THREE.Color('#7f9a3a');
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const mossy = THREE.MathUtils.smoothstep(normal.getY(i) + (noise2(position.getX(i) * 3, position.getZ(i) * 3) - 0.5) * 0.5, 0.68, 0.88);
    color.copy(stone).multiplyScalar(0.85 + noise2(position.getX(i) * 5 + seed, position.getY(i) * 5) * 0.25).lerp(moss, mossy);
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Mossy boulders ringing the fighting circle, plus a few big ones on the slopes. */
function createRocks(rng: () => number): THREE.Mesh[] {
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient });
  const rocks: THREE.Mesh[] = [];
  const place = (r: number, angle: number, size: number) => {
    const rock = new THREE.Mesh(boulderGeometry(rng, size), material);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    rock.position.set(x, groundHeight(x, z) - size * 0.1, z);
    rock.rotation.y = rng() * Math.PI * 2;
    rock.castShadow = rock.receiveShadow = true;
    addOutline(rock, 0.03);
    rocks.push(rock);
  };
  for (let i = 0; i < 10; i += 1) place(13.6 + rng() * 2.2, (i / 10) * Math.PI * 2 + rng() * 0.4, 0.55 + rng() * 0.6);
  for (let i = 0; i < 7; i += 1) place(20 + rng() * 14, rng() * Math.PI * 2, 1.2 + rng() * 1.4);
  return rocks;
}

function moteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

/** Drifting pollen catching the low sun. */
function createMotes(rng: () => number): THREE.Points {
  const count = 260;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = Math.sqrt(rng()) * 18;
    const angle = rng() * Math.PI * 2;
    positions.set([Math.cos(angle) * r, 0.4 + rng() * 3.5, Math.sin(angle) * r], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: '#fff1c4',
      map: moteTexture(),
      size: 0.08,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}
