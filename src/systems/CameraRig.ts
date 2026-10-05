import * as THREE from 'three';

const DISTANCE = 5;
const HEIGHT = 2.3;
const LOOK_AHEAD = 3;
const LOOK_HEIGHT = 1.2;
const MAX_SHAKE = 0.35;

/** Third-person follow: locked behind the player, so the view turns exactly as she does. Shake is trauma². */
export class CameraRig {
  private trauma = 0;
  private readonly forward = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(delta: number, player: THREE.Vector3, yaw: number, snap = false): void {
    const f = this.forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.focus.lerp(player, snap ? 1 : 1 - Math.exp(-8 * delta));
    this.camera.position.copy(this.focus).addScaledVector(f, -DISTANCE).setY(this.focus.y + HEIGHT);
    this.camera.lookAt(this.look.copy(this.focus).addScaledVector(f, LOOK_AHEAD).setY(this.focus.y + LOOK_HEIGHT));

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
