/** Longest the mic listens per press, s. */
export const LISTEN = 20;
/** The mic rests this long after each turn, s, so talk can't be spammed. */
export const COOLDOWN = 5;

export type VoiceState = 'ready' | 'listening' | 'cooldown';

/** Push-to-talk turns: a fresh press opens the mic, which closes on release or after LISTEN, then rests for COOLDOWN. */
export class Voice {
  state: VoiceState = 'ready';
  /** Seconds left in this state. */
  left = 0;

  update(delta: number, pressed: boolean, held: boolean): void {
    this.left -= delta;
    if (this.state === 'ready' && pressed) this.enter('listening', LISTEN);
    else if (this.state === 'listening' && (!held || this.left <= 0)) this.enter('cooldown', COOLDOWN);
    else if (this.state === 'cooldown' && this.left <= 0) this.enter('ready', 0);
  }

  /** Fraction of this state's time left, 0..1. */
  get remaining(): number {
    return this.state === 'listening' ? this.left / LISTEN : this.state === 'cooldown' ? this.left / COOLDOWN : 0;
  }

  private enter(state: VoiceState, seconds: number): void {
    this.state = state;
    this.left = seconds;
  }
}
