import GUI from 'lil-gui';
import type { Mood } from '../game/events';
import { tuning } from '../game/tuning';

/** Stand-in for the conversation system: sets the NPC's mood, plus live balance tuning. */
export class DebugPanel {
  private readonly gui = new GUI({ title: 'Debug', container: document.querySelector<HTMLElement>('#debug') ?? undefined });
  private readonly state: { mood: Mood };

  constructor(
    private readonly getMood: () => Mood,
    setMood: (mood: Mood) => void,
    rematch: () => void,
  ) {
    this.state = { mood: getMood() };
    this.gui
      .add(this.state, 'mood', ['calm', 'enraged'])
      .name('NPC mood')
      .onChange((mood: Mood) => setMood(mood));
    this.gui.add({ rematch }, 'rematch').name('Rematch');
    const balance = this.gui.addFolder('Balance').close();
    balance.add(tuning, 'playerRegen', 0, 20, 0.5).name('player regen /s');
    balance.add(tuning, 'strikeDamage', 1, 40, 1).name('strike damage');
    balance.add(tuning, 'punchDamage', 0, 60, 1).name('punch damage');
    balance.add(tuning, 'haymakerDamage', 0, 60, 1).name('haymaker damage');
    balance.add(tuning, 'npcRunSpeed', 2, 8, 0.1).name('NPC run speed');
    balance.add(tuning, 'playerWalkSpeed', 0.5, 4, 0.1).name('player walk speed');
    balance.add(tuning, 'playerSprintSpeed', 2, 8, 0.1).name('player sprint speed');
    balance.add(tuning, 'playerBackSpeed', 0.5, 3, 0.1).name('player back speed');
  }

  /** Reflect a mood set elsewhere (rematch, test hooks, a future LLM). */
  sync(): void {
    this.state.mood = this.getMood();
    for (const controller of this.gui.controllersRecursive()) controller.updateDisplay();
  }

  setHidden(hidden: boolean): void {
    this.gui.show(!hidden);
  }

  dispose(): void {
    this.gui.destroy();
  }
}
