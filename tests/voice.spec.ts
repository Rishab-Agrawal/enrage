import { expect, test } from '@playwright/test';
import { COOLDOWN, LISTEN, Voice } from '../src/systems/Voice';

test('the mic listens for at most LISTEN s per press, then ignores presses for COOLDOWN s', () => {
  const voice = new Voice();
  voice.update(0.1, true, true);
  expect(voice.state).toBe('listening');
  expect(voice.update(LISTEN, false, true)).toBe(true);
  expect(voice.state).toBe('cooldown');
  voice.update(COOLDOWN / 2, true, true);
  expect(voice.state).toBe('cooldown');
  voice.update(COOLDOWN / 2, false, true);
  expect(voice.state).toBe('ready');
  voice.update(0.1, false, true); // still held from before: no fresh press
  expect(voice.state).toBe('ready');
  voice.update(0.1, true, true);
  voice.update(1, false, false);
  expect(voice.state).toBe('cooldown');
});
