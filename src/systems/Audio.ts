import type { Fighter, Mood } from '../game/events';
import { voiceFile } from '../game/lines';

/** Music level, under the effects. */
const MUSIC = 0.3;
/** Ambience levels, under the music: the breeze, and a bird at its loudest. */
const WIND = 0.5;
const BIRD = 0.06;
const START = 'audio/sfx/start.mp3';
const CHIME = 'audio/sfx/chime.mp3';
const VICTORY = 'audio/sfx/victory.mp3';
/** `count` takes of an effect, to pick from at random. */
const takes = (name: string, count: number) => Array.from({ length: count }, (_, i) => `audio/sfx/${name}-${i + 1}.mp3`);
const STEPS = takes('step', 2);
const HURTS = { player: takes('wren-hurt', 3), npc: takes('gorran-hurt', 2) };
const GRUNTS = takes('wren-grunt', 3);
const FALLS = takes('gorran-down', 2);
const SWINGS = { player: takes('wren-swing', 1), npc: takes('gorran-swing', 2) };
const HITS = takes('hit', 2);
const HEAVY_HITS = takes('heavy-hit', 3);
const BIRDS = takes('bird', 4);

/** Web Audio: recorded music, ambience, voices and effects. */
export class Audio {
  // Browsers hold a context made before the first click or key press suspended; that press resumes it.
  private readonly context = new AudioContext();
  private readonly master = this.context.createGain();
  private readonly tracks = new Map<Mood, GainNode>();
  private mood: Mood = 'calm';
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private said = '';
  private voice: AudioBufferSourceNode | null = null;

  constructor() {
    const ctx = this.context;
    const resume = () => {
      void ctx.resume();
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);

    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    // Ambience: a looped breeze, and every 12 to 30 s a bird far off. A bird waits for sound to be allowed,
    // or every one held back would sing at once.
    const wind = ctx.createGain();
    wind.gain.value = WIND;
    wind.connect(this.master);
    void this.load('audio/sfx/wind.mp3').then((buffer) => this.play(buffer, wind, true));
    const sing = () => {
      if (ctx.state === 'running') this.vary(BIRDS, BIRD * (0.5 + Math.random() * 0.5));
      setTimeout(sing, 12000 + Math.random() * 18000);
    };
    setTimeout(sing, 6000);

    // Both loops run throughout; the mood only moves their gains.
    for (const mood of ['calm', 'enraged'] as const) {
      const gain = ctx.createGain();
      gain.gain.value = mood === this.mood ? MUSIC : 0;
      gain.connect(this.master);
      this.tracks.set(mood, gain);
      void this.load(`audio/music/${mood}.mp3`).then((buffer) => this.play(buffer, gain, true));
    }
    for (const url of [START, CHIME, VICTORY, ...STEPS, ...HURTS.player, ...HURTS.npc, ...GRUNTS, ...FALLS, ...SWINGS.player, ...SWINGS.npc, ...HITS, ...HEAVY_HITS, ...BIRDS]) void this.load(url);
  }

  /** The fight begins. */
  start(): void {
    void this.load(START).then((buffer) => this.play(buffer));
  }

  /** One of Wren's footfalls on the grass, firmer at a run. */
  step(running: boolean): void {
    this.vary(STEPS, running ? 1.5 : 1);
  }

  /** `who` cries out as a blow lands. */
  hurt(who: Fighter): void {
    this.vary(HURTS[who], 0.7);
  }

  /** Gorran groans as he goes down. */
  fall(): void {
    this.vary(FALLS, 1);
  }

  /** Wren's effort behind her cross. */
  grunt(): void {
    this.vary(GRUNTS, 0.7);
  }

  /** `who` swings a fist through the air. */
  swing(who: Fighter): void {
    this.vary(SWINGS[who], who === 'player' ? 0.5 : 0.7);
  }

  /** A blow lands; `heavy` for Gorran's, on her. */
  hit(heavy: boolean): void {
    this.vary(heavy ? HEAVY_HITS : HITS, 1);
  }

  /** Gorran calms down. */
  chime(): void {
    void this.load(CHIME).then((buffer) => this.play(buffer));
  }

  victory(): void {
    void this.load(VICTORY).then((buffer) => this.play(buffer));
  }

  /** Crossfades the music to `mood`'s loop. */
  music(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    for (const [track, gain] of this.tracks) gain.gain.setTargetAtTime(track === mood ? MUSIC : 0, this.context.currentTime, 0.6);
  }

  /** Gorran says `line` aloud, cutting off whatever he was saying. */
  speak(line: string): void {
    this.said = line;
    void this.load(voiceFile(line)).then((buffer) => {
      // A later line may have loaded first.
      if (this.said !== line) return;
      this.voice?.stop();
      this.voice = this.play(buffer);
    });
  }

  /** One of `urls` at random, slightly retuned so repeats differ. */
  private vary(urls: string[], volume: number): void {
    const gain = this.context.createGain();
    gain.gain.value = volume;
    gain.connect(this.master);
    void this.load(urls[Math.floor(Math.random() * urls.length)]).then((buffer) => {
      this.play(buffer, gain).playbackRate.value = 0.95 + Math.random() * 0.1;
    });
  }

  /** `url`'s decoded audio, fetched once. */
  private load(url: string): Promise<AudioBuffer> {
    let buffer = this.buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => this.context.decodeAudioData(data));
      this.buffers.set(url, buffer);
    }
    return buffer;
  }

  private play(buffer: AudioBuffer, out: AudioNode = this.master, loop = false): AudioBufferSourceNode {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(out);
    source.start();
    return source;
  }
}
