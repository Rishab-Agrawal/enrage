import type * as THREE from 'three';

type Fighter = 'player' | 'npc';

/** Everything gameplay announces in a frame; combat, VFX, audio and HUD all react to these. */
export type FightEvent =
  | { type: 'swing'; who: Fighter; heavy: boolean }
  | { type: 'contact'; who: Fighter; damage: number; reach: number; knockback: number }
  | { type: 'hit'; who: Fighter; at: THREE.Vector3; damage: number }
  | { type: 'dodge'; at: THREE.Vector3 }
  | { type: 'shove' }
  | { type: 'mood'; mood: Mood };

export type Mood = 'calm' | 'enraged';
