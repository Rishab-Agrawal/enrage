/** Fight balance, live-editable from the debug panel. */
export const tuning = {
  playerMaxHealth: 100,
  playerRegen: 3,
  playerSpeed: 4.6,
  strikeDamage: 9,
  npcMaxHealth: 400,
  npcRunSpeed: 4.8,
  punchDamage: 16,
  haymakerDamage: 30,
};

export type Tuning = typeof tuning;

/** Radius of the playable circle, metres. */
export const ARENA_RADIUS = 12;
/** A calm NPC never lets the player inside this distance. */
export const PERSONAL_SPACE = 3;
