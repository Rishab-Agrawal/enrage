import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Input } from '../core/Input';
import type { FightEvent } from '../game/events';
import { tuning } from '../game/tuning';
import { Character } from './Character';
import { turnToward, yawTo } from './steering';

/** Clip-second windows: `contact` is when the fist lands (measured from the clip's extension frame). */
const STRIKES = [
  { clip: 'jab', from: 0.15, contact: 0.49, to: 1.0, speed: 1.6 },
  { clip: 'cross', from: 1.25, contact: 2.2, to: 2.6, speed: 2.4 },
];
const STRIKE_REACH = 1.95;
const DODGE_TIME = 0.32;
const DODGE_SPEED = 10;
const DODGE_COOLDOWN = 0.7;
const HURT_TIME = 0.42;
const BUFFER_TIME = 0.25;

type State = 'move' | 'strike' | 'dodge' | 'hurt' | 'down';

export class Player {
  readonly character: Character;
  readonly velocity = new THREE.Vector3();
  readonly radius = 0.35;
  health = tuning.playerMaxHealth;
  state: State = 'move';
  private timer = 0;
  private contactAt = 0;
  private cancelAt = 0;
  private endAt = 0;
  private combo = 0;
  private dodgeCooldown = 0;
  private buffered: 'strike' | 'dodge' | null = null;
  private bufferTimer = 0;
  private readonly move = new THREE.Vector2();
  private readonly wish = new THREE.Vector3();
  private readonly toNpc = new THREE.Vector3();

  constructor(gltf: GLTF) {
    this.character = new Character(gltf, 1.65);
    this.reset();
  }

  get position(): THREE.Vector3 {
    return this.character.root.position;
  }

  get yaw(): number {
    return this.character.root.rotation.y;
  }

  get invulnerable(): boolean {
    return this.state === 'dodge' || this.state === 'down';
  }

  reset(): void {
    this.health = tuning.playerMaxHealth;
    this.character.place(0, 6, Math.PI);
    this.velocity.set(0, 0, 0);
    this.dodgeCooldown = 0;
    this.buffered = null;
    this.toMove();
  }

  /** `forward` is the camera's ground-plane forward; input is camera-relative. */
  update(delta: number, input: Input | null, forward: THREE.Vector3, npc: THREE.Vector3, events: FightEvent[]): void {
    this.timer += delta;
    this.dodgeCooldown -= delta;
    this.bufferTimer -= delta;
    if (this.state !== 'down') this.health = Math.min(tuning.playerMaxHealth, this.health + tuning.playerRegen * delta);

    if (input) {
      if (input.consume('strike')) this.buffer('strike');
      if (input.consume('dodge')) this.buffer('dodge');
      input.movement(this.move);
    } else {
      this.move.set(0, 0);
    }
    // Camera-relative wish direction; right = forward × up.
    this.wish.set(forward.x * this.move.y - forward.z * this.move.x, 0, forward.z * this.move.y + forward.x * this.move.x);
    this.toNpc.subVectors(npc, this.position).setY(0);

    if (this.bufferTimer <= 0) this.buffered = null;
    const canAct = this.state === 'move' || (this.state === 'strike' && this.timer >= this.cancelAt);
    if (canAct && this.buffered === 'dodge' && this.dodgeCooldown <= 0) this.startDodge(events);
    else if (canAct && this.buffered === 'strike') this.startStrike(events);

    switch (this.state) {
      case 'move': {
        this.velocity.lerp(this.wish.multiplyScalar(input?.sprinting ? tuning.playerSprintSpeed : tuning.playerWalkSpeed), 1 - Math.exp(-14 * delta));
        // Face where the body is actually going; standing, face him.
        const { moving, velocity } = this.character;
        turnToward(this.character.root, yawTo(moving ? velocity : this.toNpc), moving ? 12 : 5, delta);
        break;
      }
      case 'strike': {
        this.velocity.multiplyScalar(Math.exp(-12 * delta));
        // Close the last half-metre so strikes connect instead of whiffing at max range.
        const gap = this.toNpc.length() - 1.45;
        if (this.timer < this.contactAt && gap > 0 && gap < 1.2) this.position.addScaledVector(this.toNpc.normalize(), Math.min(gap, 3 * delta));
        if (this.contactAt > 0 && this.timer >= this.contactAt) {
          this.contactAt = 0;
          events.push({ type: 'contact', who: 'player', damage: tuning.strikeDamage, reach: STRIKE_REACH, knockback: 0 });
        }
        if (this.timer >= this.endAt) this.toMove();
        break;
      }
      case 'dodge': {
        const k = 1 - this.timer / DODGE_TIME;
        this.velocity.setLength(DODGE_SPEED * (0.35 + 0.65 * k));
        if (this.timer >= DODGE_TIME) this.toMove();
        break;
      }
      case 'hurt':
        this.velocity.multiplyScalar(Math.exp(-6 * delta));
        if (this.timer >= HURT_TIME) this.toMove();
        break;
      case 'down':
        this.velocity.multiplyScalar(Math.exp(-6 * delta));
        break;
    }
    this.position.addScaledVector(this.velocity, delta);
  }

  /** Returns false when the blow is avoided. */
  takeHit(damage: number, from: THREE.Vector3, knockback: number): boolean {
    if (this.invulnerable) return false;
    this.health = Math.max(0, this.health - damage);
    this.character.flash.value = 0.45;
    this.push(from, knockback + 2.5);
    if (this.health <= 0) {
      this.state = 'down';
      this.character.play('defeat', { loop: false, speed: 1.2, fade: 0.1 });
    }
    return true;
  }

  /** Knocked away from `from`: a short stagger that input can't steer out of. */
  push(from: THREE.Vector3, strength: number): void {
    if (this.state === 'down') return;
    this.velocity.subVectors(this.position, from).setY(0).setLength(strength);
    this.state = 'hurt';
    this.timer = 0;
    this.character.play('hurt', { loop: false, speed: 1.5, fade: 0.06 });
  }

  private buffer(action: 'strike' | 'dodge'): void {
    this.buffered = action;
    this.bufferTimer = BUFFER_TIME;
  }

  private startStrike(events: FightEvent[]): void {
    const strike = STRIKES[this.combo++ % STRIKES.length];
    this.buffered = null;
    this.state = 'strike';
    this.timer = 0;
    this.contactAt = (strike.contact - strike.from) / strike.speed;
    this.cancelAt = this.contactAt + 0.08;
    this.endAt = (strike.to - strike.from) / strike.speed;
    if (this.toNpc.lengthSq() < 36) this.character.root.rotation.y = yawTo(this.toNpc);
    this.character.play(strike.clip, { loop: false, from: strike.from, speed: strike.speed, fade: 0.06 });
    events.push({ type: 'swing', who: 'player', heavy: false });
  }

  private startDodge(events: FightEvent[]): void {
    this.buffered = null;
    this.state = 'dodge';
    this.timer = 0;
    this.dodgeCooldown = DODGE_COOLDOWN;
    const direction = this.wish.lengthSq() > 0.01 ? this.wish.clone() : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.velocity.copy(direction.setY(0).normalize()).multiplyScalar(DODGE_SPEED);
    this.character.root.rotation.y = yawTo(direction);
    this.character.locomote('idle');
    events.push({ type: 'dodge', at: this.position.clone() });
  }

  private toMove(): void {
    this.state = 'move';
    this.timer = 0;
    this.combo = 0;
    this.character.locomote('idle');
  }
}
