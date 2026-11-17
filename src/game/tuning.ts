/** Fight balance, live-editable from the debug panel. */
export const tuning = {
  playerMaxHealth: 100,
  playerRegen: 3,
  playerWalkSpeed: 2,
  playerSprintSpeed: 5.3,
  playerBackSpeed: 1.5,
  playerStrafeSpeed: 2,
  /** Seconds of sprint a full stamina bar holds. */
  playerStamina: 5,
  /** Out of the arena, her stamina lasts this many times as long: the island is hers to explore. */
  roamStamina: 3,
  /** Rad per pixel of mouse travel. */
  mouseTurn: 0.003,
  /** Rad/s the touch stick turns her at, pushed fully sideways. */
  stickTurn: 2.5,
  strikeDamage: 15,
  npcMaxHealth: 400,
  npcRunSpeed: 5.5,
  punchDamage: 15,
  haymakerDamage: 15,
};

/** Radius of the playable circle, metres. */
export const ARENA_RADIUS = 15;
/** Whether a body at `position` stands in the arena. */
export const inArena = ({ x, z }: { x: number; z: number }): boolean => Math.hypot(x, z) <= ARENA_RADIUS;
