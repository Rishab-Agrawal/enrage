import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';
import { fbm, noise2 } from './noise';
import { addOutline, toonGradient } from './toon';

/** Late-afternoon sun, shared by the light rig, sky and far layers. */
export const SUN_DIRECTION = new THREE.Vector3(-0.8, 0.36, 0.45).normalize();
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
    this.group.add(createGrass(rng, this.time, benders), createFlowers(rng), ...createRocks(rng));
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
      // Noise sampled around a circle, so the range closes on itself without a seam.
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      const ridge = 1 - Math.abs(noise2(c * 3.4 + range.seed, s * 3.4) * 2 - 1);
      const peak = range.height * (0.35 + 0.65 * fbm(c * 2 + range.seed, s * 2, 5)) * (0.7 + 0.3 * ridge);
      for (let j = 0; j <= rows; j += 1) {
        const t = j / rows;
        const r = range.radius - t * 70 + noise2(c * 11.5 + j, s * 11.5 + range.seed) * 25;
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

const MEADOW = new THREE.Color('#7aa443');
const LUSH = new THREE.Color('#467a2e');
const SAGE = new THREE.Color('#8fa64f');
const GOLDEN = new THREE.Color('#dcbc62');
const OCHRE = new THREE.Color('#bf9447');
const far = new THREE.Color();

/** The land's colour at (x, z): the grass takes it too, so the meadow's green is its grass. */
function groundColor(x: number, z: number, target: THREE.Color): THREE.Color {
  target.copy(MEADOW).lerp(LUSH, fbm(x * 0.08 + 9, z * 0.08) * 0.8);
  const distance = THREE.MathUtils.smoothstep(Math.hypot(x, z), 25, 90);
  if (distance === 0) return target;
  // Far hills: a patchwork of sage, gold and ochre, lighter on the crests.
  far.copy(SAGE).lerp(GOLDEN, THREE.MathUtils.smoothstep(fbm(x * 0.015, z * 0.015), 0.35, 0.6));
  far.lerp(OCHRE, THREE.MathUtils.smoothstep(fbm(x * 0.03 + 4, z * 0.03), 0.55, 0.75) * 0.6);
  far.multiplyScalar(0.8 + 0.3 * THREE.MathUtils.smoothstep(groundHeight(x, z), -12, 22));
  return target.lerp(far, distance);
}

function createTerrain(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(700, 700, 220, 220);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, groundHeight(x, z));
    groundColor(x, z, color).toArray(colors, i * 3);
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
  // One blade: a single tapered triangle, shaded at the root and sunlit at the tip. Its normals point
  // up, so it lights exactly like the ground beneath and the blades blend into one carpet.
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.035, 0, 0, 0.035, 0, 0, 0, 1, 0.12], 3));
  blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  blade.setAttribute('color', new THREE.Float32BufferAttribute([0.6, 0.66, 0.6, 0.6, 0.66, 0.6, 1.36, 1.32, 0.86], 3));

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: time, uBenderA: { value: benders.a }, uBenderB: { value: benders.b } });
    shader.vertexShader = /* glsl */ `
      uniform float uTime;
      uniform vec3 uBenderA, uBenderB;
      // Feet part the grass: tips lean away from a fighter standing in it.
      vec3 bend(vec3 world, vec3 bender, float push) {
        vec3 away = world - bender; away.y = 0.0;
        float d = length(away);
        return d > 0.001 ? away / d * push * max(0.0, 1.0 - d / 0.55) : vec3(0.0);
      }
      ${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 world = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      float tip = position.y * position.y * length(instanceMatrix[1].xyz);
      float gust = sin(uTime * 1.7 + world.x * 0.35 + world.z * 0.22) + 0.5 * sin(uTime * 3.1 + world.z * 0.9);
      world.xz += vec2(0.35, 0.2) * gust * tip;
      world.xyz += bend(world.xyz, uBenderA, tip * 1.3) + bend(world.xyz, uBenderB, tip * 1.3);
      // A passing gust lifts the tips into the light.
      vColor *= 1.0 + 0.1 * max(gust, 0.0) * position.y;
      vec4 mvPosition = viewMatrix * world;
      gl_Position = projectionMatrix * mvPosition;`,
    );
    // Both faces keep the upward normal: a back-facing blade is lit like a front-facing one.
    shader.fragmentShader = `#undef DOUBLE_SIDED\n${shader.fragmentShader}`;
  };

  const count = 300000;
  const grass = new THREE.InstancedMesh(blade, material, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const tint = new THREE.Color();
  let placed = 0;
  while (placed < count) {
    // A dense carpet across the playable meadow, thinning out where the camera never reaches.
    const r = Math.sqrt(rng()) * 36;
    if (rng() > 1 - THREE.MathUtils.smoothstep(r, 18, 36)) continue;
    const angle = rng() * Math.PI * 2;
    spot.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
    const dirt = Math.hypot(spot.x / 4.6, spot.z / 3.6) + (fbm(spot.x * 0.3, spot.z * 0.3) - 0.5) * 0.6;
    if (dirt < 1 && rng() > (dirt - 0.6) * 2.5) continue;
    spot.y = groundHeight(spot.x, spot.z);
    // Ankle-high, a little longer in soft patches.
    const height = 0.1 + fbm(spot.x * 0.25, spot.z * 0.25) * 0.14 + rng() * 0.06;
    euler.set((rng() - 0.5) * 0.7, rng() * Math.PI * 2, (rng() - 0.5) * 0.7);
    quaternion.setFromEuler(euler);
    scale.set(0.7 + rng() * 0.6, height, 1);
    grass.setMatrixAt(placed, matrix.compose(spot, quaternion, scale));
    grass.setColorAt(placed, groundColor(spot.x, spot.z, tint).multiplyScalar(0.88 + rng() * 0.24));
    placed += 1;
  }
  grass.frustumCulled = false;
  grass.receiveShadow = true;
  return grass;
}

/** A soft five-petal head, white so each instance tints it. */
function petalTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.translate(32, 32);
  for (let i = 0; i < 5; i += 1) {
    ctx.rotate((Math.PI * 2) / 5);
    const g = ctx.createRadialGradient(0, -6, 2, 0, -14, 18);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#ece4dc');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -15, 12, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const heart = ctx.createRadialGradient(-1, -1, 0, 0, 0, 8);
  heart.addColorStop(0, '#fff3b0');
  heart.addColorStop(1, '#e8b850');
  ctx.fillStyle = heart;
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Daisies, buttercups, clover and speedwell in loose drifts: soft dots of colour on the grass tips, as in a painted meadow. */
function createFlowers(rng: () => number): THREE.Points {
  const count = 3500;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = ['#fffaf0', '#fffaf0', '#ffe27a', '#ffc4cf', '#cdd6ff'].map((c) => new THREE.Color(c));
  let placed = 0;
  while (placed < count) {
    const r = 5 + Math.sqrt(rng()) * 30;
    const angle = rng() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // Drifts: flowers gather where the noise rises, each drift mostly one kind.
    if (rng() > THREE.MathUtils.smoothstep(fbm(x * 0.09 + 31, z * 0.09), 0.5, 0.7)) continue;
    positions.set([x, groundHeight(x, z) + 0.16 + rng() * 0.12, z], placed * 3);
    palette[Math.floor(fbm(x * 0.05 - 17, z * 0.05) * 2 * palette.length + rng() * 1.5) % palette.length].toArray(colors, placed * 3);
    placed += 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ map: petalTexture(), vertexColors: true, size: 0.24, alphaTest: 0.5 }));
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
