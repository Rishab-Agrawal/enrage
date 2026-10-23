import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { FightEvent, Mood } from '../game/events';
import { ARENA_RADIUS, tuning } from '../game/tuning';
import { Character } from './Character';
import { aimToward, angleTo, turnToward, yawTo } from './steering';

/**
 * Clip-second windows, each starting with the blow already under way; `contact` is when the striking `hand` is at full
 * stretch. He swings when she'll be within `range`, m, as it lands: the take's own footwork carries the blow onto her.
 */
const ATTACKS = {
  punch: { range: 1.1, from: 0.35, contact: 0.7, to: 1.3, speed: 1.2, hand: 'L_Hand', knockback: 5.5 },
  haymaker: { range: 1, from: 1.95, contact: 2.3, to: 2.65, speed: 1.6, hand: 'R_Hand', knockback: 10.5 },
};
const windUp = ({ from, contact, speed }: (typeof ATTACKS)[keyof typeof ATTACKS]) => (contact - from) / speed;
/** He swings at this distance whatever she does: any closer, his run would be shoving her along. */
const CLINCH = 0.95;
/**
 * A calm NPC shoves off a player closing on him, dashing or not: he wheels round at SHOVE_TURN rad/s and pushes, starting
 * so his palms are out, SHOVE_LAND s into the push, as she reaches SHOVE_REACH. She is shoved the moment she gets
 * there, so she never touches him.
 */
const SHOVE_REACH = 1.3;
const SHOVE_TURN = 14;
const SHOVE_LAND = 0.12;
/** Shorter than her reel, so he's ready again before she can come back. */
const SHOVE_TIME = 0.5;
/** A calm NPC starts walking off inside COMFORT_DISTANCE and, once going, stops only at RETREAT_TO: no shuffling at the edge. */
const COMFORT_DISTANCE = 6;
const RETREAT_TO = 7.5;
const WALK_SPEED = 1.7;
/** How fast he steps after her through a wind-up, m/s: past her walk, short of her sprint. */
const STEP_IN_SPEED = 3.5;
const ROAR_TIME = 1.4;
const RECOVER_TIME = 0.5;
const FLINCH_TIME = 0.35;
const POISE_TIME = 1.6;

type State = 'calm' | 'shove' | 'roar' | 'chase' | 'attack' | 'recover' | 'flinch' | 'down';

export class Npc {
  readonly character: Character;
  readonly radius = 0.55;
  health = tuning.npcMaxHealth;
  /** The NPC's temper. The only state an outside system (the judge, or the debug panel) sets, via `setMood`. */
  mood: Mood = 'calm';
  state: State = 'calm';
  private timer = 0;
  private contactAt = 0;
  private endAt = 0;
  private attack: keyof typeof ATTACKS = 'punch';
  private poise = 0;
  private retreating = false;
  private readonly lastPlayer = new THREE.Vector3(NaN);
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

  reset(): void {
    this.health = tuning.npcMaxHealth;
    this.character.place(0, -4, 0);
    this.lastPlayer.setX(NaN);
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
    this.toPlayer.subVectors(player, this.position).setY(0);
    const distance = this.toPlayer.length();
    // Her own speed toward him, whatever he is doing.
    const closing = (this.lastPlayer.sub(player).dot(this.toPlayer) / distance / delta) || 0;
    this.lastPlayer.copy(player);
    const facing = Math.abs(angleTo(this.character.root.rotation.y, yawTo(this.toPlayer)));

    switch (this.state) {
      case 'calm':
        if (distance - Math.max(0, closing) * (SHOVE_LAND + facing / SHOVE_TURN) < SHOVE_REACH) {
          this.enter('shove');
        } else if (distance < (this.retreating ? RETREAT_TO : COMFORT_DISTANCE)) {
          this.retreating = true;
          this.walk(this.retreatHeading(), WALK_SPEED, delta);
        } else {
          this.retreating = false;
          aimToward(this.character, yawTo(this.toPlayer), 1.5, delta);
        }
        break;
      case 'shove':
        turnToward(this.character, yawTo(this.toPlayer), SHOVE_TURN, delta);
        // He wheels round with his palms chambered, endAt unset, then drives them out.
        if (!this.endAt && facing < 0.2) {
          this.endAt = this.timer + SHOVE_TIME;
          this.character.play('push', { loop: false, fade: 0.08 });
        }
        if (this.contactAt > 0 && distance < SHOVE_REACH) {
          this.contactAt = 0;
          events.push({ type: 'shove' });
        }
        if (this.endAt && this.timer >= this.endAt) this.enter('calm');
        break;
      case 'roar':
        turnToward(this.character, yawTo(this.toPlayer), 4, delta);
        if (this.timer >= ROAR_TIME) this.enter('chase');
        break;
      case 'chase': {
        // He swings once she'll still be in reach as the blow lands, judging by her speed toward him: he follows her off.
        const attack = ATTACKS[this.attack];
        if (distance - Math.max(0, closing) * windUp(attack) <= attack.range || distance <= CLINCH) this.startAttack(events);
        else this.walk(this.toPlayer.normalize(), tuning.npcRunSpeed, delta);
        break;
      }
      case 'attack':
        // He tracks her through the wind-up, stepping after her as she backs off: a sprint or dash outruns the blow.
        // Committed after contact: sidestepping late works.
        if (this.contactAt > 0) {
          aimToward(this.character, yawTo(this.toPlayer), 5, delta);
          this.position.addScaledVector(this.toPlayer.normalize(), THREE.MathUtils.clamp(-closing, 0, STEP_IN_SPEED) * delta);
        }
        if (this.contactAt > 0 && this.timer >= this.contactAt) {
          this.contactAt = 0;
          const { hand, knockback } = ATTACKS[this.attack];
          const damage = this.attack === 'punch' ? tuning.punchDamage : tuning.haymakerDamage;
          events.push({ type: 'contact', who: 'npc', heavy: this.attack === 'haymaker', damage, knockback, at: this.character.joint(hand) });
        }
        if (this.timer >= this.endAt) this.enter('recover');
        break;
      case 'recover':
        if (distance > ATTACKS[this.attack].range) this.walk(this.toPlayer.normalize(), WALK_SPEED, delta);
        else aimToward(this.character, yawTo(this.toPlayer), 7, delta);
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
    this.character.running = state === 'chase';
    if (state === 'chase') this.attack = this.rng() < 0.6 ? 'punch' : 'haymaker';
    if (state === 'shove') {
      this.contactAt = 1; // pending: it lands when she reaches his palms
      this.endAt = 0;
      play('push', { loop: false, speed: 0, fade: 0.08 });
    }
    if (state === 'roar') play('roar', { loop: false, from: 1.2, fade: 0.15 });
    if (state === 'flinch') play('hurt', { loop: false, from: 0.1, speed: 1.6, fade: 0.06 });
    if (state === 'down') play('defeat', { loop: false, speed: 1.2, fade: 0.12 });
  }

  private startAttack(events: FightEvent[]): void {
    const attack = ATTACKS[this.attack];
    this.enter('attack');
    this.contactAt = windUp(attack);
    this.endAt = (attack.to - attack.from) / attack.speed;
    this.character.play(this.attack, { loop: false, from: attack.from, speed: attack.speed, fade: 0.1, track: true });
    events.push({ type: 'swing', who: 'npc' });
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
    aimToward(this.character, yawTo(direction), 7, delta);
  }
}
