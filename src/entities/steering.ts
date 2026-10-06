import * as THREE from 'three';
import type { Character } from './Character';

/** Yaw that points a model's +Z forward along `direction`. */
export const yawTo = (direction: THREE.Vector3): number => Math.atan2(direction.x, direction.z);

/** Signed shortest-arc turn from yaw `from` to yaw `to`, in [-π, π). */
export const angleTo = (from: number, to: number): number => THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;

/** Turn `character`'s aim toward `target` yaw by at most `rate` rad/s: the head leads and the hips follow. */
export function aimToward(character: Character, target: number, rate: number, delta: number): void {
  character.aim += THREE.MathUtils.clamp(angleTo(character.aim, target), -rate * delta, rate * delta);
}

/** Turn toward `target` yaw by at most `rate` rad/s along the shortest arc. */
export function turnToward(character: Character, target: number, rate: number, delta: number): void {
  character.turn(THREE.MathUtils.clamp(angleTo(character.root.rotation.y, target), -rate * delta, rate * delta));
}
