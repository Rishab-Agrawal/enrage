// Bakes each Tripo character into one game GLB: the rig GLB's skinned mesh and
// PBR textures plus the animation tracks of every retargeted clip FBX.
// Usage: node scripts/bake-characters.mjs   (reads artifacts/tripo, writes public/models)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';

// FBXLoader decodes embedded textures through an <img>; the bake only needs tracks.
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const TRIPO = 'artifacts/tripo';
// Clip name -> retarget output dir. Both rigs are Tripo's normalised v1.0 skeleton, so
// clips transfer between them (Gorran's haymaker is Wren's cross; both collapse the same way).
const CHARACTERS = {
  player: {
    idle: 'player-anim/idle', walk: 'npc-anim/walk', run: 'player-anim/run', jab: 'player-anim/box_01', cross: 'player-anim/box_02',
    hurt: 'player-anim/hit_to_body_01', defeat: 'npc-anim/defeat_03',
  },
  npc: {
    calm: 'npc-anim/fold_arms', idle: 'player-anim/idle', roar: 'npc-anim/angry_01', walk: 'npc-anim/walk', run: 'npc-anim/run',
    punch: 'npc-anim/box_03', haymaker: 'player-anim/box_02', hurt: 'npc-anim/hit_to_stomach', defeat: 'npc-anim/defeat_03',
  },
};
// Seconds to keep: the defeat take stands back up at the end.
const TRIM = { 'player/defeat': 4.6, 'npc/defeat': 4.6 };
// Locomotion plays in place: the game moves the body, and the clip records the ground speed it depicts.
const IN_PLACE = new Set(['run', 'walk']);
const PATHS = { position: 'translation', quaternion: 'rotation', scale: 'scale' };

const fileIn = (dir, ext) => {
  const name = readdirSync(dir).find((f) => f.endsWith(ext));
  if (!name) throw new Error(`No ${ext} in ${dir}`);
  return join(dir, name);
};

function readClip(file) {
  const buffer = readFileSync(file);
  const fbx = new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
  // FBXLoader emits each take twice; the shallower node path binds correctly.
  return fbx.animations.sort((a, b) => a.name.split('|').length - b.name.split('|').length)[0];
}

const isConstant = (values, stride) => values.every((v, i) => Math.abs(v - values[i % stride]) < 1e-5);
const angle = (q, i, j) => 2 * Math.acos(Math.min(1, Math.abs(q[i] * q[j] + q[i + 1] * q[j + 1] + q[i + 2] * q[j + 2] + q[i + 3] * q[j + 3])));

/**
 * Keys `a` < `b` one gait cycle (two steps, 0.5-1.5 s in any walk or run) apart whose poses match best: the
 * take's cleanest cycle. Looping more than one cycle would repeat the take's glitches (Tripo's walk lurches sideways).
 */
function bestCycle(clip, times) {
  const n = times.length;
  const rotations = clip.tracks.filter((t) => t.name.endsWith('.quaternion') && t.times.length === n);
  let best = { a: 0, b: n - 1, mismatch: Infinity };
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n && times[b] - times[a] <= 1.5; b++) {
      if (times[b] - times[a] < 0.5) continue;
      let mismatch = 0;
      for (const { values } of rotations) mismatch += angle(values, a * 4, b * 4) ** 2;
      if (mismatch < best.mismatch) best = { a, b, mismatch };
    }
  }
  return best;
}

/**
 * Makes a locomotion take a seamless in-place cycle: trims it to its cleanest cycle (Tripo's run starts
 * mid-stride and accelerating), then spreads every channel's mismatch across the loop, the Hip's travel
 * included, evenly over the cycle. Returns the ground speed it depicted, in armature units per second.
 */
function inPlace(clip) {
  const hip = clip.tracks.find((t) => t.name === 'Hip.position');
  const { a, b } = bestCycle(clip, hip.times);
  const [start, period] = [hip.times[a], hip.times[b] - hip.times[a]];
  const frames = hip.times.slice(a, b + 1);
  for (const track of clip.tracks) {
    const interpolant = track.createInterpolant(), size = track.getValueSize();
    const values = new Float32Array(frames.length * size);
    frames.forEach((t, i) => values.set(interpolant.evaluate(t), i * size));
    track.times = frames.map((t) => t - start);
    track.values = values;
  }
  clip.resetDuration();
  let travel;
  for (const track of clip.tracks) {
    const { times, values } = track, size = track.getValueSize(), last = values.length - size;
    const flip = size === 4 && values.slice(last).reduce((dot, v, k) => dot + v * values[k], 0) < 0 ? -1 : 1;
    const error = Array.from(values.slice(last), (v, k) => v - flip * values[k]);
    for (let i = 0; i < times.length; i++) {
      for (let k = 0; k < size; k++) values[i * size + k] -= (error[k] * times[i]) / period;
      if (size === 4) {
        const q = values.subarray(i * 4, i * 4 + 4), length = Math.hypot(...q);
        for (let k = 0; k < 4; k++) q[k] /= length;
      }
    }
    if (track === hip) travel = error;
  }
  // Hip carries the travel (Z is up): centre its sway on the body's origin.
  for (const k of [0, 1]) {
    let mean = 0;
    for (let i = k; i < hip.values.length; i += 3) mean += hip.values[i] / hip.times.length;
    for (let i = k; i < hip.values.length; i += 3) hip.values[i] -= mean;
  }
  return Math.hypot(travel[0], travel[1]) / period;
}

const io = new NodeIO();
for (const [character, clips] of Object.entries(CHARACTERS)) {
  const doc = await io.read(fileIn(join(TRIPO, `${character}-rig`, 'rig'), '.glb'));
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const nodes = new Map(root.listNodes().map((n) => [n.getName(), n]));

  for (const [name, source] of Object.entries(clips)) {
    const clip = readClip(fileIn(join(TRIPO, source), '.fbx'));
    if (TRIM[`${character}/${name}`]) clip.trim(0, TRIM[`${character}/${name}`]);
    const animation = doc.createAnimation(name);
    if (IN_PLACE.has(name)) animation.setExtras({ groundSpeed: inPlace(clip) });
    for (const track of clip.tracks) {
      const [nodeName, property] = track.name.split('.');
      const values = Float32Array.from(track.values);
      const stride = values.length / track.times.length;
      // FBX units: the armature carries a 100x scale the GLB already bakes in.
      if (nodeName === 'Armature' && property === 'scale') continue;
      if (property === 'scale' && isConstant(values, stride)) continue;
      const node = nodes.get(nodeName);
      if (!node) throw new Error(`${character}/${name}: no node ${nodeName}`);
      const sampler = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType('SCALAR').setArray(Float32Array.from(track.times)).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType(stride === 4 ? 'VEC4' : 'VEC3').setArray(values).setBuffer(buffer))
        .setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(
        doc.createAnimationChannel().setTargetNode(node).setTargetPath(PATHS[property]).setSampler(sampler),
      );
    }
    console.log(`${character}/${name} <- ${source}: ${animation.listChannels().length} channels, ${clip.duration.toFixed(2)}s`);
  }

  // Cel shading reads only colour and normals.
  for (const material of root.listMaterials()) material.setMetallicRoughnessTexture(null);
  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [1024, 1024] }),
  );
  const out = `public/models/${character}.glb`;
  await io.write(out, doc);
  console.log(`wrote ${out}`);
}
