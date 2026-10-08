import type { Mood } from '../game/events';
import { voiceFile } from '../game/lines';

/** Music level, under the effects. */
const MUSIC = 0.3;

/** Web Audio: procedural impacts, swings, roar, calm chime, outcome stingers and wind; a music loop per mood; Gorran's voice. */
export class Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly tracks = new Map<Mood, GainNode>();
  private mood: Mood = 'calm';
  private readonly recordings = new Map<string, Promise<AudioBuffer>>();
  private said = '';
  private voice: AudioBufferSourceNode | null = null;

  constructor() {
    const unlock = () => {
      this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  swing(heavy: boolean): void {
    this.noiseBurst(heavy ? 0.32 : 0.18, heavy ? 500 : 1400, heavy ? 1800 : 4200, heavy ? 0.22 : 0.16);
  }

  hit(heavy: boolean): void {
    this.thump(heavy ? 70 : 120, heavy ? 0.5 : 0.32, heavy ? 0.9 : 0.6);
    this.noiseBurst(0.08, 2500, 900, heavy ? 0.5 : 0.35);
  }

  whoosh(): void {
    this.noiseBurst(0.28, 600, 2400, 0.18);
  }

  roar(): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(95, now);
    osc.frequency.linearRampToValueAtTime(70, now + 1.1);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.linearRampToValueAtTime(1200, now + 0.25);
    filter.frequency.linearRampToValueAtTime(250, now + 1.1);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 1.25);
    this.noiseBurst(1.0, 400, 900, 0.25);
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
    const ctx = this.context;
    if (!ctx) return;
    for (const [track, gain] of this.tracks) gain.gain.setTargetAtTime(track === mood ? MUSIC : 0, ctx.currentTime, 0.6);
  }

  /** Gorran says `line` aloud, cutting off whatever he was saying. */
  speak(line: string): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    const master = this.master;
    this.said = line;
    if (!this.recordings.has(line)) this.recordings.set(line, this.load(voiceFile(line)));
    void this.recordings.get(line)!.then((buffer) => {
      // A later line may have loaded first.
      if (this.said !== line) return;
      this.voice?.stop();
      this.voice = ctx.createBufferSource();
      this.voice.buffer = buffer;
      this.voice.connect(master);
      this.voice.start();
    });
  }

  private load(url: string): Promise<AudioBuffer> {
    return fetch(url)
      .then((response) => response.arrayBuffer())
      .then((data) => this.context!.decodeAudioData(data));
  }

  private unlock(): void {
    if (this.context) return;
    const ctx = new AudioContext();
    this.context = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
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
      void this.load(`audio/music/${mood}.mp3`).then((buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
      });
    }
  }

  private noiseBurst(duration: number, from: number, to: number, volume: number): void {
    const ctx = this.context;
    if (!ctx || !this.master || !this.noise) return;
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

  private thump(frequency: number, duration: number, volume: number): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(frequency * 2.2, now);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.6, now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + duration);
  }

  private tone(frequency: number, delay: number, duration: number, volume: number, type: OscillatorType): void {
    const ctx = this.context;
    if (!ctx || !this.master) return;
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
