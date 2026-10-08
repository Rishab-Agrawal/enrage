import type { Mood } from '../game/events';
import { voiceFile } from '../game/lines';

/** Music level, under the effects. */
const MUSIC = 0.3;
const START = 'audio/sfx/start.mp3';
/** `count` takes of an effect, to pick from at random. */
const takes = (name: string, count: number) => Array.from({ length: count }, (_, i) => `audio/sfx/${name}-${i + 1}.mp3`);
const STEPS = takes('step', 2);
const HURTS = takes('hurt', 3);
const GRUNTS = takes('grunt', 3);
const HITS = takes('hit', 2);
const HEAVY_HITS = takes('heavy-hit', 3);

/** Web Audio: procedural swings, calm chime, outcome stingers and wind; recorded music, voice and effects. */
export class Audio {
  // Browsers hold a context made before the first click or key press suspended; that press resumes it.
  private readonly context = new AudioContext();
  private readonly master = this.context.createGain();
  private readonly noise = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
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
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    // Wind bed: looped noise through a slowly wandering band-pass.
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.6;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 0.07;
    depth.gain.value = 180;
    lfo.connect(depth).connect(band.frequency);
    const level = ctx.createGain();
    level.gain.value = 0.05;
    wind.connect(band).connect(level).connect(this.master);
    wind.start();
    lfo.start();

    // Both loops run throughout; the mood only moves their gains.
    for (const mood of ['calm', 'enraged'] as const) {
      const gain = ctx.createGain();
      gain.gain.value = mood === this.mood ? MUSIC : 0;
      gain.connect(this.master);
      this.tracks.set(mood, gain);
      void this.load(`audio/music/${mood}.mp3`).then((buffer) => this.play(buffer, gain, true));
    }
    for (const url of [START, ...STEPS, ...HURTS, ...GRUNTS, ...HITS, ...HEAVY_HITS]) void this.load(url);
  }

  /** The fight begins. */
  start(): void {
    void this.load(START).then((buffer) => this.play(buffer));
  }

  /** One of Wren's footfalls on the grass, firmer at a run. */
  step(running: boolean): void {
    this.vary(STEPS, running ? 1.5 : 1);
  }

  /** Wren cries out as a blow lands on her. */
  hurt(): void {
    this.vary(HURTS, 0.7);
  }

  /** Wren's effort behind her cross. */
  grunt(): void {
    this.vary(GRUNTS, 0.7);
  }

  swing(heavy: boolean): void {
    this.noiseBurst(heavy ? 0.32 : 0.18, heavy ? 500 : 1400, heavy ? 1800 : 4200, heavy ? 0.22 : 0.16);
  }

  /** A blow lands; `heavy` for Gorran's, on her. */
  hit(heavy: boolean): void {
    this.vary(heavy ? HEAVY_HITS : HITS, 1);
  }

  whoosh(): void {
    this.noiseBurst(0.28, 600, 2400, 0.18);
  }

  chime(): void {
    [523.25, 659.25, 783.99].forEach((f, i) => this.tone(f, 0.12 * i, 1.4, 0.08, 'sine'));
  }

  stinger(won: boolean): void {
    const notes = won ? [392, 493.88, 587.33, 783.99] : [329.63, 311.13, 261.63, 196];
    notes.forEach((f, i) => this.tone(f, i * 0.16, 1.6, 0.1, won ? 'triangle' : 'sine'));
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

  private noiseBurst(duration: number, from: number, to: number, volume: number): void {
    const ctx = this.context;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(from, now);
    filter.frequency.exponentialRampToValueAtTime(to, now + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now, Math.random());
    source.stop(now + duration);
  }

  private tone(frequency: number, delay: number, duration: number, volume: number, type: OscillatorType): void {
    const ctx = this.context;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + duration);
  }
}
