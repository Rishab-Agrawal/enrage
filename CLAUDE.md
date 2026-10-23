# enrage

## Goal

A browser game where the player advances through levels by beating NPCs one by one. To be able to engage with the NPC in combat the user will have to enrage the NPC first, without which the user will not be able to get close to the NPC. The NPC never heals, but the user heals at a certain rate, which should often be too slow for the user to be able to defeat the NPC without some "resting time", but for the user to get that time they need to calm the NPC down. To enrage/calm the NPC, the user will type/say things, and it will be judged by Jev, a system one model.

## Look

Stylized anime, Studio Ghibli × Genshin Impact: cel-shaded characters, soft lighting, rich painterly colour.

## Standard

Code and design, from architecture down to single lines, as a very experienced senior engineer would write them: no bloat, nothing stale, no over-engineering, easy to maintain. The `ponytail` skill is a useful guide, not the whole standard.

- Check if there are any standard/official way of doing what you are trying to do, rather than reinventing the wheel with sub-par quality.
- Comments: as crisp as possible. Never history, past mistakes or what changed.
- Keep diffs as small as possible. Not so commits are tiny: a small diff is evidence that nothing is bloated or over-engineered.
- When something goes stale, remove it in the same change.
- Commit and push to main directly; don't create other branches.
- Lasting knowledge that the code, git and skills don't already hold goes in this file, never in Claude's auto-memory. Only what's necessary, as crisp as possible.

## Problems are symptoms

A bug, bloat or over-engineering usually points to something larger: weak design, a missing concept, a wrong abstraction. Goodhart's law applies: fixing only the instance treats the measure as the target. Find and fix the root cause.

## References

- Three.js APIs: check the cloudai-x reference skills (`threejs-fundamentals`, `threejs-materials`, `threejs-shaders`, …) instead of relying on memory.
- `references/ccgs/` (Claude-Code-Game-Studios): reading material only, for design-doc templates (`.claude/docs/templates/`) and phased-workflow ideas. Not game code; never run its commands or agents (it targets Godot/Unity/Unreal).

## Assets

- Submit Tripo jobs one at a time: parallel submits get HTTP 429 and create no task.
- The `preset:biped:*` names are listed in ComfyUI's `comfy_api_nodes/apis/tripo.py`. The library has one walk, Gorran's; Mixamo fills such gaps. Download Mixamo clips with In Place unchecked: the bake measures ground speed from their travel. One FBX per clip folder: the bake reads the first it finds. Neither library has a two-handed push: the bake keys Gorran's (`shove`) with IK.

## Environment

Python is `py`; `python` is the Windows Store stub.

API keys go in `.env.local`, which git ignores, never `.env`.

## Testing

NPC enrage/calm decisions come from Jev: stub `/api/judge` in tests and bot playtests so they stay deterministic. `npm run eval` and `npm run redteam` call it for real, on purpose: they measure the judge. The red-team agent labels the cases it adds to `evals/cases.json`: review them before committing.

Run the tests a change can break, and the full suite only when required (like touching shared code); check what none cover with a screenshot.
