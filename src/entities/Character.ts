import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { addOutline, toonGradient } from '../world/toon';

export type PlayOptions = { loop?: boolean; fade?: number; speed?: number; from?: number };

/** A Tripo-baked GLB as a cel-shaded, animated fighter with a rim-light and hit-flash channel. */
export class Character {
  readonly root = new THREE.Group();
  readonly rim = { value: new THREE.Color(0, 0, 0) };
  readonly flash = { value: 0 };
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
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
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
  }

  /** Crossfade to a clip. Returns its duration in game seconds at the given speed. */
  play(name: string, { loop = true, fade = 0.18, speed = 1, from = 0 }: PlayOptions = {}): number {
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
    return (action.getClip().duration - from) / speed;
  }

  get clip(): string | undefined {
    return this.current?.getClip().name;
  }

  update(delta: number): void {
    this.mixer.update(delta);
    this.flash.value = Math.max(0, this.flash.value - delta * 8);
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
