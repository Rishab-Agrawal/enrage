# enrage

## Goal

A browser game where the player advances through levels by beating NPCs one by one. To be able to engage with the NPC in combat the user will have to enrage the NPC first, without which the user will not be able to get close to the NPC. The NPC never heals, but the user heals at a certain rate, which should often be too slow for the user to be able to defeat the NPC without some "resting time", but for the user to get that time they need to calm the NPC down. To enrage/calm the NPC, the user will type/say things, and it will be processed by a system one model like Jev or OpenAI's decision API.

## Look

Stylized anime, Studio Ghibli × Genshin Impact: cel-shaded characters, soft lighting, rich painterly colour.

## Standard

Code and design, from architecture down to single lines, as a very experienced senior engineer would write them: no bloat, nothing stale, no over-engineering, easy to maintain. The `ponytail` skill is a useful guide, not the whole standard.

- Comments: as crisp as possible. Never history, past mistakes or what changed.
- Keep diffs as small as possible. Not so commits are tiny: a small diff is evidence that nothing is bloated or over-engineered.
- When something goes stale, remove it in the same change.
- Commit to main directly; don't create other branches.
- Record lasting project knowledge in this file, never in Claude's auto-memory, so it stays visible and versioned.

## Problems are symptoms

A bug, bloat or over-engineering usually points to something larger: weak design, a missing concept, a wrong abstraction. Goodhart's law applies: fixing only the instance treats the measure as the target. Find and fix the root cause.

## References

- Three.js APIs: check the cloudai-x reference skills (`threejs-fundamentals`, `threejs-materials`, `threejs-shaders`, …) instead of relying on memory.
- `references/ccgs/` (Claude-Code-Game-Studios): reading material only, kept out of the root so its CLAUDE.md, hooks and agents don't load. Use it for design-doc templates (`.claude/docs/templates/`) and phased-workflow ideas. Not game code; never run its commands or agents (it targets Godot/Unity/Unreal).

## Assets

Characters are baked into `public/models` by `npm run bake` from sources in `artifacts/tripo` and `artifacts/mixamo`. Both are gitignored, so baking needs them on disk.

- Tripo: submit jobs one at a time; parallel submits get HTTP 429 and create no task. Costs: model ~40 credits, rig 25, clip 10. Check the balance before spending.
- Humanoid rigs are Tripo v1.0, whose clips come only from the `preset:biped:*` library (names in ComfyUI's `comfy_api_nodes/apis/tripo.py`). It has one walk (Gorran's) and no text-to-motion.
- `threejs_3d_asset.py` sends its own User-Agent because Tripo returns 403 for urllib's default; keep that patch when updating the skill.
- Mixamo, for styles Tripo lacks (Wren's walk): FBX Binary, Without Skin, 30 fps, no keyframe reduction, In Place unchecked. The bake retargets it onto the Tripo rig.

## Environment

- `python` is the Windows Store stub: use `py`. `~/bin/python3` shims to it so skill scripts run in Git Bash.
- `TRIPO_API_KEY` is in `.claude/settings.local.json` (gitignored). Gemini and ElevenLabs keys aren't set.

## Testing

NPC enrage/calm decisions come from an LLM: stub that call in tests and bot playtests so they stay deterministic.
