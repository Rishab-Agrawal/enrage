import type { Mood } from '../game/events';

export type Outcome = 'victory' | 'defeat' | null;

type HudState = {
  player: number; // 0..1
  npc: number; // 0..1
  mood: Mood;
  regenerating: boolean;
  hint: string;
  outcome: Outcome;
  npcHealthLeft: number;
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
  private readonly hint = $('#hint');
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
      if (this.last.mood) this.npcPortrait.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    if (state.regenerating !== this.last.regenerating) this.playerSection.classList.toggle('regen', state.regenerating);
    if (state.hint !== this.last.hint) this.hint.textContent = state.hint;
    this.app.classList.toggle('hurt', state.player < 0.3 && !state.outcome);

    if (state.outcome !== this.last.outcome) {
      this.result.hidden = !state.outcome;
      this.result.className = state.outcome ?? '';
      this.resultTitle.textContent = state.outcome === 'victory' ? 'Victory' : 'Defeat';
      this.resultText.textContent =
        state.outcome === 'victory' ? 'Gorran is down. He never healed.' : `Gorran still had ${state.npcHealthLeft} health. Rest more between rounds.`;
    }
    this.last = { ...state };
  }
}
