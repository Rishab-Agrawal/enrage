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
    idle: 'player-anim/idle', run: 'player-anim/run', jab: 'player-anim/box_01', cross: 'player-anim/box_02',
    hurt: 'player-anim/hit_to_body_01', defeat: 'npc-anim/defeat_03',
  },
  npc: {
    calm: 'npc-anim/fold_arms', roar: 'npc-anim/angry_01', walk: 'npc-anim/walk', run: 'npc-anim/run',
    punch: 'npc-anim/box_03', haymaker: 'player-anim/box_02', hurt: 'npc-anim/hit_to_stomach', defeat: 'npc-anim/defeat_03',
  },
};
// Seconds to keep: the defeat take stands back up at the end.
const TRIM = { 'player/defeat': 4.6, 'npc/defeat': 4.6 };
// Locomotion plays in place: the game moves the body.
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
    for (const track of clip.tracks) {
      const [nodeName, property] = track.name.split('.');
      const values = Float32Array.from(track.values);
      const stride = values.length / track.times.length;
      // FBX units: the armature carries a 100x scale the GLB already bakes in.
      if (nodeName === 'Armature' && property === 'scale') continue;
      if (property === 'scale' && isConstant(values, stride)) continue;
      // Hip carries the travel (Z is up): strip its horizontal drift and centre the cycle on the body's origin, keeping sway and bob.
      if (IN_PLACE.has(name) && nodeName === 'Hip' && property === 'position') {
        const { times } = track, n = times.length, last = values.length - 3;
        for (const k of [0, 1]) {
          const drift = values[last + k] - values[k];
          let mean = 0;
          for (let i = 0; i < n; i++) mean += (values[i * 3 + k] -= (drift * (times[i] - times[0])) / (times[n - 1] - times[0])) / n;
          for (let i = 0; i < n; i++) values[i * 3 + k] -= mean;
        }
      }
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
