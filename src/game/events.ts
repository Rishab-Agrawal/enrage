import type * as THREE from 'three';

export type Fighter = 'player' | 'npc';

/** Everything gameplay announces in a frame; combat, VFX, audio and HUD all react to these. */
export type FightEvent =
  | { type: 'swing'; who: Fighter }
  /** A blow at full stretch, `at` the striking fist; it lands only if the fist reaches the other's body. `heavy`: the fighter's bigger blow. */
  | { type: 'contact'; who: Fighter; heavy: boolean; damage: number; knockback: number; at: THREE.Vector3 }
  | { type: 'hit'; who: Fighter; at: THREE.Vector3; damage: number }
  | { type: 'dodge'; at: THREE.Vector3 }
  | { type: 'shove' }
  | { type: 'mood'; mood: Mood };

export type Mood = 'calm' | 'enraged';
