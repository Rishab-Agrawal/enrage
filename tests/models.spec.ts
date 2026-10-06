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

// Gaits are drawn at the body's measured velocity, so each must loop in place, without a hitch, and record the ground
// velocity it depicts. The model faces +X, its left -Z.
const GAITS = {
  player: { run: [1, 0], walk: [1, 0], walkBack: [-1, 0], walkLeft: [0, -1], walkRight: [0, 1] },
  npc: { run: [1, 0], walk: [1, 0] },
};
for (const [model, gaits] of Object.entries(GAITS)) {
  test(`${model} gaits loop in place`, async () => {
    const doc = await new NodeIO().read(`public/models/${model}.glb`);
    for (const [name, [toX, toZ]] of Object.entries(gaits)) {
      const animation = doc.getRoot().listAnimations().find((a) => a.getName() === name)!;
      const [x, z] = animation.getExtras().groundVelocity as number[];
      expect(Math.acos((x * toX + z * toZ) / Math.hypot(x, z)), `${model}/${name} heading`).toBeLessThan(0.1);
      let swing = 0;
      for (const channel of animation.listChannels()) {
        const bone = `${model}/${name} ${channel.getTargetNode()!.getName()} ${channel.getTargetPath()}`;
        const output = channel.getSampler()!.getOutput()!;
        const [v, size, n] = [output.getArray()!, output.getElementSize(), output.getCount()];
        if (n < 4) continue;
        for (let i = 0; i < v.length; i++) swing = Math.max(swing, Math.abs(v[i] - v[i % size]));
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
          const steps: number[] = [];
          for (let i = 3; i < v.length; i += 3) steps.push(Math.hypot(v[i] - v[i - 3], v[i + 1] - v[i - 2]));
          steps.sort((a, b) => a - b);
          expect(steps.at(-1)!, `${bone} lurch`).toBeLessThan(5 * steps[steps.length >> 1]); // sways, never jolts
        }
      }
      expect(swing, `${model}/${name} motion`).toBeGreaterThan(0.05); // a held pose loops in place trivially
    }
  });
}

// Actions stand on the ground the bind pose does, and a toe on the ground stays put: within 3 cm of its lowest it hardly moves.
test('action clips keep their feet planted', async ({ page }) => {
  await page.goto('/');
  const clips = await page.evaluate(async () => {
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js' as string);
    const { Character } = await import('/src/entities/Character.ts' as string);
    const results: { clip: string; off: number; slide: number }[] = [];
    for (const [model, clips] of [['npc', ['roar', 'punch', 'haymaker', 'hurt', 'defeat']], ['player', ['jab', 'cross', 'hurt', 'defeat']]]) {
      const gltf = await new GLTFLoader().loadAsync(`models/${model}.glb`);
      for (const clip of clips) {
        const character = new Character(gltf, 2);
        const toes = () => ['L_ToeBase', 'R_ToeBase'].map((name) => character.joint(name));
        const ground = Math.min(...toes().map((toe) => toe.y));
        character.play(clip, { loop: false, fade: 0.001 });
        const frames = Array.from({ length: Math.ceil(gltf.animations.find((a: { name: string }) => a.name === clip)!.duration * 60) }, () => (character.update(1 / 60), toes()));
        const lowest = frames.slice(1).map((pair) => Math.min(...pair.map((toe) => toe.y)));
        const floors = [0, 1].map((k) => Math.min(...frames.map((pair) => pair[k].y)));
        let slide = 0;
        for (let i = 2; i < frames.length; i++) {
          for (const k of [0, 1]) {
            const [toe, before] = [frames[i][k], frames[i - 1][k]];
            if (Math.max(toe.y, before.y) < floors[k] + 0.03) slide += Math.hypot(toe.x - before.x, toe.z - before.z);
          }
        }
        results.push({ clip: `${model}/${clip}`, off: Math.abs(Math.min(...lowest) - ground), slide });
      }
    }
    return results;
  });
  for (const { clip, off, slide } of clips) {
    expect(off, `${clip} off the ground`).toBeLessThan(0.01);
    expect(slide, `${clip} planted toe slide`).toBeLessThan(0.2);
  }
});
