import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_RADIUS } from '../game/tuning';
import { createSeededRandom } from '../utils/random';
import { fbm, noise2 } from './noise';
import { CELL, CELLS, SEA_LEVEL, WORLD_SIZE, groundHeight, groundSlope, heights } from './terrain';
import { addOutline, toonGradient } from './toon';

/** Late-afternoon sun, shared by the light rig, sky and far layers. */
export const SUN_DIRECTION = new THREE.Vector3(-0.8, 0.36, 0.45).normalize();
const HORIZON = new THREE.Color('#f3dfb8');
const SUNLIT = new THREE.Color('#ffe2b8');

/** Side of the square the map shows, m: the island and its shallows. */
export const MAP_SIZE = 840;
/** Something solid to walk round, a tree's trunk or a boulder: a circle on the ground. */
export type Obstacle = { x: number; z: number; radius: number; trunk: boolean };
/** What the shaders read of the land, the two bodies that part the grass, and the middle of the grass patch. */
type Uniforms = Record<'uTime' | 'uLand' | 'uHeight' | 'uWanderer' | 'uOther' | 'uPatch', { value: unknown }>;

/** The terrain grid as a texture, a texel to a vertex. */
function gridTexture(data: Float32Array, format: THREE.PixelFormat): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, CELLS + 1, CELLS + 1, format, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
/** GLSL: where the grid textures hold the ground at world (x, z). */
const LAND_UV = /* glsl */ `vec2 landUv(vec2 spot) { return (spot / ${CELL.toFixed(4)} + ${((CELLS + 1) / 2).toFixed(1)}) / ${(CELLS + 1).toFixed(1)}; }`;

export class World {
  readonly group = new THREE.Group();
  readonly obstacles: Obstacle[] = [];
  private readonly time = { value: 0 };
  private readonly motes: THREE.Points;
  private readonly patch = new THREE.Vector3();
  /** Each terrain vertex's colour, as the map paints it. */
  private readonly ground: Float32Array;

  /** The pollen keeps to `wanderer`, who parts the grass, as `other` does. */
  constructor(
    private readonly wanderer: THREE.Vector3,
    other: THREE.Vector3,
  ) {
    const rng = createSeededRandom(7);
    const { terrain, land } = createTerrain();
    this.ground = terrain.geometry.getAttribute('color').array as Float32Array;
    const uniforms: Uniforms = {
      uTime: this.time,
      uLand: { value: gridTexture(land, THREE.RGBAFormat) },
      uHeight: { value: gridTexture(heights, THREE.RedFormat) },
      uWanderer: { value: wanderer },
      uOther: { value: other },
      uPatch: { value: this.patch },
    };
    this.group.add(createSky(), createMountains(), ...createClouds(rng), terrain, createWater(uniforms));
    this.group.add(createGrass(rng, uniforms), createFlowers(rng, land), ...createRocks(rng, this.obstacles));
    this.group.add(...createTrees(rng, land, this.obstacles));
    this.motes = createMotes(rng);
    this.group.add(this.motes);
  }

  /** The grass grows in front of `camera`: the patch reaches from just behind it to as far as blades show. */
  update(elapsed: number, camera: THREE.Camera): void {
    this.time.value = elapsed;
    this.motes.rotation.y = elapsed * 0.01;
    this.motes.position.copy(this.wanderer).y += Math.sin(elapsed * 0.3) * 0.3;
    camera.getWorldDirection(this.patch).setY(0).setLength(PATCH / 2 - 2).add(camera.position);
  }

  /** Paints the island from above: the land in its own colours, shaded by its slopes, in a sea deepening off the shore. */
  paintMap(canvas: HTMLCanvasElement): void {
    const size = (canvas.width = canvas.height = MAP_SIZE / CELL);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = ctx.createImageData(size, size);
    const color = new THREE.Color();
    const first = (CELLS - size) / 2;
    for (let p = 0; p < size * size; p += 1) {
      const i = (first + Math.floor(p / size)) * (CELLS + 1) + first + (p % size);
      const depth = SEA_LEVEL - heights[i];
      if (depth > 0) color.copy(SHALLOWS).lerp(DEEP, THREE.MathUtils.smoothstep(depth, 0, 8));
      // Lit from the north-west, as maps are.
      else color.fromArray(this.ground, i * 3).multiplyScalar(THREE.MathUtils.clamp(1 + (heights[i] - heights[i + CELLS + 2]) * 0.12, 0.6, 1.4));
      image.data.set([...color.convertLinearToSRGB().toArray().map((c) => c * 255), 255], p * 4);
    }
    ctx.putImageData(image, 0, 0);
  }
}

/** How thickly grass grows at the terrain vertex nearest (x, z). */
function coverAt(land: Float32Array, x: number, z: number): number {
  return land[(Math.round((z + WORLD_SIZE / 2) / CELL) * (CELLS + 1) + Math.round((x + WORLD_SIZE / 2) / CELL)) * 4 + 3];
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
const WOODS = new THREE.Color('#3f6b2c');
const SAND = new THREE.Color('#f7e7bd').multiplyScalar(1.25);
const ROCK = new THREE.Color('#c4bcaa');
const SLATE = new THREE.Color('#8f8f9c');
const SHALLOWS = new THREE.Color('#7fd3c4');
const DEEP = new THREE.Color('#2c6c9c');
const EARTH = new THREE.Color('#8c7a4e');
const far = new THREE.Color();
const rock = new THREE.Color();
const slope = new THREE.Vector2();

/** How wooded the land is at (x, z), 0 to 1: groves with open country between them, and none on the hilltop. */
function woods(x: number, z: number): number {
  return THREE.MathUtils.smoothstep(fbm(x * 0.007 + 50, z * 0.007 - 30), 0.58, 0.68) * THREE.MathUtils.smoothstep(Math.hypot(x, z), 50, 90);
}

/**
 * The land at (x, z): its grass's colour into `grass`, and the ground's into `ground`, which is the grass's where
 * grass covers it, so the meadow's green is its grass. Returns how thickly grass grows there, 0 to 1: thinly under
 * trees, and not at all on sand, rock or the beds of the waters.
 */
function groundColor(x: number, z: number, grass: THREE.Color, ground: THREE.Color): number {
  const height = groundHeight(x, z);
  grass.copy(MEADOW).lerp(LUSH, fbm(x * 0.08 + 9, z * 0.08) * 0.8);
  ground.copy(grass);
  const distance = THREE.MathUtils.smoothstep(Math.hypot(x, z), 25, 90);
  if (distance === 0) return 1;
  // Beyond the hilltop: a patchwork of sage, gold and ochre, lighter on the crests.
  far.copy(SAGE).lerp(GOLDEN, THREE.MathUtils.smoothstep(fbm(x * 0.015, z * 0.015), 0.35, 0.6));
  far.lerp(OCHRE, THREE.MathUtils.smoothstep(fbm(x * 0.03 + 4, z * 0.03), 0.55, 0.75) * 0.6);
  far.multiplyScalar(0.8 + 0.3 * THREE.MathUtils.smoothstep(height, -12, 22));
  const wooded = woods(x, z) * 0.7;
  // Crags: steep ground is bare, and the heights more readily so, along a ragged edge.
  const bare = THREE.MathUtils.smoothstep(groundSlope(x, z, slope).length() + height * 0.004 + fbm(x * 0.07, z * 0.07) * 0.45, 0.62, 1.02);
  const sandy = 1 - THREE.MathUtils.smoothstep(height - SEA_LEVEL + fbm(x * 0.05, z * 0.05), 0.9, 2.2);
  grass.lerp(far.lerp(WOODS, wooded), distance);
  // Where the grass gives out, tufts of it stand in dry earth before the rock is bare.
  rock.copy(ROCK).lerp(SLATE, fbm(x * 0.04 + 70, z * 0.04));
  ground.copy(grass).lerp(rock, bare).lerp(EARTH, bare * (1 - bare) * 2.6).lerp(SAND, sandy);
  return (1 - bare) * (1 - sandy) * (1 - wooded);
}

/** The terrain, and `land`: each vertex's grass colour and, as alpha, how thickly it grows there. */
function createTerrain(): { terrain: THREE.Mesh; land: Float32Array } {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, CELLS, CELLS);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const land = new Float32Array(position.count * 4);
  const [grass, ground] = [new THREE.Color(), new THREE.Color()];
  for (let i = 0; i < position.count; i += 1) {
    position.setY(i, heights[i]);
    land[i * 4 + 3] = groundColor(position.getX(i), position.getZ(i), grass, ground);
    grass.toArray(land, i * 4);
    ground.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true;
  return { terrain, land };
}

/**
 * Side of the grass patch, m. It tiles the land, and each blade stands in the tile that puts it nearest the patch's
 * middle, ahead of the camera: blades are only drawn where they can be seen.
 */
const PATCH = 34;
/** Blades thin out from the first of these distances from the camera, m, to none at the second. */
const GRASS_REACH = [20, 30];

function createGrass(rng: () => number, uniforms: Uniforms): THREE.InstancedMesh {
  // One blade: a thin strip narrowing to a blunt tip, shaded at the root and sunlit at the tip. Its normals
  // point up, so it lights exactly like the ground beneath and the blades blend into one carpet.
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.01, 0, 0, 0.01, 0, 0, -0.004, 1, 0.1, 0.004, 1, 0.1], 3));
  blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  blade.setAttribute('color', new THREE.Float32BufferAttribute([0.72, 0.76, 0.7, 0.72, 0.76, 0.7, 1.28, 1.26, 0.9, 1.28, 1.26, 0.9], 3));
  blade.setIndex([0, 1, 2, 2, 1, 3]);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = /* glsl */ `
      uniform float uTime;
      uniform vec3 uWanderer, uOther, uPatch;
      uniform sampler2D uLand, uHeight;
      ${LAND_UV}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      // Feet part the grass: tips lean away from a fighter standing in it.
      vec3 bend(vec3 world, vec3 bender, float push) {
        vec3 away = world - bender; away.y = 0.0;
        float d = length(away);
        return d > 0.001 ? away / d * push * max(0.0, 1.0 - d / 0.55) : vec3(0.0);
      }
      ${shader.vertexShader}`
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
      vec2 root = instanceMatrix[3].xz;
      vec2 spot = uPatch.xz + mod(root - uPatch.xz + ${(PATCH / 2).toFixed(1)}, ${PATCH.toFixed(1)}) - ${(PATCH / 2).toFixed(1)};
      vec4 land = texture2D(uLand, landUv(spot));
      // Far blades are fewer and broader, covering as much; they thin to none with distance, and at the patch's
      // edge, where the tiles meet.
      float away = distance(spot, cameraPosition.xz);
      vec2 edge = abs(spot - uPatch.xz) / ${(PATCH / 2).toFixed(1)};
      float sparse = mix(1.0, 0.2, smoothstep(4.0, 16.0, away));
      float shown = sparse * (1.0 - smoothstep(${GRASS_REACH[0].toFixed(1)}, ${GRASS_REACH[1].toFixed(1)}, away)) * (1.0 - smoothstep(0.85, 1.0, max(edge.x, edge.y)));
      // Where the land grows less grass, it stands in tufts, never as stray blades.
      float tuft = (hash(floor(spot * 1.3)) + hash(floor(spot * 3.1 + 5.0))) * 0.4 + hash(root + 7.0) * 0.2;
      float grows = step(hash(root), shown) * step(tuft, smoothstep(0.1, 0.75, land.a));
      vec4 world = instanceMatrix * vec4(transformed * vec3(grows * inversesqrt(sparse), grows, grows), 1.0);
      world.xz += spot - root;
      world.y += texture2D(uHeight, landUv(spot)).r;
      vColor.rgb *= land.rgb;
      float tip = position.y * position.y * length(instanceMatrix[1].xyz);
      float gust = sin(uTime * 1.7 + world.x * 0.35 + world.z * 0.22) + 0.5 * sin(uTime * 3.1 + world.z * 0.9);
      world.xz += vec2(0.35, 0.2) * gust * tip;
      world.xyz += bend(world.xyz, uWanderer, tip * 1.3) + bend(world.xyz, uOther, tip * 1.3);
      // A passing gust lifts the tips into the light.
      vColor *= 1.0 + 0.1 * max(gust, 0.0) * position.y;
      vec4 mvPosition = viewMatrix * world;
      gl_Position = projectionMatrix * mvPosition;`,
      )
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = world;');
    // Both faces keep the upward normal: a back-facing blade is lit like a front-facing one.
    shader.fragmentShader = `#undef DOUBLE_SIDED\n${shader.fragmentShader}`;
  };

  const count = 380000;
  const grass = new THREE.InstancedMesh(blade, material, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  const spot = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let placed = 0; placed < count; placed += 1) {
    spot.set((rng() - 0.5) * PATCH, 0, (rng() - 0.5) * PATCH);
    // A few centimetres, a little longer in soft patches.
    const height = 0.06 + fbm(spot.x * 0.25, spot.z * 0.25) * 0.07 + rng() * 0.03;
    euler.set((rng() - 0.5) * 0.7, rng() * Math.PI * 2, (rng() - 0.5) * 0.7);
    quaternion.setFromEuler(euler);
    scale.set(0.85 + rng() * 0.7, height, 1);
    grass.setMatrixAt(placed, matrix.compose(spot, quaternion, scale));
    grass.setColorAt(placed, tint.setScalar(0.88 + rng() * 0.24));
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
function createFlowers(rng: () => number, land: Float32Array): THREE.Points {
  const count = 120000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = ['#fffaf0', '#fffaf0', '#ffe27a', '#ffc4cf', '#cdd6ff'].map((c) => new THREE.Color(c));
  let placed = 0;
  while (placed < count) {
    const x = (rng() - 0.5) * MAP_SIZE;
    const z = (rng() - 0.5) * MAP_SIZE;
    // Drifts: flowers gather in the grass where the noise rises, each drift mostly one kind.
    if (rng() > THREE.MathUtils.smoothstep(fbm(x * 0.09 + 31, z * 0.09), 0.5, 0.7) * THREE.MathUtils.smoothstep(coverAt(land, x, z), 0.5, 0.8)) continue;
    positions.set([x, groundHeight(x, z) + 0.08 + rng() * 0.07, z], placed * 3);
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

/** Mossy boulders ringing the fighting circle, a few big ones on its slopes, and more strewn over the island, most on high ground. */
function createRocks(rng: () => number, obstacles: Obstacle[]): THREE.Mesh[] {
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient });
  const rocks: THREE.Mesh[] = [];
  const place = (x: number, z: number, size: number) => {
    const rock = new THREE.Mesh(boulderGeometry(rng, size), material);
    rock.position.set(x, groundHeight(x, z) - size * 0.1, z);
    rock.rotation.y = rng() * Math.PI * 2;
    rock.castShadow = rock.receiveShadow = true;
    addOutline(rock, 0.03);
    rocks.push(rock);
    obstacles.push({ x, z, radius: size, trunk: false });
  };
  const ring = (r: number, angle: number, size: number) => place(Math.cos(angle) * r, Math.sin(angle) * r, size);
  for (let i = 0; i < 10; i += 1) ring(ARENA_RADIUS + 1.6 + rng() * 2.2, (i / 10) * Math.PI * 2 + rng() * 0.4, 0.55 + rng() * 0.6);
  for (let i = 0; i < 7; i += 1) ring(20 + rng() * 14, rng() * Math.PI * 2, 1.2 + rng() * 1.4);
  while (rocks.length < 90) {
    const [x, z] = [(rng() - 0.5) * MAP_SIZE, (rng() - 0.5) * MAP_SIZE];
    const height = groundHeight(x, z);
    if (Math.hypot(x, z) > 45 && height > SEA_LEVEL && rng() < 0.15 + height * 0.03) place(x, z, 0.7 + rng() * 2);
  }
  return rocks;
}

/**
 * A tree, 1 m tall before its instance scales it: a trunk flaring at the root and forking into boughs, under billows of
 * leaves, or a fir's ragged tiers.
 */
function treeGeometry(rng: () => number, fir: boolean): THREE.BufferGeometry {
  const [color, lit, v] = [new THREE.Color(), new THREE.Color(), new THREE.Vector3()];
  // Each part is lit from above and shaded beneath, dappled, and takes `shape` to its vertices.
  const part = (geometry: THREE.BufferGeometry, low: string, high: string, shape: (v: THREE.Vector3) => void = () => {}) => {
    geometry.deleteAttribute('uv');
    const [position, normal] = [geometry.getAttribute('position'), geometry.getAttribute('normal')];
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      shape(v.fromBufferAttribute(position, i));
      position.setXYZ(i, v.x, v.y, v.z);
      const dapple = fbm(v.x * 9 + 5, v.z * 9 + v.y * 7, 2) - 0.5;
      color.set(low).lerp(lit.set(high), THREE.MathUtils.clamp(normal.getY(i) * 0.5 + 0.5 + dapple * 0.7, 0, 1)).toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry.index ? geometry.toNonIndexed() : geometry;
  };
  const bough = (height: number, lean: number, turn: number) =>
    part(new THREE.CylinderGeometry(0.012, 0.022, 0.26, 5).translate(0, 0.13, 0).rotateZ(lean).rotateY(turn).translate(0, height, 0), '#4f3524', '#7a5639');
  const parts: THREE.BufferGeometry[] = [];
  if (fir) {
    parts.push(part(new THREE.CylinderGeometry(0.018, 0.045, 0.6, 7).translate(0, 0.3, 0), '#4a3323', '#6f4e36'));
    for (let tier = 0; tier < 6; tier += 1) {
      const [radius, base] = [0.3 - tier * 0.043, 0.2 + tier * 0.135];
      // A skirt of drooping, uneven boughs: every other point of the rim hangs out and down.
      const skirt = new THREE.ConeGeometry(radius, 0.3, 14).translate(0, base + 0.15, 0);
      parts.push(
        part(skirt, '#1f3d2a', '#55834a', (p) => {
          if (p.y > base + 0.01) return;
          const out = Math.round((Math.atan2(p.z, p.x) / Math.PI) * 7) % 2 ? 1.18 : 0.78;
          p.set(p.x * out, p.y - (out - 0.9) * 0.12, p.z * out);
        }),
      );
    }
  } else {
    parts.push(
      part(new THREE.CylinderGeometry(0.03, 0.05, 0.5, 8, 4).translate(0, 0.25, 0), '#4f3524', '#7a5639', (p) => {
        // Roots flare, and the trunk leans a little as it climbs.
        const flare = 1 + 0.9 * (1 - THREE.MathUtils.smoothstep(p.y, 0, 0.14));
        p.set(p.x * flare + p.y * p.y * 0.12, p.y, p.z * flare);
      }),
    );
    for (let i = 0; i < 3; i += 1) parts.push(bough(0.4 + i * 0.03, 0.7 + rng() * 0.3, i * 2.1 + rng()));
    for (let billow = 0; billow < 11; billow += 1) {
      // One big billow on top, smaller ones crowding round and under it.
      const [out, angle, radius] = [billow && 0.14 + rng() * 0.14, billow * 2.4 + rng() * 0.5, billow ? 0.1 + rng() * 0.09 : 0.25];
      const centre = new THREE.Vector3(Math.cos(angle) * out, (billow ? 0.5 : 0.74) + rng() * 0.2, Math.sin(angle) * out);
      const seed = rng() * 50;
      parts.push(
        part(new THREE.IcosahedronGeometry(radius, billow ? 2 : 3), '#32602a', '#a6c455', (p) => {
          // Softly lumpy, flatter beneath than above.
          p.multiplyScalar(0.88 + fbm(p.x * 6 + seed, p.z * 6 + p.y * 5, 2) * 0.26);
          p.y *= p.y < 0 ? 0.6 : 0.9;
          p.add(centre);
        }),
      );
    }
  }
  const tree = mergeVertices(mergeGeometries(parts));
  tree.computeVertexNormals();
  return tree;
}

/** Groves of broadleaves on the low ground and of firs on the heights, open country with the odd lone tree between them; none on the hilltop. */
function createTrees(rng: () => number, land: Float32Array, obstacles: Obstacle[]): THREE.InstancedMesh[] {
  // Two broadleaves and a fir.
  const kinds = [false, false, true].map((fir) => ({ geometry: treeGeometry(rng, fir), spots: [] as THREE.Matrix4[] }));
  const trees: Obstacle[] = [];
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let tries = 0; tries < 40000; tries += 1) {
    const [x, z] = [(rng() - 0.5) * MAP_SIZE, (rng() - 0.5) * MAP_SIZE];
    // Trees stand where grass can, clear of each other, thickest in the heart of a grove.
    if (Math.hypot(x, z) < 45 || coverAt(land, x, z) < 0.2 || rng() > 0.0008 + woods(x, z) ** 2 || trees.some((tree) => Math.hypot(tree.x - x, tree.z - z) < 4)) continue;
    const height = groundHeight(x, z);
    const fir = rng() < THREE.MathUtils.smoothstep(height, 6, 16);
    const size = (fir ? 10 : 8) * (0.75 + rng() * 0.6);
    kinds[fir ? 2 : Math.floor(rng() * 2)].spots.push(
      new THREE.Matrix4().compose(new THREE.Vector3(x, height - 0.1, z), quaternion.setFromAxisAngle(up, rng() * Math.PI * 2), new THREE.Vector3(size, size, size)),
    );
    trees.push({ x, z, radius: size * 0.05, trunk: true });
  }
  obstacles.push(...trees);
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient });
  const tint = new THREE.Color();
  return kinds.map(({ geometry, spots }) => {
    const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
    spots.forEach((spot, i) => {
      mesh.setMatrixAt(i, spot);
      mesh.setColorAt(i, tint.setScalar(0.85 + rng() * 0.3));
    });
    mesh.castShadow = mesh.receiveShadow = true;
    addOutline(mesh, 0.004);
    return mesh;
  });
}

/** The sea, the lake and the river: one sheet, clear over the shallows and deepening to blue, with foam lapping its shores. */
function createWater(uniforms: Uniforms): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ transparent: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uShallows: { value: SHALLOWS }, uDeep: { value: DEEP } });
    shader.vertexShader = `varying vec2 vSpot;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      vSpot = (modelMatrix * vec4(position, 1.0)).xz;`,
    );
    shader.fragmentShader = /* glsl */ `
      uniform float uTime;
      uniform sampler2D uHeight;
      uniform vec3 uShallows, uDeep;
      varying vec2 vSpot;
      ${LAND_UV}
      float ripple(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        vec4 h = fract(sin(vec4(dot(i, vec2(127.1, 311.7)), dot(i + vec2(1, 0), vec2(127.1, 311.7)), dot(i + vec2(0, 1), vec2(127.1, 311.7)), dot(i + 1.0, vec2(127.1, 311.7)))) * 43758.5453);
        return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
      }
      ${shader.fragmentShader}`.replace(
      '#include <color_fragment>',
      /* glsl */ `
      float depth = ${SEA_LEVEL.toFixed(1)} - texture2D(uHeight, landUv(vSpot)).r;
      float waves = ripple(vSpot * vec2(0.5, 1.9) + uTime * 0.25) + ripple(vSpot * vec2(1.3, 4.1) - uTime * 0.4);
      // Glints, long and thin, where two swells cross, fading before distance turns them to speckle; and a line of
      // foam that breathes in and out along the shore.
      float glint = smoothstep(1.5, 1.56, waves) * 0.6 * (1.0 - smoothstep(60.0, 220.0, vFogDepth));
      float foam = 1.0 - smoothstep(0.0, 0.22 + 0.14 * sin(uTime * 1.3 + waves * 3.0), depth);
      diffuseColor.rgb = mix(mix(uShallows, uDeep, smoothstep(0.0, 5.0, depth)), vec3(1.0), max(glint, foam * 0.85));
      diffuseColor.a = mix(0.55, 0.94, max(smoothstep(0.0, 3.0, depth), foam));`,
    );
  };
  const water = new THREE.Mesh(new THREE.CircleGeometry(1400, 64).rotateX(-Math.PI / 2), material);
  water.position.y = SEA_LEVEL;
  return water;
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
