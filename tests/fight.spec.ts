import { expect, test, type Page } from '@playwright/test';
import type { FightEvent } from '../src/game/events';
import { LINES } from '../src/game/lines';
import { tuning } from '../src/game/tuning';

// Real-input playtests: keyboard, mouse and the debug panel's mood control, as a player would use them.
// Gorran's attack choice is seeded, so runs are deterministic up to frame timing.

type Diagnostics = NonNullable<Window['__THREE_GAME_DIAGNOSTICS__']>;

const read = (page: Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__ as Diagnostics);
const distance = (d: Diagnostics) => Math.hypot(d.player.position.x - d.npc.position.x, d.player.position.z - d.npc.position.z);
const setMood = (page: Page, mood: 'calm' | 'enraged') => page.locator('#debug select').selectOption(mood);

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  // Raw mouse input reads the machine's real mouse, even headless: lock without it, so only Playwright's mouse turns her.
  await page.addInitScript(() => {
    const lock = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function () {
      return lock.call(this);
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.seed(42));
  // Park the mouse on the canvas before the first click captures it, so clicks never move it and never turn her.
  const box = (await page.locator('#game-canvas').boundingBox())!;
  mice.set(page, { x: box.width / 2, y: box.height / 2 });
  await page.mouse.move(box.width / 2, box.height / 2);
  return errors;
}

/** Where each page's mouse is: captured, only its travel counts, so it moves on from wherever it is. */
const mice = new WeakMap<Page, { x: number; y: number }>();

/** Capture the mouse with a click where it is, unless it already is. */
async function capture(page: Page): Promise<void> {
  if (await page.evaluate(() => document.pointerLockElement?.id === 'game-canvas')) return;
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id)).toBe('game-canvas');
}

/** Slide the mouse sideways as far as turns her by `radians`, positive left, once it is captured. */
async function look(page: Page, radians: number): Promise<void> {
  const mouse = mice.get(page)!;
  mouse.x -= radians / tuning.mouseTurn;
  await page.mouse.move(mouse.x, mouse.y);
}

/** Signed shortest turn from yaw `a` to yaw `b`. */
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Sprint at him, turning toward him with the mouse, then stand and swing while he is in reach, for up to `seconds` or until `stop` holds. */
async function brawl(page: Page, seconds: number, stop: (d: Diagnostics) => boolean): Promise<Diagnostics> {
  await capture(page);
  const steer = (d: Diagnostics) =>
    look(page, turn(d.player.yaw, Math.atan2(d.npc.position.x - d.player.position.x, d.npc.position.z - d.player.position.z)));
  let closing = false;
  const close = async (on: boolean) => {
    if (on === closing) return;
    closing = on;
    if (on) for (const key of ['KeyW', 'ShiftLeft']) await page.keyboard.down(key); // W first, or Shift dashes
    else for (const key of ['ShiftLeft', 'KeyW']) await page.keyboard.up(key);
  };
  const end = Date.now() + seconds * 1000;
  let d = await read(page);
  while (Date.now() < end && !d.outcome && !stop(d)) {
    await steer(d);
    await close(distance(d) > 1.1);
    if (distance(d) < 1.3) {
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.waitForTimeout(120);
    d = await read(page);
  }
  await close(false);
  return d;
}

test('W walks, Shift sprints, S backs up, A/D step sideways, diagonals are no faster, and Shift alone dashes', async ({ page }) => {
  const errors = await start(page);
  // Face across the arena, clear of him and its edge.
  await capture(page);
  await look(page, Math.PI / 2);
  await page.waitForTimeout(1000);
  /** Metres moved, which way off her facing (positive left), and radians turned while `keys` are held, pressed in order, for `ms`. */
  const travel = async (keys: string[], ms: number) => {
    const before = await read(page);
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    for (const key of keys) await page.keyboard.up(key);
    await page.waitForTimeout(400);
    const after = await read(page);
    const [dx, dz] = [after.player.position.x - before.player.position.x, after.player.position.z - before.player.position.z];
    return { moved: Math.hypot(dx, dz), heading: turn(before.player.yaw, Math.atan2(dx, dz)), turned: turn(before.player.yaw, after.player.yaw) };
  };
  const walked = await travel(['KeyW'], 600);
  const sprinted = await travel(['KeyW', 'ShiftLeft'], 600);
  const backed = await travel(['KeyS', 'ShiftLeft'], 600);
  const right = await travel(['KeyD'], 600);
  const left = await travel(['KeyA'], 600);
  const diagonal = await travel(['KeyW', 'KeyD'], 600);
  const sprintDiagonal = await travel(['KeyW', 'KeyD', 'ShiftLeft'], 600);
  const backDiagonal = await travel(['KeyS', 'KeyD'], 600);
  expect(walked.moved).toBeGreaterThan(0.5);
  expect(sprinted.moved).toBeGreaterThan(2 * walked.moved);
  // Shift doesn't hurry her backwards.
  expect(backed.moved).toBeLessThan(walked.moved);
  // S overrides A/D.
  for (const [{ moved, heading }, expected] of [[walked, 0], [backed, Math.PI], [backDiagonal, Math.PI], [right, -Math.PI / 2], [left, Math.PI / 2]] as const) {
    expect(moved).toBeGreaterThan(0.4);
    expect(Math.abs(turn(heading, expected))).toBeLessThan(0.1);
  }
  expect(diagonal.heading).toBeGreaterThan(-Math.PI / 2 + 0.3); // forward and right
  expect(diagonal.heading).toBeLessThan(-0.3);
  expect(diagonal.moved).toBeLessThan(1.05 * Math.max(walked.moved, right.moved));
  // Sprinting, D steers her run a little, 5% slower.
  expect(sprintDiagonal.heading).toBeGreaterThan(-Math.PI / 4);
  expect(sprintDiagonal.heading).toBeLessThan(-0.1);
  expect(sprintDiagonal.moved / sprinted.moved).toBeCloseTo(0.95, 1);
  // No key turns her.
  for (const { turned } of [walked, sprinted, backed, right, left, diagonal, sprintDiagonal, backDiagonal]) expect(Math.abs(turned)).toBeLessThan(1e-6);
  expect((await travel(['ShiftLeft'], 100)).moved).toBeGreaterThan(1.5);
  expect(errors).toEqual([]);
});

test('a full bar holds 5 s of sprint and refills as fast, after a 1 s pause once emptied, and she can run on a part-refilled bar', async ({ page }) => {
  await start(page);
  const log = await page.evaluate(async () => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Player } = await import('/src/entities/Player.ts' as string);
    const player = new Player(await new GLTFLoader().loadAsync('models/player.glb'));
    let t = 0;
    // W held throughout; Shift held but for 7–9.5 s, and Shift alone tapped at 6 s to dash.
    const input = {
      get sprinting() {
        return t < 7 || t >= 9.5;
      },
      consumeLook: () => 0,
      consume: (intent: string) => intent === 'dodge' && Math.abs(t - 6) < 1 / 120,
      movement: (v: { set(x: number, y: number): void }) => v.set(0, 1),
    };
    const log: { t: number; speed: number; stamina: number; winded: boolean; state: string }[] = [];
    for (; t < 14; t += 1 / 60) {
      const before = player.position.clone();
      player.update(1 / 60, input, player.position.clone().setZ(-99), false, []);
      player.character.update(1 / 60);
      log.push({ t, speed: player.position.distanceTo(before) * 60, stamina: player.stamina, winded: player.winded, state: player.state });
    }
    return log;
  });
  const at = (t: number) => log.find((s) => s.t >= t)!;
  expect(at(4.5).speed).toBeCloseTo(tuning.playerSprintSpeed, 0);
  // Emptied at 5 s, and held, it stays empty: she walks, and cannot dash.
  expect(at(6.9).stamina).toBe(0);
  expect(at(6.9).speed).toBeCloseTo(tuning.playerWalkSpeed, 0);
  expect(log.some((s) => s.state === 'dodge')).toBe(false);
  expect(at(6.9).winded).toBe(false);
  // Let go, it waits 1 s, winded, then refills 1.5 s worth by 9.5 s, which she runs on.
  expect(at(7.9).stamina).toBe(0);
  expect(at(7.9).winded).toBe(true);
  expect(at(9.5).stamina).toBeCloseTo(1.5, 1);
  expect(at(9.5).winded).toBe(false);
  expect(at(10.5).speed).toBeCloseTo(tuning.playerSprintSpeed, 0);
  expect(at(11.5).speed).toBeCloseTo(tuning.playerWalkSpeed, 0);
});

test('a click captures the mouse without striking; then the mouse turns her, until it is released', async ({ page }) => {
  const errors = await start(page);
  /** Radians she turns as the mouse slides as far as turns her by `radians` when captured. */
  const turned = async (radians: number) => {
    const before = await read(page);
    await look(page, radians);
    await page.waitForTimeout(100);
    return turn(before.player.yaw, (await read(page)).player.yaw);
  };
  expect(await turned(-0.6)).toBe(0);
  await capture(page);
  expect((await read(page)).player.state).toBe('move');
  expect(await turned(-0.6)).toBeCloseTo(-0.6, 3); // sliding right turns her clockwise from above
  await page.evaluate(() => document.exitPointerLock());
  expect(await turned(0.6)).toBe(0);
  expect(errors).toEqual([]);
});

test('losing the mouse pauses the fight and lets go of the mic; capturing it again resumes', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  await page.keyboard.down('Space');
  await expect(page.locator('#voice')).toHaveClass('listening');
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#pause')).toBeVisible();
  await expect(page.locator('#voice')).toHaveClass('cooldown');
  const { elapsed } = await read(page);
  await page.waitForTimeout(300);
  expect((await read(page)).elapsed).toBe(elapsed);
  await page.keyboard.up('Space');
  await capture(page);
  await expect(page.locator('#pause')).toBeHidden();
  expect((await read(page)).elapsed).toBeGreaterThan(elapsed);
  expect(errors).toEqual([]);
});

test('Gorran answers her turn at the mic as he is, and speaks up as his mood turns', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  const says = (lines: string[]) => expect.poll(async () => lines.includes((await page.locator('#subtitle').textContent())!)).toBe(true);
  await page.keyboard.press('Space');
  await says(LINES.unmoved.calm);
  await setMood(page, 'enraged');
  await says(LINES.mood.enraged);
  await setMood(page, 'calm');
  await says(LINES.mood.calm);
  expect(errors).toEqual([]);
});

test('a key let go while the debug panel has focus does not stay held', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  await page.keyboard.down('KeyW');
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#debug select').focus(); // as clicking it to change his mood does; it keeps the keyup
  await setMood(page, 'calm');
  await page.keyboard.up('KeyW');
  await capture(page);
  await page.waitForTimeout(600);
  expect((await read(page)).player.speed).toBeLessThan(0.05);
  expect(errors).toEqual([]);
});

test('turning on the spot, her upper body leads and her hips pivot to catch up', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  let [fastest, lead] = [0, 0];
  for (const end = Date.now() + 1500; Date.now() < end; ) {
    await look(page, -0.05);
    await page.waitForTimeout(40);
    const d = await read(page);
    fastest = Math.max(fastest, d.player.speed);
    lead = Math.max(lead, Math.abs(turn(d.player.facing, d.player.yaw)));
  }
  await page.waitForTimeout(600);
  const settled = await read(page);
  expect(lead).toBeGreaterThan(0.5); // her hips hold while she twists
  expect(lead).toBeLessThan(0.95); // and pivot before the twist goes past what a spine can
  expect(Math.abs(turn(settled.player.facing, settled.player.yaw))).toBeLessThan(0.21); // then square up
  expect(fastest).toBeLessThan(0.05); // she turns about her hips, so no walking legs
  expect(errors).toEqual([]);
});

test('whipped round faster than she can pivot, her hips are dragged the way the mouse goes, never past her spine', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  const before = await read(page);
  let [lead, back, last] = [0, 0, before.player.facing];
  for (let i = 0; i < 40; i++) {
    await look(page, 0.5);
    await page.waitForTimeout(16);
    const d = await read(page);
    lead = Math.max(lead, Math.abs(turn(d.player.facing, d.player.yaw)));
    back = Math.max(back, last - d.player.facing);
    last = d.player.facing;
  }
  await page.waitForTimeout(800);
  expect(lead).toBeLessThan(0.85);
  expect(back).toBeLessThan(0.01); // her hips never swing back against the mouse
  expect((await read(page)).player.facing - before.player.facing).toBeCloseTo(20, 0);
  expect(errors).toEqual([]);
});

test('legs settle on the speed the body actually moves at', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await start(page);
  await capture(page);
  const misfits: string[] = [];
  let last = await read(page);
  // When each fighter's legs last matched the body: they get a blend's time to catch up with a change.
  const matched = { player: last.elapsed, npc: last.elapsed };
  const watch = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      await page.waitForTimeout(60);
      const d = await read(page);
      const dt = d.elapsed - last.elapsed;
      for (const who of ['player', 'npc'] as const) {
        const [a, b] = [last[who], d[who]];
        if (dt <= 0 || a.stride === null || b.stride === null || a.state !== b.state) {
          matched[who] = d.elapsed;
          continue;
        }
        // The body's average speed over the window lies between the speeds the legs showed at its ends.
        const moved = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z) / dt;
        if (moved >= Math.min(a.stride, b.stride) - 0.5 && moved <= Math.max(a.stride, b.stride) + 0.5) matched[who] = d.elapsed;
        else if (d.elapsed - matched[who] > 0.3) {
          misfits.push(`${who} ${b.state} at ${d.elapsed.toFixed(2)}s: legs ${a.stride.toFixed(1)}→${b.stride.toFixed(1)} m/s, body ${moved.toFixed(1)} m/s`);
        }
      }
      last = d;
    }
  };
  // Each leg of the route ends at rest: positions sampled across a reversal can't show the speed through it.
  const route: [string[], number][] = [
    [['ShiftLeft'], 1000], // dash where the body faces
    [['KeyW', 'ShiftLeft'], 2500], // sprint into his personal space
    [['KeyS', 'ShiftLeft'], 3000], // back away; Shift doesn't hurry it
    [['KeyD'], 1500], // step right
    [['KeyA'], 1500], // step left
    [['KeyW', 'KeyD'], 3000], // walk a diagonal
    [['KeyS', 'KeyA'], 2000], // back away: S overrides A
    [['KeyW', 'KeyA', 'ShiftLeft'], 2000], // sprint a diagonal
  ];
  for (const [keys, ms] of route) {
    for (const key of keys) await page.keyboard.down(key);
    await watch(ms);
    for (const key of keys) await page.keyboard.up(key);
    await watch(600);
  }
  await setMood(page, 'enraged');
  await watch(4000); // he chases
  expect(misfits).toEqual([]);
  expect(errors).toEqual([]);
});

test('a calm NPC shoves off a player who rushes him before she can touch him', async ({ page }) => {
  const errors = await start(page);
  // Every frame: how close she ever got, and how many shoves she took.
  await page.evaluate(() => {
    const w = window as unknown as { closest: number; shoves: number };
    [w.closest, w.shoves] = [Infinity, 0];
    let reeling = false;
    const sample = () => {
      const d = window.__THREE_GAME_DIAGNOSTICS__!;
      w.closest = Math.min(w.closest, Math.hypot(d.player.position.x - d.npc.position.x, d.player.position.z - d.npc.position.z));
      if (d.player.state === 'reel' && !reeling) w.shoves += 1;
      reeling = d.player.state === 'reel';
      requestAnimationFrame(sample);
    };
    sample();
  });
  const d = await brawl(page, 10, () => false);
  const { closest, shoves } = await page.evaluate(() => {
    const { closest, shoves } = window as unknown as { closest: number; shoves: number };
    return { closest, shoves };
  });
  console.log(`closest=${closest.toFixed(2)} shoves=${shoves}`);
  expect(d.npc.mood).toBe('calm');
  expect(shoves).toBeGreaterThan(1);
  expect(closest).toBeGreaterThan(1.1); // she meets his palms, never his body (0.9)
  expect(d.npc.health).toBe(400);
  expect(d.player.health).toBe(100);
  expect(errors).toEqual([]);
});

test('a calm NPC nudged inside his comfort distance walks well clear of it', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  // Sprint in: walking, she can't outpace his retreat.
  for (const key of ['KeyW', 'ShiftLeft']) await page.keyboard.down(key);
  await page.waitForFunction(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__!;
    return Math.hypot(d.player.position.x - d.npc.position.x, d.player.position.z - d.npc.position.z) < 5.9;
  });
  for (const key of ['ShiftLeft', 'KeyW']) await page.keyboard.up(key);
  await expect.poll(async () => distance(await read(page)), { timeout: 5000 }).toBeGreaterThan(7.3);
  expect(errors).toEqual([]);
});

test('a straight fight is lost: no regen while he is enraged', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await start(page);
  await setMood(page, 'enraged');
  const d = await brawl(page, 60, () => false);
  console.log(`straight fight: outcome=${d.outcome} npcHealth=${Math.round(d.npc.health)} t=${d.elapsed.toFixed(1)}s`);
  expect(d.outcome).toBe('defeat');
  expect(d.npc.health).toBeLessThan(400); // the fight was real: blows landed
  expect(d.npc.health).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('fighting in rounds and resting while he is calm wins', async ({ page }) => {
  test.setTimeout(480_000);
  const errors = await start(page);
  let rounds = 0;
  let d = await read(page);
  while (!d.outcome && rounds < 16) {
    rounds += 1;
    await setMood(page, 'enraged');
    d = await brawl(page, 40, (now) => now.player.health < 35);
    if (d.outcome) break;
    await setMood(page, 'calm');
    await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.player.health ?? 0) > 95, null, { timeout: 40_000 });
    d = await read(page);
  }
  console.log(`rounds=${rounds} outcome=${d.outcome} playerHealth=${Math.round(d.player.health)} t=${d.elapsed.toFixed(1)}s`);
  expect(d.outcome).toBe('victory');
  expect(rounds).toBeGreaterThan(1);

  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await read(page)).outcome).toBeNull();
  expect((await read(page)).npc.health).toBe(400);
  expect(errors).toEqual([]);
});

test('a rematch faces her at him, whatever the mouse did on the result screen', async ({ page }) => {
  const errors = await start(page);
  await capture(page);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('defeat'));
  await look(page, 1.5);
  await page.keyboard.press('KeyR');
  await expect.poll(async () => (await read(page)).outcome).toBeNull();
  expect((await read(page)).player.yaw).toBeCloseTo(Math.PI, 2);
  expect(errors).toEqual([]);
});

test('placed, a body stands in its new pose at once, not rising from the one it left', async ({ page }) => {
  await start(page);
  const [standing, placed] = await page.evaluate(async () => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Character } = await import('/src/entities/Character.ts' as string);
    const gltf = await new GLTFLoader().loadAsync('models/player.glb');
    return [false, true].map((downed) => {
      const character = new Character(gltf, 1.65);
      if (downed) {
        character.play('defeat', { loop: false, speed: 1.2 });
        for (let i = 0; i < 120; i++) character.update(1 / 60);
      }
      character.place(0, 0, 0);
      character.locomote('idle');
      character.update(1 / 60);
      return character.joint('Hip').y as number;
    });
  });
  expect(placed).toBeCloseTo(standing, 2);
});

test('an action owns the whole body unless it tracks the aim: then his hips pivot round to it', async ({ page }) => {
  await start(page);
  const [owned, tracked] = await page.evaluate(async () => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Character } = await import('/src/entities/Character.ts' as string);
    const gltf = await new GLTFLoader().loadAsync('models/npc.glb');
    return [false, true].map((track) => {
      const character = new Character(gltf, 2);
      character.play(track ? 'haymaker' : 'defeat', { loop: false, track });
      character.aim = 1.4; // she is well off to his left
      for (let i = 0; i < 60; i++) character.update(1 / 60);
      return { facing: character.root.rotation.y, twist: character['twist'] as number };
    });
  });
  expect(Math.abs(owned.facing) + Math.abs(owned.twist)).toBeLessThan(0.01);
  expect(tracked.facing).toBeGreaterThan(0.5);
  expect(tracked.twist).toBeLessThanOrEqual(0.8);
});

test('walking away, back or forward, or sideways, before or as he swings, does not dodge his blows', async ({ page }) => {
  await start(page);
  const misses = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js' as string);
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Npc } = await import('/src/entities/Npc.ts' as string);
    const gltf = await new GLTFLoader().loadAsync('models/npc.glb');
    const misses: string[] = [];
    // She walks away at her backing or walking speed, or sideways at her strafing speed: all along, or 0.2 s into each of his swings.
    for (const [speed, side, how] of [[1.5, 0, 'back'], [2, 0, 'forward'], [0, 2, 'side']] as const) {
      for (const reactive of [false, true]) {
        for (const pick of [0.1, 0.9]) {
          const npc = new Npc(gltf, () => pick); // punches only, then haymakers only
          const player = new THREE.Vector3(0, 0, 2);
          const events: FightEvent[] = [];
          npc.setMood('enraged', events);
          let [swings, hits, swungAt] = [0, 0, -9];
          for (let t = 0; t < 20; t += 1 / 60) {
            const away = player.clone().sub(npc.position).setY(0).normalize();
            if (!reactive || (npc.state === 'attack' && t - swungAt > 0.2)) {
              player.addScaledVector(away, speed / 60).addScaledVector(new THREE.Vector3(-away.z, 0, away.x), side / 60);
            }
            if (player.length() > 13) player.setLength(13); // inside the arena's edge
            npc.update(1 / 60, player, events);
            const apart = player.clone().sub(npc.position).setY(0);
            if (apart.length() < 0.9) player.copy(npc.position).add(apart.setLength(0.9)); // bodies don't overlap
            npc.character.update(1 / 60);
            for (const event of events) {
              if (event.type === 'swing') (swings += 1), (swungAt = t);
              if (event.type !== 'contact') continue;
              const arm = new THREE.Line3(npc.position.clone().setY(0), event.at.clone().setY(0));
              if (arm.closestPointToPoint(player, true, new THREE.Vector3()).distanceTo(player) <= 0.45) hits += 1;
            }
            events.length = 0;
          }
          if (hits < 0.85 * swings) misses.push(`${how} ${reactive ? 'on his swing' : 'all along'} ${pick < 0.5 ? 'punch' : 'haymaker'}: ${hits}/${swings}`);
        }
      }
    }
    return misses;
  });
  expect(misses).toEqual([]);
});

test('sprinting off as he swings outruns his blows', async ({ page }) => {
  await start(page);
  const landed = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js' as string);
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Npc } = await import('/src/entities/Npc.ts' as string);
    const gltf = await new GLTFLoader().loadAsync('models/npc.glb');
    const landed: string[] = [];
    for (const pick of [0.1, 0.9]) {
      const npc = new Npc(gltf, () => pick); // punches only, then haymakers only
      const player = new THREE.Vector3(0, 0, 2);
      const events: FightEvent[] = [];
      npc.setMood('enraged', events);
      let [swings, hits] = [0, 0];
      for (let t = 0; t < 10; t += 1 / 60) {
        if (npc.state === 'attack') player.add(player.clone().sub(npc.position).setY(0).setLength(5.3 / 60));
        npc.update(1 / 60, player, events);
        npc.character.update(1 / 60);
        for (const event of events) {
          if (event.type === 'swing') swings += 1;
          if (event.type !== 'contact') continue;
          const arm = new THREE.Line3(npc.position.clone().setY(0), event.at.clone().setY(0));
          if (arm.closestPointToPoint(player, true, new THREE.Vector3()).distanceTo(player) <= 0.45) hits += 1;
        }
        events.length = 0;
      }
      landed.push(`${hits}/${swings}`);
    }
    return landed;
  });
  expect(landed.every((s) => s.startsWith('0/') && s !== '0/0'), landed.join(', ')).toBe(true);
});
