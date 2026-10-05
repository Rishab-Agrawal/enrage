import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Input } from '../core/Input';
import type { FightEvent } from '../game/events';
import { tuning } from '../game/tuning';
import { Character } from './Character';
import { angleTo, turnToward, yawTo } from './steering';

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
/** Standing, her upper body twists toward her aim up to this, rad, before her hips pivot round to catch up. */
const MAX_TWIST = 0.8;
/** Once she stops turning, a twist past this, rad, settles with a pivot too. */
const SETTLE = 0.2;
/**
 * A pivot's steps: the outer foot steps round as the hips turn on the ball of the inner, then the inner follows in a
 * smaller step. Each turns the hips its share of the way to her aim over its seconds, its knee lifting up to `lift`.
 */
const STEPS = [
  { share: 0.7, time: 0.42, lift: 1 },
  { share: 1, time: 0.3, lift: 0.6 },
];

type State = 'move' | 'strike' | 'dodge' | 'hurt' | 'down';
/**
 * A pivot under way: which of STEPS it is on and that step's progress, 0 to 1; the hips' yaw the step set off from, the
 * ball of the foot it turns on and the leg stepping round (positive the left); and how large its steps are, up to 1.
 */
type Pivot = { step: number; t: number; from: number; about: THREE.Vector3; leg: number; size: number };

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
  /** Turn input eased toward the held A/D, so turning (and the camera locked behind her) starts and stops softly. */
  private turn = 0;
  /** Where she heads: A/D steer it, W walks along it and the camera looks along it. Her hips catch up with it. */
  private aim = 0;
  private pivot: Pivot | null = null;
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
    return this.aim;
  }

  get invulnerable(): boolean {
    return this.state === 'dodge' || this.state === 'down';
  }

  reset(): void {
    this.health = tuning.playerMaxHealth;
    this.character.place(0, 6, Math.PI);
    this.aim = Math.PI;
    this.pivot = null;
    this.velocity.set(0, 0, 0);
    this.dodgeCooldown = 0;
    this.turn = 0;
    this.buffered = null;
    this.toMove();
  }

  update(delta: number, input: Input | null, npc: THREE.Vector3, events: FightEvent[]): void {
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
    this.toNpc.subVectors(npc, this.position).setY(0);

    if (this.bufferTimer <= 0) this.buffered = null;
    const canAct = this.state === 'move' || (this.state === 'strike' && this.timer >= this.cancelAt);
    if (canAct && this.buffered === 'dodge' && this.dodgeCooldown <= 0) this.startDodge(events);
    else if (canAct && this.buffered === 'strike') this.startStrike(events);

    switch (this.state) {
      case 'move': {
        // A/D only turn her and W/S only walk her along her facing, so held together she walks an arc.
        // Shift hurries her forward only.
        this.turn += (this.move.x - this.turn) * (1 - Math.exp(-12 * delta));
        this.aim -= this.turn * tuning.playerTurnRate * delta;
        const speed = this.move.y < 0 ? tuning.playerBackSpeed : input?.sprinting ? tuning.playerSprintSpeed : tuning.playerWalkSpeed;
        this.wish.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.move.y * speed);
        this.velocity.lerp(this.wish, 1 - Math.exp(-14 * delta));
        break;
      }
      case 'strike': {
        this.velocity.multiplyScalar(Math.exp(-12 * delta));
        // Through the wind-up, square up to him and close the last half-metre, so strikes connect instead of whiffing.
        if (this.contactAt > 0 && this.toNpc.lengthSq() < 36) turnToward(this.character, yawTo(this.toNpc), 10, delta);
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
    this.follow(delta);
  }

  /**
   * Her hips follow her aim: closely on the move; standing, her upper body leads and her hips hold until it has
   * twisted as far as it goes, then catch up in a pivot's two steps. Mid-action her aim eases after her hips instead.
   */
  private follow(delta: number): void {
    const { character } = this;
    const facing = character.root.rotation.y;
    const lag = angleTo(facing, this.aim);
    if (this.state !== 'move') {
      this.aim += angleTo(this.aim, facing) * (1 - Math.exp(-10 * delta));
      this.pivot = null;
    } else if (character.moving) {
      character.turn(lag * (1 - Math.exp(-20 * delta)));
      this.pivot = null;
    } else if (this.pivot) {
      const { step, from, about, leg, size } = this.pivot;
      const { share, time } = STEPS[step];
      const t = Math.min(1, this.pivot.t + delta / time);
      this.pivot.t = t;
      character.turn(angleTo(facing, from + share * angleTo(from, this.aim) * THREE.MathUtils.smootherstep(t, 0, 1)), about);
      if (t === 1) this.pivot = STEPS[step + 1] ? this.stepOff(step + 1, -leg, size) : null;
    } else if (Math.abs(lag) > MAX_TWIST || (Math.abs(this.turn) < 0.05 && Math.abs(lag) > SETTLE)) {
      // Step out first with the leg on the turning side; the further she has to turn, the larger the steps.
      this.pivot = this.stepOff(0, Math.sign(lag), Math.min(1, Math.abs(lag) / MAX_TWIST));
    }
    const twist = this.state === 'move' ? angleTo(character.root.rotation.y, this.aim) : 0;
    character.twist += (twist - character.twist) * (1 - Math.exp(-20 * delta));
    const { pivot } = this;
    const knee = pivot ? pivot.leg * pivot.size * STEPS[pivot.step].lift * Math.sin(Math.PI * pivot.t) : 0;
    character.knee += (knee - character.knee) * (1 - Math.exp(-40 * delta));
  }

  /** Starts a pivot's `step`: `leg` steps round while the hips turn on the ball of the other foot. */
  private stepOff(step: number, leg: number, size: number): Pivot {
    const { character } = this;
    return { step, t: 0, from: character.root.rotation.y, about: character.ball(-leg), leg, size };
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
    this.character.turn(angleTo(this.character.root.rotation.y, this.aim));
    this.state = 'strike';
    this.timer = 0;
    this.contactAt = (strike.contact - strike.from) / strike.speed;
    this.cancelAt = this.contactAt + 0.08;
    this.endAt = (strike.to - strike.from) / strike.speed;
    this.character.play(strike.clip, { loop: false, from: strike.from, speed: strike.speed, fade: 0.06 });
    events.push({ type: 'swing', who: 'player', heavy: false });
  }

  private startDodge(events: FightEvent[]): void {
    this.buffered = null;
    this.state = 'dodge';
    this.timer = 0;
    this.dodgeCooldown = DODGE_COOLDOWN;
    this.character.turn(angleTo(this.character.root.rotation.y, this.aim));
    this.velocity.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(DODGE_SPEED);
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
