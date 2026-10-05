import { expect, test, type Page } from '@playwright/test';

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
  return errors;
}

/** Signed shortest turn from yaw `a` to yaw `b`. */
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Sprint at him, turning toward him with A/D, then stand and swing while he is in reach, for up to `seconds` or until `stop` holds. */
async function brawl(page: Page, seconds: number, stop: (d: Diagnostics) => boolean): Promise<Diagnostics> {
  const box = (await page.locator('#game-canvas').boundingBox())!;
  await page.mouse.move(box.width / 2, box.height / 2);
  let turning: string | null = null;
  const steer = async (d: Diagnostics) => {
    const bearing = turn(d.player.yaw, Math.atan2(d.npc.position.x - d.player.position.x, d.npc.position.z - d.player.position.z));
    const key = bearing > 0.15 ? 'KeyA' : bearing < -0.15 ? 'KeyD' : null; // A turns left, raising yaw
    if (key === turning) return;
    if (turning) await page.keyboard.up(turning);
    if (key) await page.keyboard.down(key);
    turning = key;
  };
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
  if (turning) await page.keyboard.up(turning);
  return d;
}

test('W walks, Shift sprints, S backs up, A/D only turn, and Shift alone dashes', async ({ page }) => {
  const errors = await start(page);
  /** Metres moved and radians turned while `keys` are held, pressed in order, for `ms`. */
  const travel = async (keys: string[], ms: number) => {
    const before = await read(page);
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    for (const key of keys) await page.keyboard.up(key);
    await page.waitForTimeout(400);
    const after = await read(page);
    const moved = Math.hypot(after.player.position.x - before.player.position.x, after.player.position.z - before.player.position.z);
    return { moved, turned: turn(before.player.yaw, after.player.yaw) };
  };
  const walked = await travel(['KeyW'], 600);
  const sprinted = await travel(['KeyW', 'ShiftLeft'], 600);
  const backed = await travel(['KeyS', 'ShiftLeft'], 600);
  const turned = await travel(['KeyD'], 600);
  expect(walked.moved).toBeGreaterThan(0.5);
  expect(sprinted.moved).toBeGreaterThan(2 * walked.moved);
  // Shift doesn't hurry her backwards, and walking either way keeps her facing.
  expect(backed.moved).toBeGreaterThan(0.4);
  expect(backed.moved).toBeLessThan(walked.moved);
  for (const { turned } of [walked, sprinted, backed]) expect(Math.abs(turned)).toBeLessThan(1e-6);
  expect(turned.turned).toBeLessThan(-0.5); // D turns her right: clockwise from above
  expect((await travel(['ShiftLeft'], 100)).moved).toBeGreaterThan(1.5);
  expect(errors).toEqual([]);
});

test('she walks on while she strikes', async ({ page }) => {
  const errors = await start(page);
  const box = (await page.locator('#game-canvas').boundingBox())!;
  await page.mouse.move(box.width / 2, box.height / 2);
  const before = await read(page);
  let struck = false;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 8; i++) {
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    struck ||= (await read(page)).player.state === 'strike';
  }
  await page.keyboard.up('KeyW');
  const after = await read(page);
  const walked = Math.hypot(after.player.position.x - before.player.position.x, after.player.position.z - before.player.position.z);
  expect(struck).toBe(true);
  expect(walked / (after.elapsed - before.elapsed)).toBeGreaterThan(1.2); // near her 1.5 m/s walk
  expect(errors).toEqual([]);
});

test('turning on the spot, her upper body leads and her hips pivot to catch up', async ({ page }) => {
  const errors = await start(page);
  await page.keyboard.down('KeyD');
  let [fastest, lead] = [0, 0];
  for (const end = Date.now() + 1500; Date.now() < end; ) {
    await page.waitForTimeout(40);
    const d = await read(page);
    fastest = Math.max(fastest, d.player.speed);
    lead = Math.max(lead, Math.abs(turn(d.player.facing, d.player.yaw)));
  }
  await page.keyboard.up('KeyD');
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
    [['KeyD'], 800], // turn on the spot
    [['KeyW', 'KeyD'], 3000], // walk an arc
    [['KeyW', 'KeyD', 'ShiftLeft'], 2000], // sprint an arc
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

test('a calm NPC shoves off a player who closes in, and cannot be hurt', async ({ page }) => {
  const errors = await start(page);
  let shoved = false;
  const d = await brawl(page, 6, (now) => {
    shoved ||= now.player.state === 'hurt';
    return false;
  });
  expect(d.npc.mood).toBe('calm');
  expect(shoved).toBe(true);
  expect(d.npc.health).toBe(400);
  expect(d.player.health).toBe(100);
  expect(errors).toEqual([]);
});

test('a calm NPC nudged inside his comfort distance walks well clear of it', async ({ page }) => {
  const errors = await start(page);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__!;
    return Math.hypot(d.player.position.x - d.npc.position.x, d.player.position.z - d.npc.position.z) < 5.9;
  });
  await page.keyboard.up('KeyW');
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
