# Progress

**Intent:** the first playable slice of enrage: one real-time fight, player vs one NPC, one arena. Desktop keyboard + mouse. The NPC's mood (calm/enraged) is switched from the debug panel; an LLM will set it later through `Game.setMood`.

**Status:** done. All work is committed on `main`. Evidence: [final-evidence.md](final-evidence.md).

**Decisions**

- Tripo image-to-3D from the concept T-poses, v1.0 biped rigs, FBX clips baked into one GLB per fighter (`scripts/bake-characters.mjs`).
- Mood is a single field, `Npc.mood`. A calm NPC enforces a 3 m personal space (strike reach is 1.95 m), so he can't be engaged.
- Cel look: toon ramp, inverted-hull outline and rim on the characters; procedural meadow, sky and mountains.

**Pending jobs:** none. The Tripo checkpoints (`artifacts/tripo-*.json`) and raw outputs (`artifacts/tripo/`) stay local and are gitignored.

**Next:** chat/voice input → LLM → `Game.setMood`, with the LLM stubbed in tests per CLAUDE.md.
