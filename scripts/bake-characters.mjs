// Bakes each Tripo character into one game GLB: the rig GLB's skinned mesh and
// PBR textures plus the animation tracks of every clip FBX (Tripo retargets, or Mixamo takes retargeted here).
// Usage: node scripts/bake-characters.mjs   (reads artifacts, writes public/models)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import * as THREE from 'three';
import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';

// FBXLoader decodes embedded textures through an <img>; the bake only needs tracks.
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

const ARTIFACTS = 'artifacts';
// Clip name -> FBX dir. Both rigs are Tripo's normalised v1.0 skeleton, so
// clips transfer between them (Gorran's haymaker is Wren's cross; both collapse the same way).
const CHARACTERS = {
  player: {
    idle: 'tripo/player-anim/idle', walk: 'mixamo/walk', walkBack: 'mixamo/walk-back', run: 'tripo/player-anim/run', jab: 'tripo/player-anim/box_01', cross: 'tripo/player-anim/box_02',
    hurt: 'tripo/player-anim/hit_to_body_01', defeat: 'tripo/npc-anim/defeat_03',
  },
  npc: {
    calm: 'tripo/npc-anim/fold_arms', idle: 'tripo/player-anim/idle', roar: 'tripo/npc-anim/angry_01', walk: 'tripo/npc-anim/walk', run: 'tripo/npc-anim/run',
    punch: 'tripo/npc-anim/box_03', haymaker: 'tripo/player-anim/box_02', hurt: 'tripo/npc-anim/hit_to_stomach', defeat: 'tripo/npc-anim/defeat_03',
  },
};
// Seconds to keep: the defeat take stands back up at the end.
const TRIM = { 'tripo/npc-anim/defeat_03': 4.6 };
// Locomotion plays in place: the game moves the body, and the clip records the ground speed it depicts.
const IN_PLACE = new Set(['run', 'walk', 'walkBack']);
// Seconds either side of a gait's loop seam over which its velocity jump is eased out.
const SEAM_EASE = 0.2;
const PATHS = { position: 'translation', quaternion: 'rotation', scale: 'scale' };

const fileIn = (dir, ext) => {
  const name = readdirSync(dir).find((f) => f.endsWith(ext));
  if (!name) throw new Error(`No ${ext} in ${dir}`);
  return join(dir, name);
};

function readFbx(file) {
  const buffer = readFileSync(file);
  return new FBXLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
}

// FBXLoader emits each take twice; the shallower node path binds correctly.
const takeOf = (fbx) => fbx.animations.sort((a, b) => a.name.split('|').length - b.name.split('|').length)[0];

// Mixamo bone -> Tripo bone. Tripo bones not listed hold their rest pose.
const MIXAMO = {
  Hips: 'Hip', Spine: 'Waist', Spine1: 'Spine01', Spine2: 'Spine02', Neck: 'NeckTwist01', Head: 'Head',
  ...Object.fromEntries(['Left', 'Right'].flatMap((side) => Object.entries({
    Shoulder: 'Clavicle', Arm: 'Upperarm', ForeArm: 'Forearm', Hand: 'Hand', UpLeg: 'Thigh', Leg: 'Calf', Foot: 'Foot', ToeBase: 'ToeBase',
  }).map(([from, to]) => [side + from, `${side[0]}_${to}`]))),
};
// Mixamo faces +Z; Tripo faces +X. Both are Y-up.
const TO_TRIPO = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
// Tripo's clips key the Armature from Z-up to Y-up and counter-rotate Root; keying the same keeps crossfades upright.
const ARMATURE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/**
 * Re-expresses a Mixamo take on a Tripo rig. Both rest in a T-pose, so each Tripo bone turns, in world space, as its
 * Mixamo bone turns from rest; the hips travel scaled by hip height. Wrists hold their rest bend: Mixamo walks flap
 * them ~40°, which reads as flailing on rigid gloved fists.
 */
function retarget(fbx, nodes) {
  const take = takeOf(fbx);
  const world = (node) => {
    const m = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    const [position, rotation] = [new THREE.Vector3(), new THREE.Quaternion()];
    m.decompose(position, rotation, new THREE.Vector3());
    return { position, rotation };
  };
  const bone = (name) => fbx.getObjectByName(`mixamorig${name}`);
  fbx.updateMatrixWorld(true);
  const rest = new Map(Object.keys(MIXAMO).map((name) => [name, bone(name).getWorldQuaternion(new THREE.Quaternion())]));
  const hipsRest = bone('Hips').getWorldPosition(new THREE.Vector3());
  const [root, hip] = [world(nodes.get('Root')), world(nodes.get('Hip'))];
  const scale = hip.position.y / hipsRest.y;
  const tripo = new Map(Object.entries(MIXAMO).filter(([from]) => !from.endsWith('Hand')).map(([from, to]) => [to, from]));

  const times = take.tracks.find((t) => t.name === 'mixamorigHips.position').times;
  const values = new Map([...tripo.keys()].map((name) => [name, []]));
  const hipTravel = [];
  const mixer = new THREE.AnimationMixer(fbx);
  const action = mixer.clipAction(take).play();
  // A zero-step update applies `action.time` as given: no wrap to the first key, no pause at the last.
  const pose = (t) => {
    action.time = t;
    mixer.update(0);
    fbx.updateMatrixWorld(true);
  };
  const turn = new THREE.Quaternion(), q = new THREE.Quaternion(), p = new THREE.Vector3();
  for (const t of times) {
    pose(t);
    // Walk the Tripo tree from Root, carrying each parent's world rotation.
    const visit = (node, parent) => {
      const from = tripo.get(node.getName());
      let rotation;
      if (from) {
        bone(from).getWorldQuaternion(turn).multiply(q.copy(rest.get(from)).invert());
        turn.premultiply(TO_TRIPO).multiply(q.copy(TO_TRIPO).invert());
        rotation = turn.clone().multiply(world(node).rotation);
        values.get(node.getName()).push(...q.copy(parent).invert().multiply(rotation).toArray());
      } else {
        rotation = parent.clone().multiply(new THREE.Quaternion(...node.getRotation()));
      }
      for (const child of node.listChildren()) visit(child, rotation);
    };
    for (const child of nodes.get('Root').listChildren()) visit(child, root.rotation);
    bone('Hips').getWorldPosition(p).sub(hipsRest).multiplyScalar(scale).applyQuaternion(TO_TRIPO).add(hip.position);
    hipTravel.push(...p.sub(root.position).applyQuaternion(q.copy(root.rotation).invert()).toArray());
  }

  const constant = (name, value) => new THREE.KeyframeTrack(name, [0, times.at(-1)], [...value, ...value]);
  const armatureRoot = new THREE.Quaternion().copy(ARMATURE).invert().multiply(root.rotation);
  return new THREE.AnimationClip(take.name, -1, [
    constant('Armature.quaternion', ARMATURE.toArray()),
    constant('Root.quaternion', armatureRoot.toArray()),
    constant('Root.position', root.position.clone().applyQuaternion(ARMATURE.clone().invert()).toArray()),
    new THREE.VectorKeyframeTrack('Hip.position', times, hipTravel),
    ...[...values].map(([name, v]) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, v)),
  ]);
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
 * mid-stride and accelerating), then spreads every channel's pose mismatch across the loop, the Hip's travel
 * included, and eases out its velocity jump at the seam. Returns the ground speed it depicted, in armature units per second.
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
    // q and -q are one rotation: keep each key in its predecessor's hemisphere, since the fixes below work on components.
    for (let i = 4; size === 4 && i < values.length; i += 4) {
      if (values[i] * values[i - 4] + values[i + 1] * values[i - 3] + values[i + 2] * values[i - 2] + values[i + 3] * values[i - 1] < 0) {
        for (let k = i; k < i + 4; k++) values[k] = -values[k];
      }
    }
    track.times = frames.map((t) => t - start);
    track.values = values;
  }
  clip.resetDuration();
  let travel;
  for (const track of clip.tracks) {
    const { times, values } = track, size = track.getValueSize(), last = values.length - size;
    const flip = size === 4 && values.slice(last).reduce((dot, v, k) => dot + v * values[k], 0) < 0 ? -1 : 1;
    const error = Array.from(values.slice(last), (v, k) => v - flip * values[k]);
    // Mixamo's loops close the pose, not the motion: ease the seam's velocity jump out with a bump local to it.
    const slope = (i) => Array.from({ length: size }, (_, k) => (values[(i + 1) * size + k] - values[i * size + k]) / (times[i + 1] - times[i]));
    const [opening, closing] = [slope(0), slope(times.length - 2)];
    const kink = closing.map((v, k) => (v - flip * opening[k]) / 2);
    for (let i = 0; i < times.length; i++) {
      const away = Math.min(times[i], period - times[i]), bump = away < SEAM_EASE ? away * (1 - away / SEAM_EASE) ** 2 : 0;
      for (let k = 0; k < size; k++) values[i * size + k] += kink[k] * bump - (error[k] * times[i]) / period;
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
  // The body faces -Y in Root space: a backward gait records a negative ground speed.
  return (Math.sign(-travel[1]) * Math.hypot(travel[0], travel[1])) / period;
}

const io = new NodeIO();
for (const [character, clips] of Object.entries(CHARACTERS)) {
  const doc = await io.read(fileIn(join(ARTIFACTS, 'tripo', `${character}-rig`, 'rig'), '.glb'));
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const nodes = new Map(root.listNodes().map((n) => [n.getName(), n]));

  for (const [name, source] of Object.entries(clips)) {
    const fbx = readFbx(fileIn(join(ARTIFACTS, source), '.fbx'));
    const clip = fbx.getObjectByName('mixamorigHips') ? retarget(fbx, nodes) : takeOf(fbx);
    if (TRIM[source]) {
      for (const track of clip.tracks) track.trim(0, TRIM[source]);
      clip.resetDuration();
    }
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
