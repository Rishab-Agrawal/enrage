import * as THREE from 'three';

/** Seconds a step takes, and its lift at mid-step, m: quick, light steps. */
const STEP_TIME = 0.22;
const LIFT = 0.07;
/** A planted foot steps once the body has turned this far over it, rad, or the pose has moved this far off it, m. */
const MAX_TWIST = 0.35;
const MAX_DRIFT = 0.08;
/** Seconds of turning a step lands ahead by, so the foot then stays planted longer. */
const LEAD = 0.25;
/** Least distance, m, a step lands from the hips' centre line: hip width, so feet turning round each other never cross. */
const HALF_STANCE = 0.08;
/** Rate, 1/s, at which unplanted feet ease back onto the pose. */
const RELEASE = 15;

const UP = new THREE.Vector3(0, 1, 0);
const [a, b, c, u, v, axis, left] = Array.from({ length: 7 }, () => new THREE.Vector3());
const [turn, parent, local] = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];

type Foot = {
  /** 1 for the left foot, -1 for the right. */
  side: number;
  thigh: THREE.Object3D;
  calf: THREE.Object3D;
  ankle: THREE.Object3D;
  /** Where the pose puts the ankle this frame, and the ankle's world orientation there. */
  home: THREE.Vector3;
  homeTurn: THREE.Quaternion;
  /** The planted ankle, world, and the body yaw it was planted facing. */
  plant: THREE.Vector3;
  yaw: number;
  /** Lift-off of the step under way; `t` is its progress, 1 once planted. */
  from: THREE.Vector3;
  fromYaw: number;
  t: number;
  /** Where the ankle is this frame, and how far that is off the pose, as offset and yaw. */
  target: THREE.Vector3;
  slip: THREE.Vector3;
  twist: number;
};

/** Turns `bone` by the world-space rotation `by`, about its own origin. */
function rotate(bone: THREE.Object3D, by: THREE.Quaternion): void {
  bone.parent!.getWorldQuaternion(parent);
  bone.quaternion.premultiply(local.copy(parent).invert().multiply(by).multiply(parent));
  bone.updateMatrixWorld(true);
}

/**
 * Feet that stay planted while the body stands: it turns over them, and a foot twisted or dragged too far takes a quick,
 * light step to where the pose wants it, one foot at a time. Two-bone IK bends each leg to reach its ankle.
 */
export class Footwork {
  private readonly feet: Foot[];
  /** Whether the feet were planted last frame; until then they ease in from wherever the pose puts them. */
  private planted = false;

  constructor(
    private readonly root: THREE.Object3D,
    model: THREE.Object3D,
  ) {
    this.feet = ['L', 'R'].map((side) => {
      const bone = (name: string) => model.getObjectByName(`${side}_${name}`)!;
      return {
        side: side === 'L' ? 1 : -1,
        thigh: bone('Thigh'),
        calf: bone('Calf'),
        ankle: bone('Foot'),
        home: new THREE.Vector3(),
        homeTurn: new THREE.Quaternion(),
        plant: new THREE.Vector3(),
        yaw: 0,
        from: new THREE.Vector3(),
        fromYaw: 0,
        t: 1,
        target: new THREE.Vector3(),
        slip: new THREE.Vector3(),
        twist: 0,
      };
    });
  }

  /** Where the ankles are this frame, world. */
  get ankles(): THREE.Vector3[] {
    return this.feet.map((foot) => foot.target);
  }

  /** Drop the plants, e.g. after a teleport: the feet go back to the pose. */
  reset(): void {
    for (const foot of this.feet) {
      foot.slip.set(0, 0, 0);
      foot.twist = 0;
    }
    this.planted = false;
  }

  /**
   * After the pose is applied and world matrices updated. Standing, the feet are planted; otherwise they ease back
   * onto the pose. The body turns about `pivot`, world.
   */
  update(delta: number, standing: boolean, spin: number, pivot: THREE.Vector3): void {
    const yaw = this.root.rotation.y;
    const planted = standing && this.planted;
    this.planted = standing;
    for (const foot of this.feet) {
      foot.ankle.getWorldPosition(foot.home);
      foot.ankle.getWorldQuaternion(foot.homeTurn);
      if (!planted) {
        const release = Math.exp(-RELEASE * delta);
        foot.plant.copy(foot.home).addScaledVector(foot.slip, release);
        foot.yaw = yaw + foot.twist * release;
        foot.t = 1;
      }
    }
    if (planted && this.feet.every((foot) => foot.t >= 1)) {
      const need = (foot: Foot) =>
        Math.max(Math.abs(foot.yaw - yaw) / MAX_TWIST, Math.hypot(foot.plant.x - foot.home.x, foot.plant.z - foot.home.z) / MAX_DRIFT);
      const foot = need(this.feet[0]) > need(this.feet[1]) ? this.feet[0] : this.feet[1];
      if (need(foot) > 1) {
        foot.from.copy(foot.plant);
        foot.fromYaw = foot.yaw;
        foot.t = 0;
      }
    }

    for (const foot of this.feet) {
      foot.target.copy(foot.plant);
      let targetYaw = foot.yaw;
      if (foot.t < 1) {
        // Land where the pose will want the foot a little further into the turn, on its own side, lifting it on the way.
        foot.t = Math.min(1, foot.t + delta / STEP_TIME);
        const lead = spin * LEAD;
        const land = u.subVectors(foot.home, pivot).applyAxisAngle(UP, lead).add(pivot);
        left.set(Math.cos(yaw + lead), 0, -Math.sin(yaw + lead));
        const lateral = v.subVectors(land, pivot).dot(left);
        land.addScaledVector(left, foot.side * Math.max(foot.side * lateral, HALF_STANCE) - lateral);
        const k = THREE.MathUtils.smoothstep(foot.t, 0, 1);
        foot.target.lerpVectors(foot.from, land, k).y += LIFT * Math.sin(Math.PI * foot.t);
        targetYaw = THREE.MathUtils.lerp(foot.fromYaw, yaw + lead, k);
        if (foot.t === 1) {
          foot.plant.copy(land);
          foot.yaw = targetYaw;
        }
      }
      foot.slip.subVectors(foot.target, foot.home);
      foot.twist = targetYaw - yaw;
      this.reach(foot);
    }
  }

  /** Bends the knee so the ankle can reach its target, swings the thigh to put it there, and turns the foot by its twist. */
  private reach(foot: Foot): void {
    foot.thigh.getWorldPosition(a);
    foot.calf.getWorldPosition(b);
    foot.ankle.getWorldPosition(c);
    const [thigh, shin] = [a.distanceTo(b), b.distanceTo(c)];
    const span = THREE.MathUtils.clamp(a.distanceTo(foot.target), 0.01, (thigh + shin) * 0.999);
    const knee = Math.acos(THREE.MathUtils.clamp((thigh * thigh + shin * shin - span * span) / (2 * thigh * shin), -1, 1));
    // Bend in the leg's own plane; a straight leg bends its knee forward.
    axis.crossVectors(u.subVectors(c, a), v.subVectors(b, a));
    if (axis.lengthSq() < 1e-10) axis.crossVectors(u, v.set(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y)));
    rotate(foot.calf, turn.setFromAxisAngle(axis.normalize(), knee - u.subVectors(a, b).angleTo(v.subVectors(c, b))));
    foot.ankle.getWorldPosition(c);
    rotate(foot.thigh, turn.setFromUnitVectors(u.subVectors(c, a).normalize(), v.subVectors(foot.target, a).normalize()));
    foot.ankle.parent!.getWorldQuaternion(parent);
    foot.ankle.quaternion.copy(parent.invert().multiply(turn.setFromAxisAngle(UP, foot.twist).multiply(foot.homeTurn)));
  }
}
