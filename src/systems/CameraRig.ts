import * as THREE from 'three';

const DISTANCE = 5;
const HEIGHT = 2.3;
const SIDE = 1.5;
const MAX_SHAKE = 0.35;

/** Third-person lock-on: behind and beside the player, framing the NPC. Shake is trauma². */
export class CameraRig {
  /** Ground-plane forward the player's input is relative to. */
  readonly forward = new THREE.Vector3(0, 0, -1);
  private trauma = 0;
  private readonly position = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private readonly goalLook = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(delta: number, player: THREE.Vector3, npc: THREE.Vector3, snap = false): void {
    const axis = this.goal.subVectors(npc, player).setY(0);
    if (axis.lengthSq() > 0.25) this.forward.lerp(axis.normalize(), snap ? 1 : 1 - Math.exp(-4 * delta)).normalize();
    const f = this.forward;
    this.goal.set(player.x - f.x * DISTANCE - f.z * SIDE, player.y + HEIGHT, player.z - f.z * DISTANCE + f.x * SIDE);
    this.goalLook.lerpVectors(player, npc, 0.35).setY(1.45);

    const k = snap ? 1 : 1 - Math.exp(-8 * delta);
    this.position.lerp(this.goal, k);
    this.look.lerp(this.goalLook, k);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.look);

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
