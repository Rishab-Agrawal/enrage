import * as THREE from 'three';

/** Yaw that points a model's +Z forward along `direction`. */
export const yawTo = (direction: THREE.Vector3): number => Math.atan2(direction.x, direction.z);

/** Rotate toward `target` yaw by at most `rate` rad/s along the shortest arc. */
export function turnToward(object: THREE.Object3D, target: number, rate: number, delta: number): void {
  const diff = THREE.MathUtils.euclideanModulo(target - object.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
  object.rotation.y += THREE.MathUtils.clamp(diff, -rate * delta, rate * delta);
}
