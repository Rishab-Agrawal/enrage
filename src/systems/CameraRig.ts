import * as THREE from 'three';

const DISTANCE = 5;
const HEIGHT = 2.3;
const LOOK_AHEAD = 3;
const LOOK_HEIGHT = 1.2;
const MAX_SHAKE = 0.35;
/** Seconds the camera takes to glide from the title shot down behind her. */
const GLIDE = 1.8;
/** The title shot opens on the sky, as the loading screen showed it, holds while that fades, then tilts down over TILT s. */
const HOLD = 0.6;
const TILT = 2.6;
/** How far above the hilltop the opening shot looks, m. */
const SKY = 14;

/** Third-person follow: locked behind the player, so the view turns exactly as she does. Shake is trauma². */
export class CameraRig {
  private trauma = 0;
  private readonly forward = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly from = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
  private glide = 1;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  get gliding(): boolean {
    return this.glide < 1;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A wide, low shot of the hilltop, swaying slowly round `center`, after tilting down from the sky; the follow view glides out of it. */
  title(time: number, center: THREE.Vector3): void {
    const angle = 0.6 + Math.sin(time * 0.05) * 0.35;
    this.camera.position.set(center.x + Math.sin(angle) * 12, 1.5, center.z + Math.cos(angle) * 12);
    this.camera.lookAt(center.x, 2.6 + SKY * (1 - THREE.MathUtils.smootherstep(time, HOLD, HOLD + TILT)), center.z);
    this.from.position.copy(this.camera.position);
    this.from.rotation.copy(this.camera.quaternion);
    this.glide = 0;
  }

  update(delta: number, player: THREE.Vector3, yaw: number, snap = false): void {
    const f = this.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.focus.lerp(player, snap ? 1 : 1 - Math.exp(-8 * delta));
    this.camera.position.copy(this.focus).addScaledVector(f, -DISTANCE).setY(this.focus.y + HEIGHT);
    this.camera.lookAt(this.look.copy(this.focus).addScaledVector(f, LOOK_AHEAD).setY(this.focus.y + LOOK_HEIGHT));
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
