import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { addOutline, toonGradient } from '../world/toon';

type PlayOptions = { loop?: boolean; fade?: number; speed?: number; from?: number };

/** Ground speed, m/s, below which a body is standing. */
const STANDING = 0.3;

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
  /** Gait clip -> the ground speed it depicts at rate 1, m/s. */
  private readonly gaits = new Map<string, number>();
  /** Set while locomoting: the clip for standing still. */
  private idle: string | null = null;
  private current: THREE.AnimationAction | null = null;

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
    for (const clip of gltf.animations) {
      this.actions.set(clip.name, this.mixer.clipAction(clip));
      const groundSpeed = clip.userData.groundSpeed as number | undefined;
      if (groundSpeed) this.gaits.set(clip.name, groundSpeed * model.scale.x);
    }
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
    return (this.gaits.get(this.clip!) ?? 0) * this.current!.timeScale;
  }

  /** Hand animation to locomotion: `idle` when standing, else the gait closest to the measured speed, at that speed. */
  locomote(idle: string): void {
    this.idle = idle;
  }

  /** Play an action clip, ending locomotion. */
  play(name: string, options?: PlayOptions): void {
    this.idle = null;
    this.fadeTo(name, options);
  }

  /** Call once the body's position is final for the frame. */
  update(delta: number): void {
    if (delta > 0) this.velocity.subVectors(this.root.position, this.last).setY(0).divideScalar(delta);
    this.last.copy(this.root.position);
    if (this.idle) this.animateGait();
    this.mixer.update(delta);
    this.flash.value = Math.max(0, this.flash.value - delta * 8);
  }

  private animateGait(): void {
    const speed = this.velocity.length();
    let gait: string | null = null;
    if (this.moving) {
      const misfit = (name: string) => Math.abs(Math.log(speed / this.gaits.get(name)!));
      for (const name of this.gaits.keys()) if (!gait || misfit(name) < misfit(gait)) gait = name;
    }
    const clip = gait ?? this.idle!;
    if (this.clip !== clip) this.fadeTo(clip, { fade: 0.15 });
    if (gait) this.current!.timeScale = speed / this.gaits.get(gait)!;
  }

  private fadeTo(name: string, { loop = true, fade = 0.18, speed = 1, from = 0 }: PlayOptions = {}): void {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Missing clip: ${name}`);
    action.reset();
    action.time = from;
    action.timeScale = speed;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.play();
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, false);
    this.current = action;
  }

  private get clip(): string | undefined {
    return this.current?.getClip().name;
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
