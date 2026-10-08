import type { Mood } from '../game/events';
import type { VoiceState } from './Voice';

export type Outcome = 'victory' | 'defeat' | null;
export type Screen = 'title' | 'fight' | 'paused';

type HudState = {
  player: number; // 0..1
  npc: number; // 0..1
  mood: Mood;
  screen: Screen;
  voice: VoiceState;
  voiceLeft: number; // 0..1
  regenerating: boolean;
  outcome: Outcome;
  npcHealthLeft: number;
};

const GOALS: Record<Mood, string> = {
  calm: '<b class="enraged">Enrage</b> him to fight',
  enraged: '<b class="calm">Pacify</b> him to rest and heal',
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

/** DOM HUD. Reads one state snapshot per frame and writes only what changed. */
export class Hud {
  private readonly app = $('#app');
  private readonly playerFill = $('.player .fill');
  private readonly playerChip = $('.player .chip');
  private readonly playerSection = $('.fighter.player');
  private readonly npcFill = $('.npc .fill');
  private readonly npcChip = $('.npc .chip');
  private readonly npcPortrait = $<HTMLImageElement>('.npc img');
  private readonly voice = $('#voice');
  private readonly goal = $('#voice p');
  private readonly voiceTimer = $('#voice .timer');
  private readonly result = $('#result');
  private readonly resultTitle = $('#result h1');
  private readonly resultText = $('#result p');
  private chips = { player: 1, npc: 1 };
  private last: Partial<HudState> = {};

  constructor(onRematch: () => void) {
    $('#result button').addEventListener('click', onRematch);
  }

  update(state: HudState, delta: number): void {
    // Chip damage trails the real value, then drains.
    for (const who of ['player', 'npc'] as const) {
      this.chips[who] = state[who] >= this.chips[who] ? state[who] : this.chips[who] - Math.min(this.chips[who] - state[who], delta * 0.5);
    }
    this.playerFill.style.transform = `scaleX(${state.player})`;
    this.playerChip.style.transform = `scaleX(${this.chips.player})`;
    this.npcFill.style.transform = `scaleX(${state.npc})`;
    this.npcChip.style.transform = `scaleX(${this.chips.npc})`;

    if (state.mood !== this.last.mood) {
      this.npcPortrait.className = state.mood;
      this.npcPortrait.alt = state.mood === 'calm' ? 'Calm' : 'Enraged';
      this.npcPortrait.src = `/portraits/gorran-${state.mood}.webp`;
      this.goal.innerHTML = GOALS[state.mood];
      if (this.last.mood) {
        this.npcPortrait.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
        this.goal.animate([{ opacity: 0, transform: 'translateY(8px)' }, {}], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }
    if (state.voice !== this.last.voice) this.voice.className = state.voice;
    // The arc's tail stays at twelve while its head sweeps clockwise after it.
    this.voiceTimer.style.strokeDashoffset = String(state.voiceLeft - 1);
    if (state.screen !== this.last.screen) this.app.dataset.screen = state.screen;
    if (state.regenerating !== this.last.regenerating) this.playerSection.classList.toggle('regen', state.regenerating);
    this.app.classList.toggle('hurt', state.player < 0.3 && !state.outcome);

    if (state.outcome !== this.last.outcome) {
      this.result.hidden = !state.outcome;
      this.voice.hidden = !!state.outcome;
      this.result.className = state.outcome ?? '';
      this.resultTitle.textContent = state.outcome === 'victory' ? 'Victory' : 'Defeat';
      this.resultText.textContent =
        state.outcome === 'victory' ? 'Gorran is down. He never healed.' : `Gorran still had ${state.npcHealthLeft} health. Rest more between rounds.`;
    }
    this.last = { ...state };
  }
}
