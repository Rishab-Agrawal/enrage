import { NodeIO } from '@gltf-transform/core';
import { expect, test } from '@playwright/test';

// The game moves the body; a clip that travels pulls the mesh away from it, and it snaps back on the next clip.
for (const [model, clips] of [['player', ['run']], ['npc', ['run', 'walk']]] as const) {
  test(`${model} locomotion plays in place`, async () => {
    const doc = await new NodeIO().read(`public/models/${model}.glb`);
    for (const name of clips) {
      const hip = doc.getRoot().listAnimations().find((a) => a.getName() === name)!
        .listChannels().find((c) => c.getTargetNode()?.getName() === 'Hip' && c.getTargetPath() === 'translation')!;
      const values = hip.getSampler()!.getOutput()!.getArray()!;
      let farthest = 0;
      for (let i = 0; i < values.length; i += 3) farthest = Math.max(farthest, Math.hypot(values[i], values[i + 1]));
      expect(farthest, `${model}/${name} hip travel`).toBeLessThan(0.25); // gait sway, not travel
    }
  });
}
