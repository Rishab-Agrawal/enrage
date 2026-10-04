import { NodeIO } from '@gltf-transform/core';
import { expect, test } from '@playwright/test';

/** How sharply a channel changes velocity at key `i`, given its neighbours `before` and `after`. */
function jerk(v: ArrayLike<number>, size: number, before: number, i: number, after: number): number {
  // Quaternions q and -q are the same rotation: compare neighbours in the centre key's hemisphere.
  const side = (j: number) => {
    let dot = 0;
    for (let k = 0; k < size; k++) dot += v[j * size + k] * v[i * size + k];
    return size === 4 && dot < 0 ? -1 : 1;
  };
  let sum = 0;
  for (let k = 0; k < size; k++) sum += (side(after) * v[after * size + k] - 2 * v[i * size + k] + side(before) * v[before * size + k]) ** 2;
  return Math.sqrt(sum);
}

// Gaits are drawn at the body's measured speed, so each must loop in place, without a hitch, and record the speed it depicts.
for (const [model, clips] of [['player', ['run']], ['npc', ['run', 'walk']]] as const) {
  test(`${model} gaits loop in place`, async () => {
    const doc = await new NodeIO().read(`public/models/${model}.glb`);
    for (const name of clips) {
      const animation = doc.getRoot().listAnimations().find((a) => a.getName() === name)!;
      expect(animation.getExtras().groundSpeed, `${model}/${name} ground speed`).toBeGreaterThan(0);
      for (const channel of animation.listChannels()) {
        const bone = `${model}/${name} ${channel.getTargetNode()!.getName()} ${channel.getTargetPath()}`;
        const output = channel.getSampler()!.getOutput()!;
        const [v, size, n] = [output.getArray()!, output.getElementSize(), output.getCount()];
        if (n < 4) continue;
        // The last key repeats the first, and motion carries through the wrap as smoothly as anywhere inside the cycle.
        let closing = 0;
        for (let k = 0; k < size; k++) closing = Math.max(closing, Math.abs(Math.abs(v[(n - 1) * size + k]) - Math.abs(v[k])));
        expect(closing, `${bone} closing key`).toBeLessThan(1e-3);
        let inside = 0;
        for (let i = 1; i < n - 1; i++) inside = Math.max(inside, jerk(v, size, i - 1, i, i + 1));
        expect(jerk(v, size, n - 2, 0, 1), `${bone} loop seam`).toBeLessThanOrEqual(1.5 * inside + 1e-4);
        if (channel.getTargetPath() === 'translation' && channel.getTargetNode()!.getName() === 'Hip') {
          let farthest = 0;
          for (let i = 0; i < v.length; i += 3) farthest = Math.max(farthest, Math.hypot(v[i], v[i + 1]));
          expect(farthest, `${bone} travel`).toBeLessThan(0.25); // gait sway, not travel
        }
      }
    }
  });
}
