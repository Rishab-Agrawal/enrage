import * as THREE from 'three';
import { groundHeight } from '../world/terrain';

const DISTANCE = 5;
const HEIGHT = 2.3;
const LOOK_AHEAD = 3;
const LOOK_HEIGHT = 1.2;
/** The camera's arm from the point it looks at, m, and the arm's angle above level at rest, rad. */
const ARM = Math.hypot(DISTANCE + LOOK_AHEAD, HEIGHT - LOOK_HEIGHT);
const REST = Math.atan2(HEIGHT - LOOK_HEIGHT, DISTANCE + LOOK_AHEAD);
/** How far the view tilts off its rest, rad: up, and down. The camera itself sinks no lower than LOWEST. */
const PITCH = [-0.8, 0.9];
const LOWEST = -0.2;
const MAX_SHAKE = 0.35;
/** The camera keeps this far above the ground, m: a rise behind her lifts it. */
const CLEARANCE = 0.5;
/** Seconds the camera takes to glide from the title shot down behind her. */
const GLIDE = 1.8;
/** The title shot opens on the sky, as the loading screen showed it, holds while that fades, then tilts down over TILT s. */
const HOLD = 0.4;
const TILT = 1.6;
/** How far above her the opening shot looks, m. */
const SKY = 14;

/**
 * Third-person follow: locked behind the player, so the view turns exactly as she does; the mouse's travel up and down
 * swings it over her or down toward the ground. Shake is trauma².
 */
export class CameraRig {
  private trauma = 0;
  private readonly forward = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly from = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
  private glide = 1;
  /** Tilt of the view off its rest, rad, downward positive. */
  pitch = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  get gliding(): boolean {
    return this.glide < 1;
  }

  tilt(amount: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch + amount, PITCH[0], PITCH[1]);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A wide, low shot swaying slowly round `center`, after tilting down from the sky; the follow view glides out of it. */
  title(time: number, center: THREE.Vector3): void {
    const angle = 0.6 + Math.sin(time * 0.05) * 0.35;
    this.camera.position.set(center.x + Math.sin(angle) * 12, center.y + 1.5, center.z + Math.cos(angle) * 12);
    this.camera.lookAt(center.x, center.y + 2.6 + SKY * (1 - THREE.MathUtils.smootherstep(time, HOLD, HOLD + TILT)), center.z);
    this.from.position.copy(this.camera.position);
    this.from.rotation.copy(this.camera.quaternion);
    this.glide = 0;
  }

  update(delta: number, player: THREE.Vector3, yaw: number, snap = false): void {
    const f = this.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.focus.lerp(player, snap ? 1 : 1 - Math.exp(-8 * delta));
    // The camera swings on its arm about the point ahead of her that it looks at.
    const { position } = this.camera;
    const swing = Math.max(this.pitch, LOWEST) + REST;
    this.look.copy(this.focus).addScaledVector(f, LOOK_AHEAD).setY(this.focus.y + LOOK_HEIGHT);
    position.copy(this.look).addScaledVector(f, -ARM * Math.cos(swing));
    position.y = Math.max(this.look.y + ARM * Math.sin(swing), groundHeight(position.x, position.z) + CLEARANCE);
    // Tilted up past where the camera can sink, the view lifts off that point instead.
    this.look.y += Math.max(0, LOWEST - this.pitch) * ARM;
    this.camera.lookAt(this.look);
    this.glide = snap ? 1 : Math.min(1, this.glide + delta / GLIDE);
    if (this.glide < 1) {
      // Back from the follow pose toward the title shot: the camera is the target, so it can't be an argument.
      const t = 1 - THREE.MathUtils.smootherstep(this.glide, 0, 1);
      this.camera.position.lerp(this.from.position, t);
      this.camera.quaternion.slerp(this.from.rotation, t);
    }

    this.trauma = Math.max(0, this.trauma - delta * 1.6);
    const shake = this.trauma * this.trauma * MAX_SHAKE;
    if (shake > 0) {
      const t = performance.now() * 0.05;
      this.camera.position.x += Math.sin(t * 1.3) * shake;
      this.camera.position.y += Math.sin(t * 1.7 + 1) * shake;
      this.camera.rotateZ(Math.sin(t * 1.1 + 2) * shake * 0.08);
    }
  }
}
