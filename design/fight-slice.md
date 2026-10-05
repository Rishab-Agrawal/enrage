# Fight slice

The first playable slice: one fight, one NPC, one hilltop arena. No levels, no chat, no LLM.

## Brief

- **Promise:** wear down a brute who only fights when you've made him angry, and rest while he's calm.
- **Feeling:** heavy, readable blows; relief when he cools off.
- **Primary verb:** strike. **Secondary:** dodge, move.
- **Every 5–30 s:** close in, trade a few hits, dodge his telegraphed swing, back off.
- **Across 1–3 min:** you can't win one long exchange, so the fight becomes enrage → fight → calm → rest, repeated.
- **Lose, learn, restart:** your bar empties → defeat card showing his remaining health → instant rematch (R).
- **Risk and reward:** staying in to land one more hit against getting caught by his punch. Calming him early is safe but slow.
- **A better player:** dodges through his wind-ups, lands full combos, and rests less.
- **Communicating the next decision:** his mood badge, the colour of his ground ring, his roar on enrage, and the arm wind-up before each attack.
- **Non-goals:** levels, multiple NPCs, chat/voice, LLM, mobile/touch, gamepad.

## Core loop contract

The player strikes to empty the NPC's health. His heavy attacks, and a regen rate too slow to outlast him, create risk. Calming him buys rest, and enraging him buys another window to fight. Failure costs the run; a rematch is one key.

| Clause | Proof in code |
| --- | --- |
| Verb on real input | LMB strike, WASD walk, Shift sprint (dash when standing), RMB dash (`Input.ts`) |
| Objective visible | Both health bars, top of screen |
| Pressure in the first minute | An enraged NPC chases and hits for 18–24 |
| Reward changes state | Damage is permanent: the NPC never heals |
| Failure teaches | The defeat card shows how much health he had left |
| Fast restart | R or the button on the result card |

## Mood

`Npc.mood` (`'calm' | 'enraged'`) is the one piece of state a future system (the LLM) sets, through `Fight.setMood`. For now the debug panel sets it.

- **Calm:** arms folded, never attacks. He walks off to keep at least 6 m away and enforces a hard 3 m personal-space ring. Inside it the player gets kicked back without damage. His strike reach is 1.6 m, so a calm NPC can't be hit. This is the player's rest window.
- **Enraged:** roars (a 1.2 s telegraph), then chases and attacks with a punch or a kick. Each attack has a visible wind-up, and the kick knocks the player back.

## Tuning (live in the debug panel)

| | Player | NPC |
| --- | --- | --- |
| Health | 100, regen 3/s | 400, never heals |
| Damage | 9 per strike (jab/cross alternate) | punch 24, kick 18 + knockback |
| Rhythm | strike every ~0.45 s, dodge 0.35 s with i-frames, 0.7 s cooldown | wind-up ~0.5 s, ~1.4 s attack cycle |

Rough maths: a straight trade drains the player in about 12 s while dealing at most ~200 damage, so winning takes about two rests.

## Arena

A meadow hilltop, about 24 m across, matching `assets/concepts/key-art.png`. It has golden late-afternoon light, cumulus clouds, layered mountain ranges and rolling hills. Short, dense grass carpets the meadow, drifts of small wildflowers dot it, and mossy boulders ring the circle, with a dirt patch in the centre where the fight happens.

- **Camera:** third person, open-world style: locked behind the player, it turns exactly as she steers and shows what she sees, whether or not the NPC is in frame.
- **Movement:** A/D only turn her and W/S only walk her forward or back along her facing, so holding both walks an arc. Shift sprints forward only; pressed alone, it dashes forward. Turning on the spot, her head and chest lead and her hips hold; once she has twisted 45° they catch up in a light step, pivoting on the ball of the inner foot while the outer knee lifts and swings round; the inner foot follows in a smaller step.
- **Bounds:** a 12 m circle. The boulders mark its edge.
