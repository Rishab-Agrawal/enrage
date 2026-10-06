import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Input } from '../core/Input';
import type { FightEvent } from '../game/events';
import { tuning } from '../game/tuning';
import { Character } from './Character';
import { aimToward, angleTo, yawTo } from './steering';

/** Clip-second windows: `contact` is when the striking `hand` lands (measured from the clip's extension frame). */
const STRIKES = [
  { clip: 'jab', hand: 'L_Hand', from: 0.15, contact: 0.49, to: 1.0, speed: 1.6 },
  { clip: 'cross', hand: 'R_Hand', from: 1.25, contact: 2.2, to: 2.6, speed: 2.4 },
];
const DODGE_TIME = 0.32;
const DODGE_SPEED = 10;
const DODGE_COOLDOWN = 0.7;
/** Share of her sprint's speed she keeps while A/D steer it. */
const STEERED_RUN = 0.95;
const HURT_TIME = 0.42;
/** A shove sends her reeling back this fast, m/s, out of control for REEL_TIME. */
const SHOVE_SPEED = 14;
const REEL_TIME = 0.6;
const BUFFER_TIME = 0.25;
/** Seconds a strike blends in over, and her stance back in once she's done. */
const STRIKE_FADE = 0.15;
const RECOVER_FADE = 0.5;
type State = 'move' | 'strike' | 'dodge' | 'hurt' | 'reel' | 'down';

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
  private cancelAt = 0;
  private endAt = 0;
  private combo = 0;
  private strike = STRIKES[0];
  private dodgeCooldown = 0;
  private buffered: 'strike' | 'dodge' | null = null;
  private bufferTimer = 0;
  private readonly move = new THREE.Vector2();
  private readonly wish = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly toNpc = new THREE.Vector3();

  constructor(gltf: GLTF) {
    this.character = new Character(gltf, 1.65);
    this.reset();
  }

  get position(): THREE.Vector3 {
    return this.character.root.position;
  }

  /** Where she faces: the mouse steers it, W walks along it and the camera looks along it. */
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
    this.buffered = null;
    this.toMove();
  }

  /**
   * Her legs answer input except while she strikes, dodges or is down: a flinch plays on her upper body only.
   * `resting`: she heals only while the NPC is calm, so running from his rage buys nothing.
   */
  update(delta: number, input: Input | null, npc: THREE.Vector3, resting: boolean, events: FightEvent[]): void {
    this.timer += delta;
    this.dodgeCooldown -= delta;
    this.bufferTimer -= delta;
    if (resting && this.state !== 'down') this.health = Math.min(tuning.playerMaxHealth, this.health + tuning.playerRegen * delta);

    const look = input?.consumeLook() ?? 0;
    if (input) {
      if (input.consume('strike')) this.buffer('strike');
      if (input.consume('dodge')) this.buffer('dodge');
      input.movement(this.move);
      if (this.move.y < 0) this.move.x = 0; // no gait walks back on a diagonal: S overrides A/D
    } else {
      this.move.set(0, 0);
    }
    this.toNpc.subVectors(npc, this.position).setY(0);

    if (this.state === 'strike' && this.contactAt > 0 && this.timer >= this.contactAt) {
      this.contactAt = 0;
      events.push({ type: 'contact', who: 'player', damage: tuning.strikeDamage, knockback: 0, at: this.character.joint(this.strike.hand) });
    }
    if (this.state !== 'move' && this.state !== 'down' && this.timer >= this.endAt) this.toMove();
    if (this.bufferTimer <= 0) this.buffered = null;
    const canAct = this.state === 'move' || (this.state === 'strike' && this.timer >= this.cancelAt);
    if ((canAct || this.state === 'hurt') && this.buffered === 'dodge' && this.dodgeCooldown <= 0) this.startDodge(events);
    else if (canAct && this.buffered === 'strike') this.startStrike(events);

    if (this.state === 'dodge') {
      this.velocity.setLength(DODGE_SPEED * (0.35 + 0.65 * (1 - this.timer / DODGE_TIME)));
    } else if (this.state === 'down' || this.state === 'reel') {
      this.velocity.multiplyScalar(Math.exp(-6 * delta));
    } else if (this.state === 'strike') {
      this.velocity.multiplyScalar(Math.exp(-12 * delta));
      // Through the wind-up, turn to him and close the last half-metre, so strikes connect instead of whiffing.
      if (this.contactAt > 0 && this.toNpc.lengthSq() < 36) aimToward(this.character, yawTo(this.toNpc), 10, delta);
      const gap = this.toNpc.length() - 1.45;
      if (this.timer < this.contactAt && gap > 0 && gap < 1.2) this.position.addScaledVector(this.toNpc.normalize(), Math.min(gap, 3 * delta));
    } else {
      // The mouse turns her; W/S walk her along her facing and A/D step her sideways, on a diagonal no faster than
      // straight. Shift runs her forward only, so A/D then only steer her run a little, and slow it to STEERED_RUN.
      this.character.aim -= look * tuning.mouseTurn;
      this.character.running = this.move.y > 0 && !!input?.sprinting;
      const speed = this.move.y < 0 ? tuning.playerBackSpeed : this.character.running ? tuning.playerSprintSpeed : tuning.playerWalkSpeed;
      const [sin, cos] = [Math.sin(this.yaw), Math.cos(this.yaw)];
      this.wish.set(sin, 0, cos).multiplyScalar(this.move.y * speed).add(this.side.set(-cos, 0, sin).multiplyScalar(this.move.x * tuning.playerStrafeSpeed));
      this.wish.clampLength(0, this.character.running ? speed * (this.move.x ? STEERED_RUN : 1) : Math.max(speed, tuning.playerStrafeSpeed));
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

  /** Shoved off by the calm NPC at `from`: no dodge avoids it, and she reels away whatever she was doing. */
  shove(from: THREE.Vector3): void {
    this.state = 'reel';
    this.timer = 0;
    this.endAt = REEL_TIME;
    this.velocity.set(0, 0, 0);
    this.knock.subVectors(this.position, from).setY(0).setLength(SHOVE_SPEED);
    this.character.locomote('idle');
    this.character.gesture('hurt', { speed: 1.5, fade: 0.06 });
  }

  private buffer(action: 'strike' | 'dodge'): void {
    this.buffered = action;
    this.bufferTimer = BUFFER_TIME;
  }

  private startStrike(events: FightEvent[]): void {
    const strike = (this.strike = STRIKES[this.combo++ % STRIKES.length]);
    this.buffered = null;
    this.character.turn(angleTo(this.character.root.rotation.y, this.yaw));
    this.state = 'strike';
    this.timer = 0;
    this.contactAt = (strike.contact - strike.from) / strike.speed;
    this.cancelAt = this.contactAt + 0.08;
    this.endAt = (strike.to - strike.from) / strike.speed;
    this.character.play(strike.clip, { loop: false, from: strike.from, speed: strike.speed, fade: STRIKE_FADE, track: true });
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
    this.character.running = true; // a dash is a burst of her run
    events.push({ type: 'dodge', at: this.position.clone() });
  }

  private toMove(): void {
    this.state = 'move';
    this.timer = 0;
    this.combo = 0;
    this.character.endGesture();
    this.character.locomote('idle', RECOVER_FADE);
  }
}
