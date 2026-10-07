import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { Npc } from '../entities/Npc';
import { Player } from '../entities/Player';
import { Audio } from '../systems/Audio';
import { CameraRig } from '../systems/CameraRig';
import { DebugPanel } from '../systems/DebugPanel';
import { Hud, type Outcome } from '../systems/Hud';
import { Vfx } from '../systems/Vfx';
import { createSeededRandom } from '../utils/random';
import { Arena, SUN_DIRECTION } from '../world/Arena';
import type { FightEvent, Mood } from './events';
import { ARENA_RADIUS, tuning } from './tuning';

const STEP = 1 / 60;
/** Radius of a fist, m. */
const FIST = 0.1;
const arm = new THREE.Line3();
const nearest = new THREE.Vector3();

/** Whether the arm from `from` to the fist `at` meets `body`'s upright cylinder, seen from above. */
function reaches(from: THREE.Vector3, at: THREE.Vector3, body: { position: THREE.Vector3; radius: number }): boolean {
  arm.start.copy(from).setY(0);
  arm.end.copy(at).setY(0);
  return arm.closestPointToPoint(body.position, true, nearest).distanceTo(body.position) <= body.radius + FIST;
}
const PLAYER_RIM = new THREE.Color('#ffd9a0').multiplyScalar(0.3);
const RAGE_RIM = new THREE.Color('#ff3a14').multiplyScalar(0.75);

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  private readonly input: Input;
  private readonly player: Player;
  private readonly npc: Npc;
  private readonly arena: Arena;
  private readonly cameraRig = new CameraRig(this.camera);
  private readonly vfx = new Vfx();
  private readonly audio = new Audio();
  private readonly hud = new Hud(() => this.rematch());
  private readonly debug: DebugPanel;
  private readonly loop = new Loop(
    (delta) => this.update(delta),
    () => this.renderer.render(this.scene, this.camera),
  );
  private readonly events: FightEvent[] = [];
  // All gameplay randomness goes through this seeded RNG so tests stay deterministic.
  private rng = createSeededRandom(1);
  private outcome: Outcome = null;
  private outcomeTimer = 0;
  private hitstop = 0;
  private elapsed = 0;
  private frame = 0;
  private paused = false;
  private readonly offset = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    models: { player: GLTF; npc: GLTF },
  ) {
    this.renderer = createRenderer(canvas);
    this.input = new Input(canvas);
    this.player = new Player(models.player);
    this.npc = new Npc(models.npc, () => this.rng());
    this.arena = new Arena({ a: this.player.position, b: this.npc.position });
    this.debug = new DebugPanel(
      () => this.npc.mood,
      (mood) => this.setMood(mood),
      () => this.rematch(),
    );
    this.buildScene();
    this.rematch();
    this.installTestHooks();
  }

  start(): void {
    this.loop.start();
  }

  /** The NPC's temper: the one input the fight takes from outside (debug panel now, the LLM later). */
  setMood(mood: Mood): void {
    if (this.outcome) return;
    this.npc.setMood(mood, this.events);
    this.debug.sync();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.debug.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private buildScene(): void {
    this.scene.fog = new THREE.Fog('#ead9b8', 70, 650);
    const sun = new THREE.DirectionalLight('#ffd49a', 2.9);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 90 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, new THREE.HemisphereLight('#c8d8f0', '#7d7a3e', 1.2));
    this.scene.add(this.arena.group, this.player.character.root, this.npc.character.root, this.vfx.group);
    this.player.character.rim.value.copy(PLAYER_RIM);
  }

  private rematch(): void {
    this.player.reset();
    this.npc.reset();
    this.outcome = null;
    this.outcomeTimer = 0;
    this.hitstop = 0;
    this.events.length = 0;
    this.input.clear();
    this.debug.sync();
    this.cameraRig.update(0, this.player.position, this.player.yaw, true);
  }

  private update(delta: number): void {
    this.frame += 1;
    resizeRenderer(this.renderer, this.camera);
    if (!this.paused) this.step(delta);
    this.publishDiagnostics();
  }

  private step(delta: number): void {
    this.elapsed += delta;
    if (this.input.consume('rematch') && this.outcome) this.rematch();

    // Hitstop slows the fight, never the camera or effects.
    this.hitstop -= delta;
    const fightDelta = this.hitstop > 0 ? delta * 0.06 : delta;
    const live = !this.outcome;
    this.player.update(fightDelta, live ? this.input : null, this.npc.position, this.npc.mood === 'calm', this.events);
    if (live) this.npc.update(fightDelta, this.player.position, this.events);
    this.resolve();
    // Animate once bodies are where they end up this frame: locomotion shows the actual displacement.
    this.player.character.update(fightDelta);
    this.npc.character.update(fightDelta);
    this.react();
    this.judge(delta);

    const rage = this.npc.mood === 'enraged' && this.npc.state !== 'down';
    this.npc.character.rim.value.lerp(rage ? RAGE_RIM : PLAYER_RIM, 1 - Math.exp(-5 * delta));
    this.vfx.update(delta, this.npc.position, rage ? 'enraged' : 'calm');
    this.arena.update(this.elapsed);
    this.cameraRig.update(delta, this.player.position, this.player.yaw);
    this.hud.update(
      {
        player: this.player.health / tuning.playerMaxHealth,
        npc: this.npc.health / tuning.npcMaxHealth,
        mood: this.npc.mood,
        regenerating: this.npc.mood === 'calm' && this.player.health < tuning.playerMaxHealth && this.player.state !== 'down',
        hint: this.hint(),
        outcome: this.outcomeTimer > 1.4 ? this.outcome : null,
        npcHealthLeft: Math.ceil(this.npc.health),
      },
      delta,
    );
  }

  /** Combat rules: a blow lands only where the fist meets the other's body, and only an enraged NPC is hurt; bodies don't overlap. */
  private resolve(): void {
    for (const event of this.events) {
      if (event.type === 'shove') this.player.shove(this.npc.position);
      if (event.type !== 'contact') continue;
      if (event.who === 'player') {
        if (this.npc.mood === 'enraged' && this.npc.state !== 'down' && reaches(this.player.position, event.at, this.npc)) {
          this.npc.takeHit(event.damage);
          this.events.push({ type: 'hit', who: 'npc', at: event.at, damage: event.damage });
        }
      } else if (reaches(this.npc.position, event.at, this.player) && this.player.takeHit(event.damage, this.npc.position, event.knockback)) {
        this.events.push({ type: 'hit', who: 'player', at: event.at, damage: event.damage });
      }
    }

    const toNpc = this.offset.subVectors(this.npc.position, this.player.position).setY(0);
    const distance = toNpc.length();
    const minimum = this.player.radius + this.npc.radius;
    if (distance < minimum && distance > 0.001) this.player.position.addScaledVector(toNpc, (distance - minimum) / distance);
    for (const body of [this.player.position, this.npc.position]) {
      const r = Math.hypot(body.x, body.z);
      if (r > ARENA_RADIUS) body.multiplyScalar(ARENA_RADIUS / r);
    }
  }

  /** Feedback for this frame's events, then clear them. */
  private react(): void {
    for (const event of this.events) {
      switch (event.type) {
        case 'swing':
          this.audio.swing(event.heavy);
          break;
        case 'hit': {
          // Taking a blow from Gorran is the heavier event.
          const heavy = event.who === 'player';
          this.vfx.hit(event.at, heavy);
          this.audio.hit(heavy);
          this.cameraRig.shake(heavy ? 0.55 : 0.28);
          this.hitstop = heavy ? 0.09 : 0.06;
          break;
        }
        case 'dodge':
          this.vfx.puff(event.at, 4);
          this.audio.whoosh();
          break;
        case 'shove':
          this.vfx.puff(this.player.position, 3);
          this.audio.swing(true);
          break;
        case 'mood':
          if (event.mood === 'enraged') {
            this.vfx.roar();
            this.audio.roar();
            this.cameraRig.shake(0.5);
          } else {
            this.audio.chime();
          }
          break;
        case 'contact':
          break;
      }
    }
    this.events.length = 0;
  }

  private judge(delta: number): void {
    if (this.outcome) {
      this.outcomeTimer += delta;
      return;
    }
    if (this.npc.health <= 0) this.outcome = 'victory';
    else if (this.player.health <= 0) this.outcome = 'defeat';
    if (!this.outcome) return;
    this.audio.stinger(this.outcome === 'victory');
    if (this.outcome === 'defeat') this.npc.standDown();
    this.debug.sync();
  }

  private hint(): string {
    if (this.outcome) return '';
    const health = this.player.health / tuning.playerMaxHealth;
    if (this.npc.mood === 'enraged') return health < 0.35 ? 'You can’t outlast him. Calm him down to rest.' : '';
    if (this.npc.health === tuning.npcMaxHealth && health > 0.99) return 'He won’t fight while calm. Enrage him.';
    return health > 0.95 ? 'Rested. Enrage him to fight on.' : 'He’s calm. Catch your breath.';
  }

  private installTestHooks(): void {
    const settle = (seconds: number) => {
      for (let t = 0; t < seconds; t += STEP) this.step(STEP);
    };
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        this.rematch();
        if (name === 'enraged') {
          this.setMood('enraged');
          settle(3.2);
        } else if (name === 'resting') {
          this.setMood('enraged');
          this.npc.takeHit(150);
          this.player.health = 35;
          this.setMood('calm');
          settle(1.5);
        } else if (name === 'victory') {
          this.setMood('enraged');
          this.npc.takeHit(tuning.npcMaxHealth);
          settle(3);
        } else if (name === 'defeat') {
          this.setMood('enraged');
          settle(1.5);
          this.player.takeHit(tuning.playerMaxHealth, this.npc.position, 3);
          settle(3);
        } else if (name !== 'active-play') {
          throw new Error(`Unknown test state: ${name}`);
        }
        settle(STEP);
        return { state: name };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.paused = paused;
      },
      // Ambient motion runs on fight time, which setPausedForScreenshot already freezes.
      setReducedMotion: () => {},
      hideDebugUi: (hidden: boolean) => this.debug.setHidden(hidden),
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      outcome: this.outcome,
      player: {
        position: { x: this.player.position.x, y: this.player.position.y, z: this.player.position.z },
        yaw: this.player.yaw,
        facing: this.player.character.root.rotation.y,
        speed: this.player.character.velocity.length(),
        stride: this.player.character.stride,
        health: this.player.health,
        state: this.player.state,
      },
      npc: {
        position: { x: this.npc.position.x, y: this.npc.position.y, z: this.npc.position.z },
        stride: this.npc.character.stride,
        health: this.npc.health,
        mood: this.npc.mood,
        state: this.npc.state,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      },
    };
  }
}
