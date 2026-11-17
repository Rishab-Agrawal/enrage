import * as THREE from 'three';

/** Seconds of daylight and of night: a full day is both. */
const DAY = 600;
const NIGHT = 600;
/** Seconds after sunrise at which the game opens: a golden early morning. */
const OPENS = 75;
const MOONLIGHT = new THREE.Color('#b4ccff');
/** Shadows fall within this far of the wanderer, m: as far as the haze lets them show. */
const SHADOW_REACH = 150;
/** The light stands this far off, m, clear of the heights between. */
const LIGHT_DISTANCE = 260;

/** Seconds from `seconds` into the game to the next noon, or midnight. */
export function secondsTo(hour: 'noon' | 'midnight', seconds: number): number {
  const wait = (hour === 'noon' ? DAY / 2 : DAY + NIGHT / 2) - ((seconds + OPENS) % (DAY + NIGHT));
  return wait > 0 ? wait : wait + DAY + NIGHT;
}

/** How the sky and its light look at an hour: the dome from the top down, the haze, the sun's light, and the light off the sky and the ground. */
type Hour = Record<'top' | 'mid' | 'horizon' | 'fog' | 'sun' | 'above' | 'below' | 'tint', THREE.Color> & { ambient: number };
const hour = (ambient: number, colors: Record<Exclude<keyof Hour, 'ambient'>, string>): Hour =>
  Object.assign(Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, new THREE.Color(color)])) as Omit<Hour, 'ambient'>, { ambient });
/** `tint` is what the hour does to colours no light falls on: clouds, far ranges, water, flowers. */
const NOON = hour(1.2, { top: '#5d8fd0', mid: '#a9c7e6', horizon: '#f3dfb8', fog: '#ead9b8', sun: '#ffd49a', above: '#c8d8f0', below: '#7d7a3e', tint: '#ffffff' });
const TWILIGHT = hour(0.8, { top: '#4a4f8f', mid: '#c98a9a', horizon: '#ffb37a', fog: '#e8a987', sun: '#ff9a5c', above: '#b9a4c9', below: '#6b5a44', tint: '#e0a48c' });
const MIDNIGHT = hour(1.5, { top: '#102a58', mid: '#1c4a7c', horizon: '#34709a', fog: '#2a5884', sun: '#b4ccff', above: '#8aa6e0', below: '#40506e', tint: '#7088c4' });

/**
 * The sky and its light through day and night. The sun rises in the east, crosses to the south and sets in the west;
 * through the night the moon follows the same road, under stars. Whichever is up lights the land and casts its shadows.
 */
export class Sky {
  readonly group = new THREE.Group();
  readonly fog = new THREE.Fog('#ead9b8', 70, 650);
  readonly tint = new THREE.Color();
  /** How far into night it is, 0 by day to 1. */
  night = 0;
  private readonly light = new THREE.DirectionalLight();
  private readonly ambient = new THREE.HemisphereLight();
  private readonly uniforms = {
    uTop: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector3() },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };

  constructor() {
    const { light } = this;
    light.castShadow = true;
    light.shadow.mapSize.set(4096, 4096);
    Object.assign(light.shadow.camera, { left: -SHADOW_REACH, right: SHADOW_REACH, top: SHADOW_REACH, bottom: -SHADOW_REACH, near: 1, far: LIGHT_DISTANCE * 2 });
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0.12;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1400, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop, uMid, uHorizon, uSun;
          uniform float uNight, uTime;
          varying vec3 vDir;
          void main() {
            vec3 dir = normalize(vDir);
            float h = max(dir.y, 0.0);
            vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.18, h));
            col = mix(col, uTop, smoothstep(0.18, 0.75, h));
            float sun = max(dot(dir, uSun), 0.0);
            col += vec3(1.0, 0.85, 0.6) * (pow(sun, 6.0) * 0.35 + pow(sun, 60.0) * 0.6) * (1.0 - uNight);
            // The moon, opposite the sun, in its own soft glow.
            float moon = max(dot(dir, -uSun), 0.0);
            col += vec3(0.75, 0.82, 1.0) * (smoothstep(0.9993, 0.9996, moon) + pow(moon, 40.0) * 0.12) * uNight;
            // Stars: the odd cell of a fine grid over the sky is lit, and twinkles.
            float star = fract(sin(dot(floor(dir * 320.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
            col += step(0.9982, star) * (0.6 + 0.4 * sin(uTime * 2.0 + star * 900.0)) * uNight * smoothstep(0.0, 0.15, dir.y);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    dome.frustumCulled = false;
    this.group.add(dome, light, light.target, this.ambient);
  }

  /** The sky `seconds` into the game, lighting the land round `focus`. */
  update(seconds: number, focus: THREE.Vector3): void {
    const clock = (seconds + OPENS) % (DAY + NIGHT);
    // The angle along the road: 0 at sunrise, π at sunset, 2π at the next sunrise.
    const angle = clock < DAY ? (clock / DAY) * Math.PI : Math.PI * (1 + (clock - DAY) / NIGHT);
    const sun = this.uniforms.uSun.value.set(Math.cos(angle), Math.sin(angle) * 0.9, Math.sin(angle) * 0.45).normalize();
    const day = THREE.MathUtils.smoothstep(sun.y, 0, 0.3);
    this.night = THREE.MathUtils.smoothstep(-sun.y, 0, 0.25);
    const blend = (name: Exclude<keyof Hour, 'ambient'>, target: THREE.Color) => target.copy(TWILIGHT[name]).lerp(NOON[name], day).lerp(MIDNIGHT[name], this.night);
    blend('top', this.uniforms.uTop.value);
    blend('mid', this.uniforms.uMid.value);
    blend('horizon', this.uniforms.uHorizon.value);
    blend('fog', this.fog.color);
    blend('tint', this.tint);
    blend('above', this.ambient.color);
    blend('below', this.ambient.groundColor);
    this.ambient.intensity = THREE.MathUtils.lerp(THREE.MathUtils.lerp(TWILIGHT.ambient, NOON.ambient, day), MIDNIGHT.ambient, this.night);
    this.uniforms.uNight.value = this.night;
    this.uniforms.uTime.value = seconds;
    // Whichever of the sun and the moon is up gives the light; it fades to nothing as it nears the horizon.
    const up = sun.y >= 0 ? 1 : -1;
    blend('sun', this.light.color);
    if (up < 0) this.light.color.copy(MOONLIGHT);
    this.light.intensity = (up > 0 ? 2.9 : 1.5) * THREE.MathUtils.smoothstep(sun.y * up, 0.02, 0.22);
    this.light.target.position.copy(focus);
    this.light.position.copy(focus).addScaledVector(sun, LIGHT_DISTANCE * up);
  }
}
