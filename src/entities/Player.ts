import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Input } from '../core/Input';
import type { FightEvent } from '../game/events';
import { tuning } from '../game/tuning';
import { Character } from './Character';
import { angleTo } from './steering';

/** The jab's clip-second window, guard to guard: `contact` is the left fist at full stretch. */
const JAB = { from: 0.15, contact: 0.65, to: 1.25, speed: 1.8 };
const DODGE_TIME = 0.32;
const DODGE_SPEED = 10;
const DODGE_COOLDOWN = 0.7;
const HURT_TIME = 0.42;
const BUFFER_TIME = 0.25;
type State = 'move' | 'strike' | 'dodge' | 'hurt' | 'down';

export class Player {
  readonly character: Character;
  /** Her own movement; `knock`, the blows she takes, rides on top of it and dies away. */
  private readonly velocity = new THREE.Vector3();
  private readonly knock = new THREE.Vector3();
  readonly radius = 0.35;
  health = tuning.playerMaxHealth;
  state: State = 'move';
  private timer = 0;
  private contactAt = 0;
  private endAt = 0;
  private dodgeCooldown = 0;
  private buffered: 'strike' | 'dodge' | null = null;
  private bufferTimer = 0;
  private readonly move = new THREE.Vector2();
  /** Turn input eased toward the held A/D, so turning (and the camera locked behind her) starts and stops softly. */
  private turn = 0;
  private readonly wish = new THREE.Vector3();

  constructor(gltf: GLTF) {
    this.character = new Character(gltf, 1.65);
    this.reset();
  }

  get position(): THREE.Vector3 {
    return this.character.root.position;
  }

  /** Where she heads: A/D steer it, W walks along it and the camera looks along it. */
  get yaw(): number {
    return this.character.aim;
  }

  get invulnerable(): boolean {
    return this.state === 'dodge' || this.state === 'down';
  }

  reset(): void {
    this.health = tuning.playerMaxHealth;
    this.character.place(0, 6, Math.PI);
    this.velocity.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.dodgeCooldown = 0;
    this.turn = 0;
    this.buffered = null;
    this.toMove();
  }

  /**
   * Her legs answer input in every state but a dodge or a fall: strikes and flinches play on her upper body.
   * `resting`: she heals only while the NPC is calm, so running from his rage buys nothing.
   */
  update(delta: number, input: Input | null, resting: boolean, events: FightEvent[]): void {
    this.timer += delta;
    this.dodgeCooldown -= delta;
    this.bufferTimer -= delta;
    if (resting && this.state !== 'down') this.health = Math.min(tuning.playerMaxHealth, this.health + tuning.playerRegen * delta);

    if (input) {
      if (input.consume('strike')) this.buffer('strike');
      if (input.consume('dodge')) this.buffer('dodge');
      input.movement(this.move);
    } else {
      this.move.set(0, 0);
    }

    if (this.state === 'strike' && this.contactAt > 0 && this.timer >= this.contactAt) {
      this.contactAt = 0;
      events.push({ type: 'contact', who: 'player', damage: tuning.strikeDamage, knockback: 0, at: this.character.joint('L_Hand') });
    }
    if (this.state !== 'move' && this.state !== 'down' && this.timer >= this.endAt) this.toMove();
    if (this.bufferTimer <= 0) this.buffered = null;
    if (this.state !== 'dodge' && this.state !== 'down' && this.buffered === 'dodge' && this.dodgeCooldown <= 0) this.startDodge(events);
    else if (this.state === 'move' && this.buffered === 'strike') this.startStrike(events);

    if (this.state === 'dodge') {
      this.velocity.setLength(DODGE_SPEED * (0.35 + 0.65 * (1 - this.timer / DODGE_TIME)));
    } else if (this.state === 'down') {
      this.velocity.multiplyScalar(Math.exp(-6 * delta));
    } else {
      // A/D only turn her and W/S only walk her along her facing, so held together she walks an arc.
      // Shift hurries her forward only.
      this.turn += (this.move.x - this.turn) * (1 - Math.exp(-12 * delta));
      this.character.aim -= this.turn * tuning.playerTurnRate * delta;
      const speed = this.move.y < 0 ? tuning.playerBackSpeed : input?.sprinting ? tuning.playerSprintSpeed : tuning.playerWalkSpeed;
      this.wish.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.move.y * speed);
      this.velocity.lerp(this.wish, 1 - Math.exp(-14 * delta));
    }
    this.knock.multiplyScalar(Math.exp(-6 * delta));
    this.position.addScaledVector(this.velocity, delta).addScaledVector(this.knock, delta);
  }

  /** Knocked away from `from` at `knockback` m/s, on top of her own movement. Returns false when the blow is avoided. */
  takeHit(damage: number, from: THREE.Vector3, knockback: number): boolean {
    if (this.invulnerable) return false;
    this.health = Math.max(0, this.health - damage);
    if (damage) this.character.flash.value = 0.45;
    this.knock.subVectors(this.position, from).setY(0).setLength(knockback);
    this.timer = 0;
    if (this.health <= 0) {
      this.state = 'down';
      this.character.play('defeat', { loop: false, speed: 1.2, fade: 0.1 });
    } else {
      this.state = 'hurt';
      this.endAt = HURT_TIME;
      this.character.gesture('hurt', { speed: 1.5, fade: 0.06 });
    }
    return true;
  }

  private buffer(action: 'strike' | 'dodge'): void {
    this.buffered = action;
    this.bufferTimer = BUFFER_TIME;
  }

  /** Jabs follow one another guard to guard, however fast the clicks come. */
  private startStrike(events: FightEvent[]): void {
    this.buffered = null;
    this.state = 'strike';
    this.timer = 0;
    this.contactAt = (JAB.contact - JAB.from) / JAB.speed;
    this.endAt = (JAB.to - JAB.from) / JAB.speed;
    this.character.gesture('jab', { from: JAB.from, speed: JAB.speed });
    events.push({ type: 'swing', who: 'player', heavy: false });
  }

  private startDodge(events: FightEvent[]): void {
    this.buffered = null;
    this.state = 'dodge';
    this.timer = 0;
    this.endAt = DODGE_TIME;
    this.dodgeCooldown = DODGE_COOLDOWN;
    this.character.endGesture(0.08);
    this.character.turn(angleTo(this.character.root.rotation.y, this.yaw));
    this.velocity.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(DODGE_SPEED);
    this.character.locomote('idle');
    events.push({ type: 'dodge', at: this.position.clone() });
  }

  private toMove(): void {
    this.state = 'move';
    this.timer = 0;
    this.character.endGesture();
    this.character.locomote('idle');
  }
}
