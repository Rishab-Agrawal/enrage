import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { addOutline, toonGradient } from '../world/toon';
import { angleTo } from './steering';

type PlayOptions = { loop?: boolean; fade?: number; speed?: number; from?: number };

/** Ground speed, m/s, below which a body is standing. */
const STANDING = 0.3;
/** Seconds for locomotion blends to settle. */
const GAIT_FADE = 0.2;
const UP = new THREE.Vector3(0, 1, 0);
/** Bones that share a twist, hips to head: the legs stay put. */
const SPINE = ['Waist', 'Spine01', 'Spine02', 'NeckTwist01', 'Head'];
/** How far a fully raised knee swings the thigh forward, bends the knee and opens outward, rad. */
const KNEE_FLEX = 0.3;
const KNEE_BEND = 0.5;
const KNEE_OPEN = 0.13;
/** Standing, the upper body twists toward the aim up to this, rad, before the hips pivot round to catch up. */
const MAX_TWIST = 0.8;
/** Once the aim comes to rest, below AIM_REST rad/s, a twist past SETTLE, rad, settles with a pivot too. */
const AIM_REST = 0.06;
const SETTLE = 0.2;
/**
 * A pivot's steps: the outer foot steps round as the hips turn on the ball of the inner, then the inner follows in a
 * smaller step. Each turns the hips its share of the way to the aim over its seconds, its knee lifting up to `lift`.
 */
const STEPS = [
  { share: 0.7, time: 0.42, lift: 1 },
  { share: 1, time: 0.3, lift: 0.6 },
];
const [turn, parent] = [new THREE.Quaternion(), new THREE.Quaternion()];
const [side, step] = [new THREE.Vector3(), new THREE.Vector3()];

/** Turns `bone` by `angle` about the world `axis`, at its own origin. */
function bend(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  bone.parent!.getWorldQuaternion(parent);
  bone.quaternion.premultiply(turn.setFromAxisAngle(axis, angle).multiply(parent).premultiply(parent.invert()));
}

/** Rewinds `action` to clip second `from` at `speed`, looping or holding its last frame. */
function cue(action: THREE.AnimationAction, { loop = true, speed = 1, from = 0 }: PlayOptions): THREE.AnimationAction {
  action.reset();
  action.time = from;
  action.timeScale = speed;
  action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  action.clampWhenFinished = !loop;
  return action;
}

/**
 * A pivot under way: which of STEPS it is on and that step's progress, 0 to 1; the hips' yaw the step set off from, the
 * ball of the foot it turns on and the leg stepping round (positive the left); and how large its steps are, up to 1.
 */
type Pivot = { step: number; t: number; from: number; about: THREE.Vector3; leg: number; size: number };

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
  /** Yaw the body looks toward: the head turns to it, the hips follow. */
  aim = 0;
  /** Twist of the upper body over the hips, rad, positive left: where it looks ahead of where it faces. */
  private twist = 0;
  /** One knee raised and opened outward, as in a quick step: positive the left, negative the right, up to 1 at full height. */
  private knee = 0;
  private pivoting: Pivot | null = null;
  private lastAim = 0;
  private readonly spine: THREE.Object3D[];
  /** Thigh, calf and ball of the foot, left leg then right. */
  private readonly legs: THREE.Object3D[][];
  private readonly last = new THREE.Vector3();
  private readonly hip: THREE.Object3D;
  /** The ground under the hips, in the root's frame: what the body turns about. Poses can hold it well off the root. */
  private readonly pivot = new THREE.Vector3();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** Gait clip -> the ground speed it depicts at rate 1, m/s, slowest first. */
  private readonly gaits: Map<string, number>;
  /** The same for gaits that walk backwards, which the bake records as negative speeds. */
  private readonly backGaits: Map<string, number>;
  /** Set while locomoting: the clip for standing still. */
  private idle: string | null = null;
  /** Seconds standing settles in over until the body next moves: longer after an action, to ease back from it. */
  private settle = GAIT_FADE;
  /** Blend weight each clip eases toward; clips not listed fade out. */
  private targets = new Map<THREE.AnimationAction, number>();
  private fade = GAIT_FADE;
  /** How fast each clip's weight is changing, per second. */
  private readonly rates = new Map<THREE.AnimationAction, number>();
  /** Upper-body layer: a second mixer plays clips' Waist-up rotations, laid over the full-body pose by `layer.weight`. */
  private readonly upper: THREE.AnimationMixer;
  private readonly gestures = new Map<string, THREE.AnimationAction>();
  private readonly upperBones: THREE.Object3D[] = [];
  private readonly upperPose: THREE.Quaternion[];
  private readonly layer = { weight: 0, target: 0, fade: 0.1 };
  /** Action -> the ground its take covers by clip time, in the model's frame: the clip plays in place and moves the body by this. */
  private readonly travels = new Map<THREE.AnimationAction, THREE.Interpolant>();
  private readonly model: THREE.Object3D;

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
    this.model = model;

    this.mixer = new THREE.AnimationMixer(model);
    const gaits: [string, number][] = [];
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip).setEffectiveWeight(0);
      this.actions.set(clip.name, action);
      const travel = clip.userData.travel as number[] | undefined;
      if (travel) {
        const at = (k: number) => travel.filter((_, i) => i % 3 === k);
        const ground = at(1).flatMap((x, i) => [x, at(2)[i]]);
        this.travels.set(action, new THREE.LinearInterpolant(at(0), ground, 2, new Float32Array(2)));
      }
      const groundSpeed = clip.userData.groundSpeed as number | undefined;
      if (groundSpeed) gaits.push([clip.name, groundSpeed * model.scale.x]);
    }
    gaits.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
    this.gaits = new Map(gaits.filter(([, s]) => s > 0));
    this.backGaits = new Map(gaits.filter(([, s]) => s < 0).map(([name, s]) => [name, -s]));
    this.hip = model.getObjectByName('Hip')!;
    this.spine = SPINE.map((name) => model.getObjectByName(name)!);
    this.legs = ['L', 'R'].map((leg) => ['Thigh', 'Calf', 'ToeBase'].map((name) => model.getObjectByName(`${leg}_${name}`)!));

    model.getObjectByName('Waist')!.traverse((bone) => void this.upperBones.push(bone));
    this.upperPose = this.upperBones.map(() => new THREE.Quaternion());
    const upper = new Set(this.upperBones.map((bone) => `${bone.name}.quaternion`));
    this.upper = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const tracks = clip.tracks.filter((track) => upper.has(track.name));
      this.gestures.set(clip.name, this.upper.clipAction(new THREE.AnimationClip(clip.name, clip.duration, tracks)));
    }
  }

  /** Teleport: moves the body without that counting as motion. */
  place(x: number, z: number, yaw: number): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
    this.aim = this.lastAim = yaw;
    this.pivoting = null;
    this.last.copy(this.root.position);
    this.velocity.set(0, 0, 0);
  }

  /** Turn on the spot by `angle`, about the hips or a world point `about`: the root swings round it, which isn't motion. */
  turn(angle: number, about?: THREE.Vector3): void {
    const { position, rotation } = this.root;
    const pivot = about ?? this.pivot.clone().applyAxisAngle(UP, rotation.y).add(position);
    const before = position.clone();
    position.sub(pivot).applyAxisAngle(UP, angle).add(pivot);
    this.last.add(position).sub(before);
    rotation.y += angle;
  }

  /** The ball of a foot on the ground, world: positive the left, negative the right. */
  ball(leg: number): THREE.Vector3 {
    return this.legs[leg > 0 ? 0 : 1][2].getWorldPosition(new THREE.Vector3()).setY(0);
  }

  /** Where a bone is, world. */
  joint(name: string): THREE.Vector3 {
    return this.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());
  }

  get moving(): boolean {
    return this.velocity.lengthSq() > STANDING ** 2;
  }

  /** Ground speed the legs are showing, m/s; null mid-action. */
  get stride(): number | null {
    if (!this.idle) return null;
    let stride = 0;
    for (const [name, groundSpeed] of [...this.gaits, ...this.backGaits]) {
      const action = this.action(name);
      stride += action.weight * action.timeScale * groundSpeed;
    }
    return stride;
  }

  /** Hand animation to locomotion, which shows the measured speed with `idle` and the gaits. */
  locomote(idle: string, settle = GAIT_FADE): void {
    this.idle = idle;
    this.settle = settle;
  }

  /** Crossfade to an action clip, ending locomotion and any gesture. */
  play(name: string, { fade = 0.18, ...options }: PlayOptions = {}): void {
    this.idle = null;
    this.endGesture(fade);
    this.blend(new Map([[cue(this.action(name), options), 1]]), fade);
  }

  /** Play a clip once on the upper body alone, over whatever the legs are doing. */
  gesture(name: string, { fade = 0.1, ...options }: PlayOptions = {}): void {
    this.upper.stopAllAction();
    cue(this.gestures.get(name)!, { ...options, loop: false }).play();
    Object.assign(this.layer, { target: 1, fade });
  }

  /** Hand the upper body back to the full-body pose. */
  endGesture(fade = 0.2): void {
    Object.assign(this.layer, { target: 0, fade });
  }

  /** Call once the body's position is final for the frame. */
  update(delta: number): void {
    this.face(delta);
    if (delta > 0) this.velocity.subVectors(this.root.position, this.last).setY(0).divideScalar(delta);
    this.last.copy(this.root.position);
    if (this.idle) this.animateGait();
    // Ease every weight toward its target as a critically damped spring, 95% there in `fade` s: a blend eases in as well
    // as out, so no change of pose starts with a jolt. Renormalise so the pose never mixes in the bind pose.
    const stiffness = 4.74 / this.fade;
    const decay = Math.exp(-stiffness * delta);
    let total = 0;
    for (const action of this.actions.values()) {
      const target = this.targets.get(action) ?? 0;
      const [off, rate] = [action.weight - target, this.rates.get(action) ?? 0];
      const kick = (rate + stiffness * off) * delta;
      this.rates.set(action, (rate - stiffness * kick) * decay);
      total += action.weight = target + (off + kick) * decay;
    }
    for (const action of this.actions.values()) action.weight /= total || 1;
    const from = [...this.travels].map(([action, path]) => [...path.evaluate(action.time)]);
    this.mixer.update(delta);
    // Actions carry the body over the ground as their takes did.
    step.set(0, 0, 0);
    [...this.travels].forEach(([action, path], i) => {
      const [x, z] = path.evaluate(action.time);
      step.x += (x - from[i][0]) * action.weight;
      step.z += (z - from[i][1]) * action.weight;
    });
    this.root.position.add(step.applyQuaternion(this.model.quaternion).multiplyScalar(this.model.scale.x).applyAxisAngle(UP, this.root.rotation.y));
    this.upperBones.forEach((bone, i) => this.upperPose[i].copy(bone.quaternion));
    this.upper.update(delta);
    const { layer } = this;
    layer.weight += (layer.target - layer.weight) * (1 - Math.exp((-3 * delta) / layer.fade));
    this.upperBones.forEach((bone, i) => bone.quaternion.copy(this.upperPose[i].slerp(bone.quaternion, layer.weight)));
    // Each bone turns its share about the vertical, so the head ends up turned by the whole twist.
    for (const bone of this.twist ? this.spine : []) bend(bone, UP, this.twist / this.spine.length);
    if (this.knee) {
      // About the body's right: the thigh swings forward and the shin folds back under it; then the knee opens out.
      const [thigh, calf] = this.legs[this.knee > 0 ? 0 : 1];
      side.set(-Math.cos(this.root.rotation.y), 0, Math.sin(this.root.rotation.y));
      bend(thigh, side, KNEE_FLEX * Math.abs(this.knee));
      bend(calf, side, -KNEE_BEND * Math.abs(this.knee));
      bend(thigh, UP, KNEE_OPEN * this.knee);
    }
    this.root.updateMatrixWorld(true);
    this.root.worldToLocal(this.hip.getWorldPosition(this.pivot)).setY(0);
    this.flash.value = Math.max(0, this.flash.value - delta * 8);
  }

  /**
   * The hips follow the aim: closely on the move; standing, the upper body leads and the hips hold until it has
   * twisted as far as it goes, then catch up in a pivot's two steps. Mid-action the aim eases after the hips instead.
   */
  private face(delta: number): void {
    const facing = this.root.rotation.y;
    const lag = angleTo(facing, this.aim);
    if (!this.idle) {
      this.aim += angleTo(this.aim, facing) * (1 - Math.exp(-10 * delta));
      this.pivoting = null;
    } else if (this.moving) {
      this.turn(lag * (1 - Math.exp(-20 * delta)));
      this.pivoting = null;
    } else if (this.pivoting) {
      const { step, from, about, leg, size } = this.pivoting;
      const { share, time } = STEPS[step];
      const t = Math.min(1, this.pivoting.t + delta / time);
      this.pivoting.t = t;
      this.turn(angleTo(facing, from + share * angleTo(from, this.aim) * THREE.MathUtils.smootherstep(t, 0, 1)), about);
      if (t === 1) this.pivoting = STEPS[step + 1] ? this.stepOff(step + 1, -leg, size) : null;
    } else if (Math.abs(lag) > MAX_TWIST || (Math.abs(angleTo(this.lastAim, this.aim)) < AIM_REST * delta && Math.abs(lag) > SETTLE)) {
      // Step out first with the leg on the turning side; the further it has to turn, the larger the steps.
      this.pivoting = this.stepOff(0, Math.sign(lag), Math.min(1, Math.abs(lag) / MAX_TWIST));
    }
    this.lastAim = this.aim;
    const twist = this.idle ? angleTo(this.root.rotation.y, this.aim) : 0;
    this.twist += (twist - this.twist) * (1 - Math.exp(-20 * delta));
    const { pivoting: p } = this;
    const knee = p ? p.leg * p.size * STEPS[p.step].lift * Math.sin(Math.PI * p.t) : 0;
    this.knee += (knee - this.knee) * (1 - Math.exp(-40 * delta));
  }

  /** Starts a pivot's `step`: `leg` steps round while the hips turn on the ball of the other foot. */
  private stepOff(step: number, leg: number, size: number): Pivot {
    return { step, t: 0, from: this.root.rotation.y, about: this.ball(-leg), leg, size };
  }

  /**
   * Below the slowest gait, blend it with standing at its own cadence, so stopping settles rather than
   * freezing mid-stride; above, the gait nearest the speed, played at it. Moving against the facing
   * shows the backward gaits, if the clip set has any.
   */
  private animateGait(): void {
    const speed = this.velocity.length();
    const yaw = this.root.rotation.y;
    const backing = this.backGaits.size > 0 && this.velocity.x * Math.sin(yaw) + this.velocity.z * Math.cos(yaw) < 0;
    const gaits = backing ? this.backGaits : this.gaits;
    const [[slowest, slowestSpeed]] = gaits;
    let [gait, groundSpeed] = [slowest, slowestSpeed];
    for (const [name, s] of gaits) if (Math.abs(Math.log(speed / s)) < Math.abs(Math.log(speed / groundSpeed))) [gait, groundSpeed] = [name, s];
    const weight = Math.min(1, speed / slowestSpeed);
    const action = this.action(gait);
    action.timeScale = Math.max(speed, slowestSpeed) / groundSpeed;
    if (this.moving) this.settle = GAIT_FADE;
    this.blend(new Map([[this.action(this.idle!), 1 - weight], [action, weight]]), this.settle);
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
