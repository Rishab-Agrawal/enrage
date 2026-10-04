/// <reference types="vite/client" />

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  outcome: 'victory' | 'defeat' | null;
  /** `speed` is measured ground speed; `stride` the ground speed the legs show, null mid-action. */
  player: { position: Vec3; speed: number; stride: number | null; health: number; state: string };
  npc: { position: Vec3; stride: number | null; health: number; mood: 'calm' | 'enraged'; state: string };
  renderer: { calls: number; triangles: number; geometries: number; textures: number };
  canvas: { clientWidth: number; clientHeight: number; width: number; height: number; dpr: number };
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void | Promise<void>;
  /** Acknowledge after setup/assets are ready; throw for unknown states. */
  setState(name: string): { state: string } | Promise<{ state: string }>;
  /** Stop simulation/state transitions immediately; keep rendering. */
  setPausedForScreenshot(paused: boolean): void | Promise<void>;
  /** Stabilize ambient/idle visuals without requiring an unpaused simulation tick. */
  setReducedMotion(enabled: boolean): void | Promise<void>;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void | Promise<void>;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
