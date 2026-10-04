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

/** Hold W toward him and swing whenever he is in reach, for up to `seconds` or until `stop` holds. */
async function brawl(page: Page, seconds: number, stop: (d: Diagnostics) => boolean): Promise<Diagnostics> {
  const box = (await page.locator('#game-canvas').boundingBox())!;
  await page.mouse.move(box.width / 2, box.height / 2);
  await page.keyboard.down('KeyW');
  const end = Date.now() + seconds * 1000;
  let d = await read(page);
  while (Date.now() < end && !d.outcome && !stop(d)) {
    if (distance(d) < 2.2) {
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.waitForTimeout(120);
    d = await read(page);
  }
  await page.keyboard.up('KeyW');
  return d;
}

test('WASD moves the player', async ({ page }) => {
  const errors = await start(page);
  const before = await read(page);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyD');
  const after = await read(page);
  expect(Math.hypot(after.player.position.x - before.player.position.x, after.player.position.z - before.player.position.z)).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('a calm NPC keeps the player out of reach and cannot be hurt', async ({ page }) => {
  const errors = await start(page);
  let closest = Infinity;
  const d = await brawl(page, 6, (now) => {
    closest = Math.min(closest, distance(now));
    return false;
  });
  expect(d.npc.mood).toBe('calm');
  expect(closest).toBeGreaterThan(2.6);
  expect(d.npc.health).toBe(400);
  expect(d.player.health).toBe(100);
  expect(errors).toEqual([]);
});

test('a straight fight is lost: regen is too slow', async ({ page }) => {
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
