import type { Mood } from '../game/events';
import { MAP_SIZE } from '../world/terrain';
import type { VoiceState } from './Voice';

export type Outcome = 'victory' | 'defeat' | null;
export type Screen = 'title' | 'fight' | 'brief' | 'paused' | 'map';

type HudState = {
  player: number; // 0..1
  npc: number; // 0..1
  stamina: number; // 0..1
  winded: boolean;
  mood: Mood;
  screen: Screen;
  voice: VoiceState;
  voiceLeft: number; // 0..1
  line: string;
  regenerating: boolean;
  outcome: Outcome;
  npcHealthLeft: number;
  /** She is out of the arena, where he can't hear her. */
  away: boolean;
  /** His bar shows: she is in the arena, or he is enraged. */
  rival: boolean;
  /** Where the two stand, m, and the yaw she faces. */
  wren: { x: number; z: number; yaw: number };
  gorran: { x: number; z: number };
};

const GOALS: Record<Mood, string> = {
  calm: '<b class="enraged">Enrage</b> him to fight',
  enraged: '<b class="calm">Pacify</b> him to rest and heal',
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

/** Puts a map marker where (x, z) lies on the map, north up. */
function mark(marker: HTMLElement, { x, z }: { x: number; z: number }): void {
  marker.style.left = `${(x / MAP_SIZE + 0.5) * 100}%`;
  marker.style.top = `${(z / MAP_SIZE + 0.5) * 100}%`;
}

/** DOM HUD. Reads one state snapshot per frame and writes only what changed. */
export class Hud {
  private readonly app = $('#app');
  private readonly playerFill = $('.player .fill');
  private readonly playerChip = $('.player .chip');
  private readonly playerSection = $('.fighter.player');
  private readonly stamina = $('.stamina');
  private readonly staminaFill = $('.stamina i');
  private readonly npcFill = $('.npc .fill');
  private readonly npcChip = $('.npc .chip');
  private readonly npcPortrait = $<HTMLImageElement>('.npc img');
  private readonly npcSection = $('.fighter.npc');
  private readonly subtitle = $('#subtitle');
  private readonly voice = $('#voice');
  private readonly goal = $('#voice p');
  private readonly voiceTimer = $('#voice .timer');
  private readonly result = $('#result');
  private readonly resultTitle = $('#result h1');
  private readonly resultText = $('#result p');
  /** The island is painted onto this once; the markers move over it. */
  readonly map = $<HTMLCanvasElement>('#map canvas');
  private readonly mapGorran = $<HTMLImageElement>('#map img');
  private readonly mapWren = $('#map .wren');
  private chips = { player: 1, npc: 1 };
  private last: Partial<HudState> = {};

  constructor(onRematch: () => void, onMap: () => void, onGorran: () => void) {
    $('#result button').addEventListener('click', onRematch);
    $('#map').addEventListener('click', onMap);
    this.mapGorran.addEventListener('click', onGorran);
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
    this.staminaFill.style.transform = `scaleX(${state.stamina})`;
    this.stamina.classList.toggle('shown', state.stamina < 1);
    this.stamina.classList.toggle('winded', state.winded);

    if (state.mood !== this.last.mood) {
      this.npcPortrait.className = state.mood;
      this.npcPortrait.alt = state.mood === 'calm' ? 'Calm' : 'Enraged';
      this.npcPortrait.src = this.mapGorran.src = `/portraits/gorran-${state.mood}.webp`;
      this.goal.innerHTML = GOALS[state.mood];
      if (this.last.mood) {
        this.npcPortrait.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
        this.goal.animate([{ opacity: 0, transform: 'translateY(8px)' }, {}], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }
    if (state.line !== this.last.line) {
      this.subtitle.classList.toggle('shown', !!state.line);
      // An empty line fades the last one out.
      if (state.line) {
        this.subtitle.textContent = state.line;
        this.subtitle.animate([{ transform: 'translateY(8px)' }, {}], { duration: 450, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }
    if (state.voice !== this.last.voice) this.voice.className = state.voice;
    // The arc's tail stays at twelve while its head sweeps clockwise after it.
    this.voiceTimer.style.strokeDashoffset = String(state.voiceLeft - 1);
    if (state.screen !== this.last.screen) this.app.dataset.screen = state.screen;
    if (state.regenerating !== this.last.regenerating) this.playerSection.classList.toggle('regen', state.regenerating);
    if (state.rival !== this.last.rival) this.npcSection.classList.toggle('shown', state.rival);
    this.app.classList.toggle('hurt', state.player < 0.3 && !state.outcome);
    mark(this.mapGorran, state.gorran);
    mark(this.mapWren, state.wren);
    // The arrow points up the map, north, at yaw π.
    this.mapWren.style.rotate = `${Math.PI - state.wren.yaw}rad`;

    if (state.outcome !== this.last.outcome) {
      this.result.hidden = !state.outcome;
      this.result.className = state.outcome ?? '';
      this.resultTitle.textContent = state.outcome === 'victory' ? 'Victory' : 'Defeat';
      this.resultText.textContent =
        state.outcome === 'victory' ? 'Gorran is down. He never healed.' : `Gorran still had ${state.npcHealthLeft} health. Rest more between rounds.`;
    }
    this.voice.hidden = !!state.outcome || state.away;
    this.last = { ...state };
  }
}
