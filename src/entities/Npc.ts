import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { FightEvent, Mood } from '../game/events';
import { ARENA_RADIUS, PERSONAL_SPACE, tuning } from '../game/tuning';
import { Character } from './Character';
import { angleTo, turnToward, yawTo } from './steering';

/** Clip-second windows; `contact` is when the blow lands. The haymaker's long crouch is its telegraph. */
const ATTACKS = {
  punch: { from: 0.1, contact: 0.56, to: 1.3, speed: 1.2, reach: 2.15, knockback: 3 },
  haymaker: { from: 0.9, contact: 2.3, to: 2.65, speed: 1.6, reach: 2.35, knockback: 8 },
};
const ATTACK_RANGE = 1.9;
/** A calm NPC starts walking off inside COMFORT_DISTANCE and, once going, stops only at RETREAT_TO: no shuffling at the edge. */
const COMFORT_DISTANCE = 6;
const RETREAT_TO = 7.5;
const WALK_SPEED = 1.7;
const ROAR_TIME = 1.4;
const RECOVER_TIME = 0.5;
const FLINCH_TIME = 0.35;
const POISE_TIME = 1.6;
const SHOVE_COOLDOWN = 1.4;

type State = 'calm' | 'shove' | 'roar' | 'chase' | 'attack' | 'recover' | 'flinch' | 'down';

export class Npc {
  readonly character: Character;
  readonly radius = 0.55;
  health = tuning.npcMaxHealth;
  /** The NPC's temper. The only state an outside system (debug panel now, LLM later) sets, via `setMood`. */
  mood: Mood = 'calm';
  state: State = 'calm';
  private timer = 0;
  private contactAt = 0;
  private endAt = 0;
  private attack: keyof typeof ATTACKS = 'punch';
  private poise = 0;
  private shoveCooldown = 0;
  private retreating = false;
  private readonly toPlayer = new THREE.Vector3();
  private readonly heading = new THREE.Vector3();

  constructor(
    gltf: GLTF,
    private readonly rng: () => number,
  ) {
    this.character = new Character(gltf, 2.05);
    this.reset();
  }

  get position(): THREE.Vector3 {
    return this.character.root.position;
  }

  get yaw(): number {
    return this.character.root.rotation.y;
  }

  reset(): void {
    this.health = tuning.npcMaxHealth;
    this.character.place(0, -4, 0);
    this.mood = 'calm';
    this.enter('calm');
  }

  setMood(mood: Mood, events: FightEvent[]): void {
    if (mood === this.mood || this.state === 'down') return;
    this.mood = mood;
    this.enter(mood === 'calm' ? 'calm' : 'roar');
    events.push({ type: 'mood', mood });
  }

  /** The fight is over on his side: arms folded, no further reactions. */
  standDown(): void {
    this.mood = 'calm';
    this.enter('calm');
  }

  update(delta: number, player: THREE.Vector3, events: FightEvent[]): void {
    this.timer += delta;
    this.poise -= delta;
    this.shoveCooldown -= delta;
    this.toPlayer.subVectors(player, this.position).setY(0);
    const distance = this.toPlayer.length();

    switch (this.state) {
      case 'calm':
        if (distance < PERSONAL_SPACE + 0.35 && this.shoveCooldown <= 0) {
          this.enter('shove');
        } else if (distance < (this.retreating ? RETREAT_TO : COMFORT_DISTANCE)) {
          this.retreating = true;
          this.walk(this.retreatHeading(), WALK_SPEED, delta);
        } else {
          this.retreating = false;
          this.look(this.toPlayer, 1.5, delta);
        }
        break;
      case 'shove':
        turnToward(this.character, yawTo(this.toPlayer), 8, delta);
        if (this.contactAt > 0 && this.timer >= this.contactAt) {
          this.contactAt = 0;
          events.push({ type: 'shove' });
        }
        if (this.timer >= this.endAt) this.enter('calm');
        break;
      case 'roar':
        turnToward(this.character, yawTo(this.toPlayer), 4, delta);
        if (this.timer >= ROAR_TIME) this.enter('chase');
        break;
      case 'chase':
        if (distance <= ATTACK_RANGE) this.startAttack(events);
        else this.walk(this.toPlayer.normalize(), tuning.npcRunSpeed, delta);
        break;
      case 'attack':
        // Tracks the player through the wind-up, committed after contact: sidestepping late works.
        if (this.contactAt > 0) turnToward(this.character, yawTo(this.toPlayer), 2.6, delta);
        if (this.contactAt > 0 && this.timer >= this.contactAt) {
          this.contactAt = 0;
          const { reach, knockback } = ATTACKS[this.attack];
          const damage = this.attack === 'punch' ? tuning.punchDamage : tuning.haymakerDamage;
          events.push({ type: 'contact', who: 'npc', damage, reach, knockback });
        }
        if (this.timer >= this.endAt) this.enter('recover');
        break;
      case 'recover':
        if (distance > ATTACK_RANGE) this.walk(this.toPlayer.normalize(), WALK_SPEED, delta);
        if (this.timer >= RECOVER_TIME) this.enter('chase');
        break;
      case 'flinch':
        if (this.timer >= FLINCH_TIME) this.enter('chase');
        break;
      case 'down':
        break;
    }
  }

  /** Damage always lands; a flinch only interrupts movement, never a committed attack or roar. */
  takeHit(damage: number): void {
    this.health = Math.max(0, this.health - damage);
    this.character.flash.value = 0.45;
    if (this.health <= 0) this.enter('down');
    else if ((this.state === 'chase' || this.state === 'recover') && this.poise <= 0) {
      this.poise = POISE_TIME;
      this.enter('flinch');
    }
  }

  private enter(state: State): void {
    this.state = state;
    this.timer = 0;
    this.contactAt = 0;
    const play = this.character.play.bind(this.character);
    if (state === 'calm') this.character.locomote('calm');
    if (state === 'chase' || state === 'recover') this.character.locomote('idle');
    if (state === 'shove') {
      // A back-off swat with the punch: knocks the player away, never hurts.
      this.shoveCooldown = SHOVE_COOLDOWN;
      const { from, contact } = ATTACKS.punch;
      play('punch', { loop: false, from, speed: 1.4, fade: 0.1 });
      this.contactAt = (contact - from) / 1.4;
      this.endAt = this.contactAt + 0.4;
    }
    if (state === 'roar') play('roar', { loop: false, from: 1.2, fade: 0.15 });
    if (state === 'flinch') play('hurt', { loop: false, from: 0.1, speed: 1.6, fade: 0.06 });
    if (state === 'down') play('defeat', { loop: false, speed: 1.2, fade: 0.12 });
  }

  private startAttack(events: FightEvent[]): void {
    this.attack = this.rng() < 0.6 ? 'punch' : 'haymaker';
    const attack = ATTACKS[this.attack];
    this.enter('attack');
    this.contactAt = (attack.contact - attack.from) / attack.speed;
    this.endAt = (attack.to - attack.from) / attack.speed;
    this.character.play(this.attack, { loop: false, from: attack.from, speed: attack.speed, fade: 0.1 });
    events.push({ type: 'swing', who: 'npc', heavy: true });
  }

  /** Away from the player, sliding along the arena edge instead of pinning against it. */
  private retreatHeading(): THREE.Vector3 {
    this.heading.copy(this.toPlayer).negate().normalize();
    const edge = this.position.length() / (ARENA_RADIUS - 1.5);
    if (edge > 0.8) {
      const outward = this.position.clone().setY(0).normalize();
      const tangent = new THREE.Vector3(-outward.z, 0, outward.x);
      if (tangent.dot(this.heading) < 0) tangent.negate();
      this.heading.lerp(tangent, Math.min(1, (edge - 0.8) * 5)).normalize();
    }
    return this.heading;
  }

  private walk(direction: THREE.Vector3, speed: number, delta: number): void {
    this.position.addScaledVector(direction, speed * delta);
    this.look(direction, 7, delta);
  }

  /** Turns his aim toward `direction` by at most `rate` rad/s: his head leads and his hips follow. */
  private look(direction: THREE.Vector3, rate: number, delta: number): void {
    const step = rate * delta;
    this.character.aim += THREE.MathUtils.clamp(angleTo(this.character.aim, yawTo(direction)), -step, step);
  }
}
