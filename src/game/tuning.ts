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
  /** Out of the fight, her stamina lasts this many times as long: the island is hers to explore. */
  roamStamina: 3,
  /** Rad per pixel of mouse travel. */
  mouseTurn: 0.003,
  /** Rad/s the touch stick turns her at, pushed fully sideways. */
  stickTurn: 0.6,
  strikeDamage: 15,
  npcMaxHealth: 400,
  npcRunSpeed: 5.5,
  punchDamage: 15,
  haymakerDamage: 15,
};

/** Radius of the playable circle, metres. */
export const ARENA_RADIUS = 15;
/** Enraged, he follows her out of the arena while she is this close to him, m, up to twice its radius from its middle. */
const LEASH = 4;
type Spot = { x: number; z: number };
/** Whether a body at `position` stands in the arena. */
export const inArena = ({ x, z }: Spot): boolean => Math.hypot(x, z) <= ARENA_RADIUS;
/** Whether she, at `player`, is within LEASH of him at `npc`. */
export const near = (player: Spot, npc: Spot): boolean => Math.hypot(player.x - npc.x, player.z - npc.z) <= LEASH;
/** Whether she is in the fight: in the arena, or close to him. */
export const inFight = (player: Spot, npc: Spot): boolean => inArena(player) || near(player, npc);
