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
- **Communicating the next decision:** his portrait's mood ring, the goal over the mic (enrage him to fight, pacify him to rest), his rage embers and rim light, his roar on enrage, and the wind-up before each attack.
- **Non-goals:** levels, multiple NPCs, chat/voice beyond the push-to-talk turn (hold Space up to 20 s, then the mic rests 5 s), LLM, mobile/touch, gamepad.

## Core loop contract

The player strikes to empty the NPC's health. His heavy attacks create risk, and the player only regenerates while he is calm, too slowly to outlast him. Calming him buys rest, and enraging him buys another window to fight. Failure costs the run; a rematch is one key.

| Clause | Proof in code |
| --- | --- |
| Verb on real input | Left click strike, WASD walk, Shift sprint (dash when standing) (`Input.ts`) |
| Objective visible | Both health bars, top of screen |
| Pressure in the first minute | An enraged NPC chases and hits for 18–24 |
| Reward changes state | Damage is permanent: the NPC never heals |
| Failure teaches | The defeat card shows how much health he had left |
| Fast restart | R or the button on the result card |

## Mood

`Npc.mood` (`'calm' | 'enraged'`) is the one piece of state a future system (the LLM) sets, through `Fight.setMood`. For now the debug panel sets it.

- **Calm:** arms folded, never attacks. He walks off to keep at least 6 m away; if she closes on him anyway, he wheels round and shoves her off with both palms, without damage: he starts as she comes, so his palms meet her as they drive out. No dash avoids the shove, and she reels back out of control, so she never touches him. Her blows don't hurt him while he is calm. This is the player's rest window. He turns as she does: head first, hips following in a step.
- **Enraged:** roars (a 1.2 s telegraph), then chases and attacks with a punch or a haymaker. Each attack has a visible wind-up, through which he keeps stepping in faster than she can back away; the haymaker knocks her back hard.

## Contact

Everything physical happens on touch. A blow lands only if the striking fist, sampled from its bone at full stretch, reaches the other's body; there are no invisible walls or ranged pushes. Knockback is an impulse on top of her own movement, never a loss of control. A flinch plays on her upper body, so a blow never takes her legs; only her own strikes and dodges commit them. An action's step moves the fighter's body (root motion; its clip plays in place), so a lunging jab carries her into the cross instead of snapping back.

## Tuning (live in the debug panel)

| | Player | NPC |
| --- | --- | --- |
| Health | 100, regen 3/s only while he is calm | 400, never heals |
| Damage | 15 per strike (jab/cross alternate) | punch and haymaker 15 each, + knockback |
| Rhythm | strike every ~0.45 s, dodge 0.32 s with i-frames, 0.7 s cooldown | wind-up 0.5–0.9 s, ~1.5 s attack cycle |

Target: winning takes about three rests.

## Arena

A meadow hilltop, about 24 m across, matching `assets/concepts/key-art.png`. It has golden late-afternoon light, cumulus clouds, layered mountain ranges and rolling hills. Short, dense grass carpets the meadow, drifts of small wildflowers dot it, and mossy boulders ring the circle, with a dirt patch in the centre where the fight happens.

- **Camera:** third person, open-world style: locked behind the player, it turns exactly as she steers and shows what she sees, whether or not the NPC is in frame. A click captures the mouse, whose sideways travel steers her; Esc releases it and pauses the fight, as losing focus does, and the mic lets go. A click resumes. The game opens on a title over a slow, wide shot of the live hilltop, without the HUD; the first click glides the camera down behind her. How to play lives on the pause card.
- **Movement:** W/S walk her forward or back along her facing and A/D step her sideways; with W she walks a diagonal, no faster than straight, while S overrides them, as no gait walks back on a diagonal. Shift sprints forward only, A/D then steering the run a little, 5% slower; pressed alone, it dashes forward in a burst of her run. Her legs blend the two nearest of her forward, back and sideways gaits, in step: her run while she sprints, else her walk, played at whatever speed she moves. Turning on the spot, her head and chest lead and her hips hold; once she has twisted 45° they catch up in a light step, pivoting on the ball of the inner foot while the outer knee lifts and swings round; the inner foot follows in a smaller step.
- **Stamina:** sprinting spends it and a dash costs 1.5 s of sprint; a full bar holds 10 s, enough to run while finding the words to calm him. It refills in 4 s, starting 1 s after she last spent it. Emptied, she is winded until it is full: she walks, cannot dash, and he catches her. A thin bar under her health shows it while it isn't full, red while she is winded.
- **Bounds:** a 12 m circle. The boulders mark its edge.
