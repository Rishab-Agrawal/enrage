import { NodeIO } from '@gltf-transform/core';
import { expect, test } from '@playwright/test';

// Gaits are drawn at the body's measured speed, so each must loop in place, without a hitch, and record the speed it depicts.
for (const [model, clips] of [['player', ['run']], ['npc', ['run', 'walk']]] as const) {
  test(`${model} gaits loop in place`, async () => {
    const doc = await new NodeIO().read(`public/models/${model}.glb`);
    for (const name of clips) {
      const animation = doc.getRoot().listAnimations().find((a) => a.getName() === name)!;
      expect(animation.getExtras().groundSpeed, `${model}/${name} ground speed`).toBeGreaterThan(0);
      for (const channel of animation.listChannels()) {
        const bone = `${model}/${name} ${channel.getTargetNode()!.getName()}`;
        const v = channel.getSampler()!.getOutput()!.getArray()!;
        if (channel.getTargetPath() === 'rotation') {
          const n = v.length - 4;
          const seam = 2 * Math.acos(Math.min(1, Math.abs(v[0] * v[n] + v[1] * v[n + 1] + v[2] * v[n + 2] + v[3] * v[n + 3])));
          expect(seam, `${bone} loop seam`).toBeLessThan(0.02);
        } else if (channel.getTargetPath() === 'translation' && channel.getTargetNode()!.getName() === 'Hip') {
          let farthest = 0;
          for (let i = 0; i < v.length; i += 3) farthest = Math.max(farthest, Math.hypot(v[i], v[i + 1]));
          expect(farthest, `${bone} travel`).toBeLessThan(0.25); // gait sway, not travel
        }
      }
    }
  });
}
