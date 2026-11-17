import { devices, expect, test, type Page } from '@playwright/test';
import { tuning } from '../src/game/tuning';

// A phone held sideways: real touches, through the DevTools protocol, as Playwright's touchscreen only taps.
test.use({ ...devices['Pixel 7'], viewport: { width: 839, height: 412 } });

const read = (page: Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
const turn = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

test('held sideways, a tap starts the fight; the stick walks her, a drag turns her, the fist strikes, and pause pauses', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.hideDebugUi(true));
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const centre = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    return [box.x + box.width / 2, box.y + box.height / 2] as const;
  };

  await page.touchscreen.tap(420, 200);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'fight');
  await expect.poll(async () => (await read(page)).player.still).toBe(false);

  // The stick pushed straight up walks her forward, at walking pace.
  const [x, y] = await centre('#stick');
  const before = await read(page);
  await touch('touchStart', x, y);
  await touch('touchMove', x, y - 60);
  await page.waitForTimeout(800);
  expect((await read(page)).player.speed).toBeCloseTo(tuning.playerWalkSpeed, 0);
  await touch('touchEnd');
  await page.waitForTimeout(500);
  const walked = await read(page);
  const [dx, dz] = [walked.player.position.x - before.player.position.x, walked.player.position.z - before.player.position.z];
  expect(Math.hypot(dx, dz)).toBeGreaterThan(1);
  expect(Math.abs(turn(before.player.yaw, Math.atan2(dx, dz)))).toBeLessThan(0.1);

  // A drag rightward over the game turns her clockwise from above, as the mouse does.
  await touch('touchStart', 420, 200);
  await touch('touchMove', 520, 200);
  await touch('touchEnd');
  await page.waitForTimeout(200);
  expect(turn(walked.player.yaw, (await read(page)).player.yaw)).toBeCloseTo(-100 * tuning.mouseTurn, 2);

  await page.touchscreen.tap(...(await centre('#pad .strike')));
  await expect.poll(async () => (await read(page)).player.state).toBe('strike');

  await page.touchscreen.tap(...(await centre('#pad .pause')));
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'paused');
  await page.touchscreen.tap(420, 200);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'fight');
  expect(errors).toEqual([]);
});
