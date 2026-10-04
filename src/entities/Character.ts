import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { addOutline, toonGradient } from '../world/toon';

type PlayOptions = { loop?: boolean; fade?: number; speed?: number; from?: number };

/** Ground speed, m/s, below which a body is standing. */
const STANDING = 0.3;
/** Seconds for locomotion blends to settle. */
const GAIT_FADE = 0.2;

/**
 * A Tripo-baked GLB as a cel-shaded, animated fighter with a rim-light and hit-flash channel.
 * Locomotion is drawn from the root's measured displacement, never from intent, so the legs
 * always show what the body actually did, whatever moved it.
 */
export class Character {
  readonly root = new THREE.Group();
  readonly rim = { value: new THREE.Color(0, 0, 0) };
  readonly flash = { value: 0 };
  /** Ground velocity over the last frame, m/s. */
  readonly velocity = new THREE.Vector3();
  private readonly last = new THREE.Vector3();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** Gait clip -> the ground speed it depicts at rate 1, m/s, slowest first. */
  private readonly gaits: Map<string, number>;
  /** Set while locomoting: the clip for standing still. */
  private idle: string | null = null;
  /** Blend weight each clip eases toward; clips not listed fade out. */
  private targets = new Map<THREE.AnimationAction, number>();
  private fade = GAIT_FADE;

  constructor(gltf: GLTF, height: number) {
    const model = cloneSkinned(gltf.scene);
    model.scale.setScalar(height / new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3()).y);
    model.rotation.y = -Math.PI / 2; // Tripo's clips face the body down +X; the game's forward is +Z.
    const meshes: THREE.Mesh[] = [];
    model.traverse((object) => (object as THREE.Mesh).isMesh && meshes.push(object as THREE.Mesh));
    for (const mesh of meshes) {
      mesh.castShadow = true;
      mesh.frustumCulled = false; // skinned bounds don't follow the animation
      mesh.material = this.toonFrom(mesh.material as THREE.MeshStandardMaterial);
      addOutline(mesh, 0.006);
    }
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    const gaits: [string, number][] = [];
    for (const clip of gltf.animations) {
      this.actions.set(clip.name, this.mixer.clipAction(clip).setEffectiveWeight(0));
      const groundSpeed = clip.userData.groundSpeed as number | undefined;
      if (groundSpeed) gaits.push([clip.name, groundSpeed * model.scale.x]);
    }
    this.gaits = new Map(gaits.sort((a, b) => a[1] - b[1]));
  }

  /** Teleport: moves the body without that counting as motion. */
  place(x: number, z: number, yaw: number): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
    this.last.copy(this.root.position);
    this.velocity.set(0, 0, 0);
  }

  get moving(): boolean {
    return this.velocity.lengthSq() > STANDING ** 2;
  }

  /** Ground speed the legs are showing, m/s; null mid-action. */
  get stride(): number | null {
    if (!this.idle) return null;
    let stride = 0;
    for (const [name, groundSpeed] of this.gaits) {
      const action = this.action(name);
      stride += action.weight * action.timeScale * groundSpeed;
    }
    return stride;
  }

  /** Hand animation to locomotion, which shows the measured speed with `idle` and the gaits. */
  locomote(idle: string): void {
    this.idle = idle;
  }

  /** Crossfade to an action clip, ending locomotion. */
  play(name: string, { loop = true, fade = 0.18, speed = 1, from = 0 }: PlayOptions = {}): void {
    this.idle = null;
    const action = this.action(name).reset();
    action.time = from;
    action.timeScale = speed;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    this.blend(new Map([[action, 1]]), fade);
  }

  /** Call once the body's position is final for the frame. */
  update(delta: number): void {
    if (delta > 0) this.velocity.subVectors(this.root.position, this.last).setY(0).divideScalar(delta);
    this.last.copy(this.root.position);
    if (this.idle) this.animateGait();
    // Ease every weight toward its target; renormalise so the pose never mixes in the bind pose.
    const k = 1 - Math.exp((-3 * delta) / this.fade);
    let total = 0;
    for (const action of this.actions.values()) total += action.weight += ((this.targets.get(action) ?? 0) - action.weight) * k;
    for (const action of this.actions.values()) action.weight /= total || 1;
    this.mixer.update(delta);
    this.flash.value = Math.max(0, this.flash.value - delta * 8);
  }

  /**
   * Below the slowest gait, blend it with standing at its own cadence, so stopping settles rather than
   * freezing mid-stride; above, the gait nearest the speed, played at it.
   */
  private animateGait(): void {
    const speed = this.velocity.length();
    const [[slowest, slowestSpeed]] = this.gaits;
    let [gait, groundSpeed] = [slowest, slowestSpeed];
    for (const [name, s] of this.gaits) if (Math.abs(Math.log(speed / s)) < Math.abs(Math.log(speed / groundSpeed))) [gait, groundSpeed] = [name, s];
    const weight = Math.min(1, speed / slowestSpeed);
    const action = this.action(gait);
    action.timeScale = Math.max(speed, slowestSpeed) / groundSpeed;
    this.blend(new Map([[this.action(this.idle!), 1 - weight], [action, weight]]), GAIT_FADE);
  }

  private blend(targets: Map<THREE.AnimationAction, number>, fade: number): void {
    for (const action of targets.keys()) action.play();
    this.targets = targets;
    this.fade = fade;
  }

  private action(name: string): THREE.AnimationAction {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Missing clip: ${name}`);
    return action;
  }

  private toonFrom(source: THREE.MeshStandardMaterial): THREE.MeshToonMaterial {
    const material = new THREE.MeshToonMaterial({
      map: source.map,
      normalMap: source.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      gradientMap: toonGradient,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = this.rim;
      shader.uniforms.uFlash = this.flash;
      shader.fragmentShader = `uniform vec3 uRim;\nuniform float uFlash;\n${shader.fragmentShader}`.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float fresnel = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        totalEmissiveRadiance += uRim * fresnel + vec3(uFlash);`,
      );
    };
    material.customProgramCacheKey = () => 'character-rim';
    return material;
  }
}
