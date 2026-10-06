import { expect, test, type Page } from '@playwright/test';
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
  // Sprinting, D steers her run a little, at full speed.
  expect(sprintDiagonal.heading).toBeGreaterThan(-Math.PI / 4);
  expect(sprintDiagonal.heading).toBeLessThan(-0.1);
  expect(sprintDiagonal.moved).toBeGreaterThan(0.95 * sprinted.moved);
  // No key turns her.
  for (const { turned } of [walked, sprinted, backed, right, left, diagonal, sprintDiagonal, backDiagonal]) expect(Math.abs(turned)).toBeLessThan(1e-6);
  expect((await travel(['ShiftLeft'], 100)).moved).toBeGreaterThan(1.5);
  expect(errors).toEqual([]);
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

test('legs settle on the speed the body actually moves at', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = await start(page);
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

test('a calm NPC shoves off a player who rushes him, dashing too, before she can touch him', async ({ page }) => {
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
  let rushing = true;
  const dashes = (async () => {
    while (rushing) {
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(750);
    }
  })();
  const d = await brawl(page, 10, () => false);
  rushing = false;
  await dashes;
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
  test.setTimeout(300_000);
  const errors = await start(page);
  let rounds = 0;
  let d = await read(page);
  while (!d.outcome && rounds < 12) {
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
