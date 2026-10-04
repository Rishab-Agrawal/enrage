# Fight slice: evidence

Design: [design/fight-slice.md](../design/fight-slice.md). Desktop, keyboard + mouse only.

## Skills used

`threejs-game-director` (lead), `threejs-gameplay-systems` (+ `game-feel.md`), `threejs-3d-generator` (+ `api-notes.md`, `threejs-integration.md`), `threejs-aaa-graphics-builder` (+ all four references, scorecard anchors), `threejs-game-ui-designer` (+ `ui-patterns.md`), `threejs-qa-release` (+ `playtest-bot.md`, `evidence-manifest.md`). No Gemini or ElevenLabs key, so there are no generated 2D or audio assets: textures and sky are procedural, and the audio is synthesized with Web Audio.

## Generated assets (Tripo, 270 of the 500-credit budget; balance 600 → 330)

| Asset | Task | Notes |
| --- | --- | --- |
| Wren model | `1a3ff373-4f2b-4544-8bff-a1f29a58fb98` | image-to-3D from `player-front.png`, v3.1, detailed texture, 29.6k tris |
| Gorran model | `aa5147c9-f78f-425c-8894-2dcf52ae5de6` | image-to-3D from `npc-front.png`, same settings |
| Wren rig | `b08c1cb5-4c49-43d5-a4c1-52648b7c57c6` | v1.0 biped, validated (16 L/R pairs) |
| Gorran rig | `a5725a1c-a863-42c2-854e-67a79f17fb10` | v1.0 biped, validated |
| Wren clips | idle `bc2adbab`, run `b33499aa`, box_01 `7dbeee36`, box_02 `94efd0e5`, hit_to_body_01 `dc16f52e`, defeat_02 `b26b0e5c` | FBX, one per task |
| Gorran clips | fold_arms `abde5190`, angry_01 `69a0db76`, walk `ea818dad`, run `72ab14a3`, box_03 `61c0c60e`, hit_to_stomach `b1fe74b6`, defeat_03 `1104a231`, front_kick_01 `53b7ae34` | FBX, one per task |

Two clips were rejected after inspection. `front_kick_01` kicks 90° off Gorran's facing, and `defeat_02` is a slump that doesn't read as a loss. Because both rigs are the same normalized v1.0 skeleton, clips transfer between them: Gorran's haymaker is Wren's `box_02`, and both fighters use `defeat_03` to collapse.

`scripts/bake-characters.mjs` bakes each fighter into one GLB: the rig GLB's mesh and PBR textures plus the FBX tracks. It drops the FBX `Armature.scale` (100×), pins horizontal root motion, trims the defeat clip before it stands back up, and resizes textures to 1024 JPEG. Output: `public/models/player.glb` (1.7 MB) and `npc.glb` (1.9 MB).

## Playtests: `npx playwright test` (real keyboard, mouse and debug-panel input), 4/4 pass

| Test | Result |
| --- | --- |
| WASD moves the player | pass |
| Calm NPC keeps the player out of reach and can't be hurt | pass (closest distance > 2.6 m, both at full health) |
| A straight fight is lost | pass: defeat at 9.0 s, Gorran 319/400 |
| Fighting in rounds with rests wins | pass: victory in 6 rounds, 148 s of fight time; R rematch restores 400 |

## Captures: pass-2 (`artifacts/evidence.json`), all PASS on hardware GPU, budget ok

| State | Entropy | Edges | Contrast |
| --- | --- | --- | --- |
| [active-play](pass-2/desktop-active-play.png) | 5.96 | 0.380 | 131.1 |
| [enraged](pass-2/desktop-enraged.png) | 5.99 | 0.403 | 130.8 |
| [resting](pass-2/desktop-resting.png) | 5.93 | 0.380 | 131.3 |
| [victory](pass-2/desktop-victory.png) | 5.71 | 0.382 | 122.2 |
| [defeat](pass-2/desktop-defeat.png) | 5.65 | 0.364 | 121.7 |

`check_evidence.py --manifest artifacts/evidence.json`: passed, 8 artifacts.

**Motion:** `pass-2/fight.webm` (kept locally, not committed) is an unpaused real-input fight. I inspected contact sheets for:

- calm walk-up and the turn-away at the ring;
- roar → run → punch and haymaker wind-ups;
- dodges through attacks;
- flinch and recover;
- hit flash and dust.

Contact frames were measured from per-clip sheets: jab 0.49 s, cross 2.2 s, punch 0.56 s, haymaker 2.3 s.

## Renderer

GPU: RTX 3050 Laptop (ANGLE/D3D11). Enraged view: 39 draw calls, 543k triangles (60k instanced grass blades are about 300k of that), 31 geometries, 17 textures. One shadow-casting light at 2048², DPR capped at 2, no post passes. Frame time at 1920×1080: median 16.7 ms, p95 17.0 ms (vsync-locked 60 fps). Production `npm run build`: 686 kB JS (178 kB gzip); `dist` is 7.3 MB including models.

## Scorecard (no baseline: new game)

| Category | Score | Evidence |
| --- | --- | --- |
| Art direction | 2.5 | Ghibli meadow from the key art drives the sky, hills, flowers, cel characters and the warm UI |
| Hero (Wren) | 2.5 | generated textured model, cel ramp, ink outline, rim, hit flash, 6 clips |
| Enemy (Gorran) | 2.5 | distinct brute silhouette; mood read through the badge, ring colour and size, embers, rage rim and roar shockwave; telegraphed wind-ups |
| Interactables | 2 | mood ring and badge, hint line, strike, dodge and shove feedback |
| World | 2 | layered flowers and boulders → golden hills → two mountain ranges → painted clouds; the near ground is still a uniform green |
| Materials | 2 | shared toon ramp, vertex-coloured mossy rocks and hill patchwork, grass gradient shader; no wear or decal kit |
| Lighting | 2 | golden low sun with soft shadows, hemisphere fill, rim light, Neutral tone mapping; no post |
| VFX / motion | 2 | impact stars, dust, embers, shockwave, hitstop, trauma shake, grass bending around both fighters |
| UI / HUD | 2.5 | mirrored angled bars with chip damage, animated mood badge, result cards, loading screen, keycap legend |
| Performance evidence | 2.5 | renderer counts, frame times, build size, budget rows |

Average **2.3**; no category below 2; no automatic failure. This just meets the premium bar.

## Known gaps

- The audio is synthesized placeholder (no ElevenLabs key).
- There is no dedicated dodge animation (it is the run clip at 2.2×) and no foot IK, so feet slide slightly when locomotion speed doesn't match the clip.
- The FBX clips include geometry; a retarget with `--no-export-with-geometry` would have been smaller to download, but the bake discards it anyway.
