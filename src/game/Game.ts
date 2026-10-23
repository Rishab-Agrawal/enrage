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
import { Hud, type Outcome, type Screen } from '../systems/Hud';
import { Speech } from '../systems/Speech';
import { Vfx } from '../systems/Vfx';
import { Voice } from '../systems/Voice';
import { createSeededRandom } from '../utils/random';
import { Arena, SUN_DIRECTION } from '../world/Arena';
import type { FightEvent, Mood } from './events';
import { LINES } from './lines';
import { ARENA_RADIUS, tuning } from './tuning';

const STEP = 1 / 60;
/** How long a line of Gorran's stays up, s. */
const LINE_TIME = 2.5;
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
  private readonly voice = new Voice();
  private readonly speech = new Speech((text) => this.hear(text));
  private readonly hud = new Hud(() => this.rematch());
  /** Development only, like the test hooks and diagnostics: the deployed game has none of them. */
  private readonly debug?: DebugPanel;
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
  private line = '';
  private lineLeft = 0;
  /** Her lines that turned his mood this fight: one that repeats them doesn't work again. */
  private worked: string[] = [];
  /** This fight's id: a verdict from an earlier one is moot, and LangSmith threads the fight's verdicts by it. */
  private fight = '';
  private frame = 0;
  private screen: Screen = 'title';
  /** Held still for screenshots, without the pause card. */
  private frozen = false;
  private readonly offset = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    models: { player: GLTF; npc: GLTF },
  ) {
    this.renderer = createRenderer(canvas);
    // The mic's permission prompt comes with the click that starts the fight, and it has warmed up by her first turn.
    this.input = new Input(canvas, () => this.speech.open());
    this.player = new Player(models.player);
    this.npc = new Npc(models.npc, () => this.rng());
    this.arena = new Arena({ a: this.player.position, b: this.npc.position });
    if (import.meta.env.DEV) {
      this.debug = new DebugPanel(
        () => this.npc.mood,
        (mood) => this.setMood(mood),
        () => this.rematch(),
      );
    }
    this.buildScene();
    this.rematch();
    if (import.meta.env.DEV) this.installTestHooks();
  }

  start(): void {
    this.loop.start();
  }

  /** The NPC's temper: the one input the fight takes from outside (the judge, or the debug panel). */
  setMood(mood: Mood): void {
    if (this.outcome) return;
    this.npc.setMood(mood, this.events);
    this.debug?.sync();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.debug?.dispose();
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
    this.line = '';
    this.worked = [];
    this.fight = crypto.randomUUID();
    this.input.clear();
    this.debug?.sync();
    this.cameraRig.update(0, this.player.position, this.player.yaw, true);
  }

  private update(delta: number): void {
    this.frame += 1;
    resizeRenderer(this.renderer, this.camera);
    // Losing the mouse (Esc, alt-tab) pauses the fight; capturing it starts or resumes it.
    if (this.input.consume('pause') && this.screen === 'fight' && !this.outcome) this.show('paused');
    else if (this.screen !== 'fight' && this.input.captured) {
      if (this.screen === 'title') {
        this.audio.start();
        void fetch('/api/play', { method: 'POST' });
      }
      this.show('fight');
    }
    const running = this.screen !== 'paused' && !this.frozen;
    if (running) this.step(delta);
    this.speech.hold(this.voice.state === 'listening');
    this.hud.update(
      {
        player: this.player.health / tuning.playerMaxHealth,
        npc: this.npc.health / tuning.npcMaxHealth,
        stamina: this.player.stamina / tuning.playerStamina,
        winded: this.player.winded,
        mood: this.npc.mood,
        screen: this.screen,
        voice: this.voice.state,
        voiceLeft: this.voice.remaining,
        line: this.line,
        regenerating: this.npc.mood === 'calm' && this.player.health < tuning.playerMaxHealth && this.player.state !== 'down',
        outcome: this.outcomeTimer > 1.4 ? this.outcome : null,
        npcHealthLeft: Math.ceil(this.npc.health),
      },
      running ? delta : 0,
    );
    if (import.meta.env.DEV) this.publishDiagnostics();
  }

  private show(screen: Screen): void {
    this.screen = screen;
    // A pause lets go of the mic, and presses made off the fight don't carry into it.
    this.voice.update(0, false, false);
    this.input.clear();
  }

  private step(delta: number): void {
    this.elapsed += delta;
    if (this.input.consume('rematch') && this.outcome) this.rematch();
    const playing = this.screen === 'fight';
    if (playing) this.voice.update(delta, this.input.consume('speak'), this.input.speaking);
    this.lineLeft -= delta;
    if (this.lineLeft <= 0) this.line = '';

    // Hitstop slows the fight, never the camera or effects.
    this.hitstop -= delta;
    const fightDelta = this.hitstop > 0 ? delta * 0.06 : delta;
    const live = !this.outcome;
    // Controls wait for the camera to glide in behind her: the hand that clicked to start is still settling on the mouse.
    this.input.still = this.cameraRig.gliding;
    this.player.update(fightDelta, live && playing ? this.input : null, this.npc.position, this.npc.mood === 'calm', this.events);
    if (live) this.npc.update(fightDelta, this.player.position, this.events);
    this.resolve();
    // Animate once bodies are where they end up this frame: locomotion shows the actual displacement.
    this.player.character.update(fightDelta);
    if (this.player.character.stepped) this.audio.step(this.player.character.running);
    this.npc.character.update(fightDelta);
    this.react();
    this.judge(delta);

    const rage = this.npc.mood === 'enraged' && this.npc.state !== 'down';
    this.npc.character.rim.value.lerp(rage ? RAGE_RIM : PLAYER_RIM, 1 - Math.exp(-5 * delta));
    this.vfx.update(delta, this.npc.position, rage ? 'enraged' : 'calm');
    // He stands down once she's beaten, but the music stays with the loss until the rematch.
    this.audio.music(rage || this.outcome === 'defeat' ? 'enraged' : 'calm');
    this.arena.update(this.elapsed);
    if (playing) this.cameraRig.update(delta, this.player.position, this.player.yaw);
    else this.cameraRig.title(this.elapsed, this.offset.addVectors(this.player.position, this.npc.position).multiplyScalar(0.5));
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
          this.audio.swing(event.who);
          break;
        case 'hit': {
          // Taking a blow from Gorran is the heavier event.
          const heavy = event.who === 'player';
          this.vfx.hit(event.at, heavy);
          this.audio.hit(heavy);
          if (event.who === 'npc' && this.npc.health <= 0) this.audio.fall();
          else this.audio.hurt(event.who);
          this.cameraRig.shake(heavy ? 0.55 : 0.28);
          this.hitstop = heavy ? 0.09 : 0.06;
          break;
        }
        case 'dodge':
          this.vfx.puff(event.at, 4);
          break;
        case 'shove':
          this.vfx.puff(this.player.position, 3);
          this.audio.swing('npc');
          // He doesn't repeat himself over every shove.
          if (!this.line) this.say(LINES.shove);
          break;
        case 'mood':
          this.say(LINES.mood[event.mood]);
          if (event.mood === 'enraged') {
            this.vfx.roar();
            this.cameraRig.shake(0.5);
          } else {
            this.audio.chime();
          }
          break;
        case 'contact':
          // She puts her voice into the cross.
          if (event.who === 'player' && event.heavy) this.audio.grunt();
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
    // Losing needs no stinger: his gloat and the enraged music carry it.
    if (this.outcome === 'victory') this.audio.victory();
    if (this.outcome === 'defeat') {
      this.npc.standDown();
      this.say(LINES.won);
    }
    this.debug?.sync();
  }

  /** Her turn at the mic, as heard: his mood turns if the judge says her words do, else he answers as he is. */
  private async hear(text: string): Promise<void> {
    this.debug?.heard(text);
    if (this.outcome) return;
    const { worked, fight } = this;
    const mood = this.npc.mood;
    let turns = false;
    if (text) {
      // The server asks Jev (`server/judge.ts`); a failure leaves him unmoved.
      turns = await fetch('/api/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood, worked, newest: text, fight }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return ((await response.json()) as { turns: boolean }).turns;
        })
        .catch((error) => {
          console.warn('Judge failed:', error);
          return false;
        });
    }
    // A verdict that lands after the fight ended, or a rematch began, is moot.
    if (this.outcome || fight !== this.fight) return;
    if (turns) {
      worked.push(text);
      this.setMood(mood === 'calm' ? 'enraged' : 'calm');
    } else {
      this.say(LINES.unmoved[this.npc.mood]);
    }
  }

  /** A line from `lines` other than the one he just said, cosmetic so off the seeded RNG. */
  private say(lines: string[]): void {
    const fresh = lines.filter((line) => line !== this.line);
    this.line = fresh[Math.floor(Math.random() * fresh.length)];
    this.audio.speak(this.line);
    this.lineLeft = LINE_TIME;
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
        this.show('fight');
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
        this.frozen = paused;
      },
      // Ambient motion runs on fight time, which setPausedForScreenshot already freezes.
      setReducedMotion: () => {},
      hideDebugUi: (hidden: boolean) => this.debug?.setHidden(hidden),
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
        stamina: this.player.stamina,
        state: this.player.state,
        still: this.input.still,
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
