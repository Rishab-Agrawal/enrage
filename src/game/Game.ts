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
import { SEA_LEVEL, groundHeight, groundSlope } from '../world/terrain';
import { secondsTo } from '../world/Sky';
import { type Obstacle, World, pushOut, within } from '../world/World';
import type { FightEvent, Mood } from './events';
import { LINES } from './lines';
import { ARENA_RADIUS, inArena, inFight, near, tuning } from './tuning';

const STEP = 1 / 60;
/** How long a line of Gorran's stays up, s. */
const LINE_TIME = 2.5;
/** Radius of a fist, m. */
const FIST = 0.1;
/** Out of the fight this long, s, she has left it. */
const LEAVE_TIME = 5;
/** The steepest ground she climbs, m risen per m; the steepest she steps down, past which is a cliff; and the deepest water she wades, m. */
const MAX_SLOPE = 0.8;
const CLIFF = 1.1;
const WADE_DEPTH = 0.8;
const [shoulder, fist] = [new THREE.Vector2(), new THREE.Vector2()];

/** Whether the arm from `from` to the fist `at` meets `body`, seen from above. */
function reaches(from: THREE.Vector3, at: THREE.Vector3, body: Obstacle): boolean {
  // In the body's frame it is the unit circle: the arm meets it where the arm's nearest point to the middle lies inside.
  within(body, from.x, from.z, FIST, shoulder);
  within(body, at.x, at.z, FIST, fist).sub(shoulder);
  const along = THREE.MathUtils.clamp(-shoulder.dot(fist) / fist.lengthSq() || 0, 0, 1);
  return shoulder.addScaledVector(fist, along).lengthSq() <= 1;
}
/** A fighter's body as an obstacle: an upright cylinder. */
const cylinder = ({ position, radius }: { position: THREE.Vector3; radius: number }): Obstacle => ({ x: position.x, z: position.z, along: radius, across: radius, cos: 1, sin: 0 });
/** Daylight catching a fighter's edges, and the glow of his rage. */
const DAY_RIM = new THREE.Color('#ffd9a0').multiplyScalar(0.3);
const NIGHT_FILL = new THREE.Color('#9db4ff').multiplyScalar(0.45);
const RAGE_RIM = new THREE.Color('#ff3a14').multiplyScalar(0.75);

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  private readonly input: Input;
  private readonly player: Player;
  private readonly npc: Npc;
  private readonly world: World;
  private readonly cameraRig = new CameraRig(this.camera);
  private readonly vfx = new Vfx();
  private readonly audio = new Audio();
  private readonly voice = new Voice();
  private readonly speech = new Speech((text) => this.hear(text));
  private readonly hud = new Hud(
    () => this.rematch(),
    () => this.openMap(),
    () => this.travel(),
  );
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
  /** Seconds she has been out of the fight. */
  private away = 0;
  /** Where she stood before this frame moved her. */
  private readonly from = new THREE.Vector3();
  private readonly slope = new THREE.Vector2();
  private readonly rim = new THREE.Color();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    models: { player: GLTF; npc: GLTF },
  ) {
    this.renderer = createRenderer(canvas);
    // The mic's permission prompt comes with the click or tap that starts the fight, and it has warmed up by her first turn.
    this.input = new Input(canvas, () => this.speech.open());
    this.player = new Player(models.player);
    this.npc = new Npc(models.npc, () => this.rng());
    this.world = new World(this.player.position, this.npc.position);
    this.world.paintMap(this.hud.map);
    if (import.meta.env.DEV) {
      this.debug = new DebugPanel(
        () => this.npc.mood,
        (mood) => this.setMood(mood),
        () => this.rematch(),
        (hour) => {
          this.elapsed += secondsTo(hour, this.elapsed);
          this.world.update(this.elapsed, this.camera);
        },
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
    this.scene.fog = this.world.sky.fog;
    this.scene.add(this.world.group, this.player.character.root, this.npc.character.root, this.vfx.group);
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
    this.away = 0;
    this.input.clear();
    this.debug?.sync();
    this.cameraRig.update(0, this.player.position, this.player.yaw, true);
  }

  private update(delta: number): void {
    this.frame += 1;
    resizeRenderer(this.renderer, this.camera);
    // Losing the mouse (Esc, alt-tab), or on touch the screen, pauses the fight; capturing it starts or resumes it.
    if (this.input.consume('pause') && this.screen === 'fight' && !this.outcome) this.show('paused');
    else if (this.screen !== 'fight' && this.input.captured) {
      if (this.screen === 'title') {
        this.audio.start();
        void fetch('/api/play', { method: 'POST' });
      }
      this.show('fight');
    }
    // M opens the map and closes it again; so does a click outside it, capturing the mouse.
    if (this.input.consume('map') && this.screen !== 'title') {
      if (this.screen === 'map') void this.input.capture();
      else this.openMap();
    }
    const running = (this.screen === 'fight' || this.screen === 'title') && !this.frozen;
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
        away: this.away > 0,
        wren: { x: this.player.position.x, z: this.player.position.z, yaw: this.player.yaw },
        gorran: { x: this.npc.position.x, z: this.npc.position.z },
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

  /** The map holds the fight, and frees the mouse, or on touch the screen, to use it. */
  private openMap(): void {
    // A click inside the open map, as on Gorran to travel, is not another opening: it would let go of the capture he asked for.
    if (this.screen === 'map') return;
    this.show('map');
    this.input.release();
  }

  /** A click on Gorran in the open map takes her back to where she first faced him, and closes the map. */
  private travel(): void {
    if (this.screen !== 'map') return;
    this.player.toStart();
    this.cameraRig.update(0, this.player.position, this.player.yaw, true);
    void this.input.capture();
  }

  private step(delta: number): void {
    this.elapsed += delta;
    if (this.input.consume('rematch') && this.outcome) this.rematch();
    const playing = this.screen === 'fight';
    // He only hears her in the fight: out of it, the mic lets go.
    const heard = inFight(this.player.position, this.npc.position);
    if (playing) this.voice.update(delta, this.input.consume('speak') && heard, this.input.speaking && heard);
    this.lineLeft -= delta;
    if (this.lineLeft <= 0) this.line = '';

    // Hitstop slows the fight, never the camera or effects.
    this.hitstop -= delta;
    const fightDelta = this.hitstop > 0 ? delta * 0.06 : delta;
    const live = !this.outcome;
    // Controls wait for the camera to glide in behind her: the hand that clicked to start is still settling on the mouse.
    this.input.still = this.cameraRig.gliding;
    this.from.copy(this.player.position);
    this.player.update(fightDelta, live && playing ? this.input : null, this.npc.position, this.npc.mood === 'calm', this.events);
    if (live) this.npc.update(fightDelta, this.player.position, this.events);
    this.resolve();
    // Animate once bodies are where they end up this frame: locomotion shows the actual displacement.
    this.player.character.update(fightDelta);
    if (this.player.character.stepped) this.audio.step(this.player.character.running);
    this.npc.character.update(fightDelta);
    this.react();
    this.judge(delta);
    this.away = heard ? 0 : this.away + delta;
    // Out of the arena with him, she leaves the fight as soon as she gets away from him.
    const fled = this.npc.mood === 'enraged' && !inArena(this.npc.position) && !near(this.player.position, this.npc.position);
    if (live && (fled || (this.away >= LEAVE_TIME && this.away - delta < LEAVE_TIME))) this.disengage();

    const rage = this.npc.mood === 'enraged' && this.npc.state !== 'down';
    // The daylight on their edges goes out with the day; by night they keep a cool light of their own.
    const rim = this.rim.copy(DAY_RIM).multiplyScalar(1 - this.world.sky.night);
    for (const { character } of [this.player, this.npc]) character.fill.value.copy(NIGHT_FILL).multiplyScalar(this.world.sky.night);
    this.player.character.rim.value.copy(rim);
    this.npc.character.rim.value.lerp(rage ? RAGE_RIM : rim, 1 - Math.exp(-5 * delta));
    this.vfx.update(delta, this.npc.position, rage ? 'enraged' : 'calm');
    // He stands down once she's beaten, but the music stays with the loss until the rematch.
    this.audio.music(rage || this.outcome === 'defeat' ? 'enraged' : 'calm');
    if (playing) {
      this.cameraRig.tilt(this.input.consumeTilt() * tuning.mouseTurn);
      this.cameraRig.update(delta, this.player.position, this.player.yaw);
    }
    else this.cameraRig.title(this.elapsed, this.offset.addVectors(this.player.position, this.npc.position).multiplyScalar(0.5));
    this.world.update(this.elapsed, this.camera);
  }

  /**
   * Combat rules: a blow lands only where the fist meets the other's body, and only an enraged NPC is hurt; bodies don't
   * overlap. Both stand on the ground and go round whatever is solid: he keeps within twice the arena's radius, and she
   * roams wherever the land lets her.
   */
  private resolve(): void {
    for (const event of this.events) {
      if (event.type === 'shove') this.player.shove(this.npc.position);
      if (event.type !== 'contact') continue;
      if (event.who === 'player') {
        if (this.npc.mood === 'enraged' && this.npc.state !== 'down' && reaches(this.player.position, event.at, cylinder(this.npc))) {
          this.npc.takeHit(event.damage);
          this.events.push({ type: 'hit', who: 'npc', at: event.at, damage: event.damage });
        } else if (this.world.obstacles.some((obstacle) => reaches(this.player.position, event.at, obstacle))) {
          this.events.push({ type: 'thud', at: event.at });
        }
      } else if (reaches(this.npc.position, event.at, cylinder(this.player)) && this.player.takeHit(event.damage, this.npc.position, event.knockback)) {
        this.events.push({ type: 'hit', who: 'player', at: event.at, damage: event.damage });
      }
    }

    const toNpc = this.offset.subVectors(this.npc.position, this.player.position).setY(0);
    const distance = toNpc.length();
    const minimum = this.player.radius + this.npc.radius;
    if (distance < minimum && distance > 0.001) this.player.position.addScaledVector(toNpc, (distance - minimum) / distance);
    const r = Math.hypot(this.npc.position.x, this.npc.position.z);
    if (r > 2 * ARENA_RADIUS) this.npc.position.multiplyScalar((2 * ARENA_RADIUS) / r);
    // Twice over: pushed out of one, a body may stand in its neighbour.
    for (const { position, radius } of [this.player, this.npc]) {
      for (let pass = 0; pass < 2; pass += 1) for (const obstacle of this.world.obstacles) pushOut(obstacle, position, radius);
    }
    this.roam();
    for (const body of [this.player.position, this.npc.position]) body.y = groundHeight(body.x, body.z);
  }

  /** The land turns her aside: off slopes too steep to climb, back from cliffs' edges and out of water too deep to wade. */
  private roam(): void {
    const body = this.player.position;
    const slope = groundSlope(body.x, body.z, this.slope);
    const steepness = slope.lengthSq();
    // Metres this frame's step climbed: taken back along the slope where she can't climb, or can't go deeper.
    const climb = (body.x - this.from.x) * slope.x + (body.z - this.from.z) * slope.y;
    if (climb > 0 ? steepness > MAX_SLOPE ** 2 : groundHeight(body.x, body.z) < SEA_LEVEL - WADE_DEPTH) {
      body.x -= (slope.x * climb) / steepness;
      body.z -= (slope.y * climb) / steepness;
    }
    // That slope is an estimate. Whatever it says, no step drops her off a cliff or takes her well out of her depth.
    const fall = groundHeight(this.from.x, this.from.z) - groundHeight(body.x, body.z);
    const sheer = fall > CLIFF * Math.hypot(body.x - this.from.x, body.z - this.from.z);
    if (sheer || (fall > 0 && groundHeight(body.x, body.z) < SEA_LEVEL - WADE_DEPTH - 0.15)) body.copy(this.from);
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
        case 'thud':
          this.vfx.hit(event.at, false);
          this.audio.hit(false);
          break;
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

  /** She has left him be: he calms down without a word, whole again, and nothing said in the fight she left counts in the next. */
  private disengage(): void {
    this.npc.health = tuning.npcMaxHealth;
    this.npc.standDown();
    this.debug?.sync();
    this.worked = [];
    this.fight = crypto.randomUUID();
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
      place: (x: number, z: number, yaw: number) => this.player.character.place(x, z, yaw),
      advance: (seconds: number) => {
        this.elapsed += seconds;
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
      camera: { pitch: this.cameraRig.pitch },
      night: this.world.sky.night,
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
        dpr: this.renderer.getPixelRatio(),
      },
    };
  }
}
