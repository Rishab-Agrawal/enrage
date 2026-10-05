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
// Clip name -> FBX dir, or a function keying the clip on the rig's nodes. Both rigs are Tripo's normalised v1.0 skeleton, so
// clips transfer between them (Gorran's haymaker is Wren's cross; both collapse the same way).
const CHARACTERS = {
  player: {
    idle: 'tripo/player-anim/idle', walk: 'mixamo/walk', walkBack: 'mixamo/walk-back', run: 'tripo/player-anim/run', jab: 'tripo/player-anim/box_01', cross: 'tripo/player-anim/box_02',
    hurt: 'tripo/player-anim/hit_to_body_01', defeat: 'tripo/npc-anim/defeat_03',
  },
  npc: {
    calm: 'tripo/npc-anim/fold_arms', idle: 'tripo/player-anim/idle', roar: 'tripo/npc-anim/angry_01', walk: 'tripo/npc-anim/walk', run: 'tripo/npc-anim/run',
    punch: 'tripo/npc-anim/box_03', haymaker: 'tripo/player-anim/box_02', hurt: 'tripo/npc-anim/hit_to_stomach', defeat: 'tripo/npc-anim/defeat_03',
    push: shove,
  },
};
// Seconds to keep: the defeat take stands back up at the end.
const TRIM = { 'tripo/npc-anim/defeat_03': 4.6 };
// Locomotion plays in place: the game moves the body, and the clip records the ground speed it depicts.
const IN_PLACE = new Set(['run', 'walk', 'walkBack']);
// Standing clips sway in place under the body, as the push's step out and back does; every other clip is an action.
const STANDING = new Set(['idle', 'calm', 'push']);
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
// Arms swing half as far as Mixamo's, about a hang 7° further forward, with elbows 40% straighter.
const ARM_SWING = 0.5;
const ARM_FORWARD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(7));
const ELBOW_BEND = 0.6;

/**
 * Re-expresses a Mixamo take on a Tripo rig. Both rest in a T-pose, so each Tripo bone turns, in world space, as its
 * Mixamo bone turns from rest; the hips travel scaled by hip height. Legs and collarbones first take Mixamo's rest
 * stance: Tripo's legs stand splayed ~7° and its collarbones hiked ~13°, which every step would carry, landing the feet
 * three times as wide under shrugged shoulders. Arms swing gentler than Mixamo's, and wrists hold their rest bend:
 * Mixamo walks flap them ~40°, which reads as flailing on rigid gloved fists.
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
  const stance = new Map(['Left', 'Right'].flatMap((side) => [['UpLeg', 'Leg'], ['Leg', 'Foot'], ['Shoulder', 'Arm']].map(([from, to]) => {
    const [a, b] = [MIXAMO[side + from], MIXAMO[side + to]];
    const own = world(nodes.get(b)).position.sub(world(nodes.get(a)).position).normalize();
    const theirs = bone(side + to).getWorldPosition(new THREE.Vector3()).sub(bone(side + from).getWorldPosition(new THREE.Vector3()));
    return [a, new THREE.Quaternion().setFromUnitVectors(own, theirs.applyQuaternion(TO_TRIPO).normalize())];
  })));

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
        rotation = turn.clone().multiply(stance.get(node.getName()) ?? q.identity()).multiply(world(node).rotation);
        if (node.getName().endsWith('arm')) rotation.premultiply(ARM_FORWARD); // upper arm and forearm alike
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
  // Keeps `share` of each key's turn away from `toward`: by default the bone's average pose.
  const ease = (name, share, toward) => {
    const keys = values.get(name);
    const poses = Array.from(times, (_, i) => new THREE.Quaternion().fromArray(keys, i * 4));
    toward ??= poses.reduce((m, pose, i) => m.slerp(pose, 1 / (i + 1)), poses[0].clone());
    poses.forEach((pose, i) => q.slerpQuaternions(toward, pose, share).toArray(keys, i * 4));
  };
  for (const side of ['L', 'R']) {
    ease(`${side}_Upperarm`, ARM_SWING);
    ease(`${side}_Forearm`, ELBOW_BEND, new THREE.Quaternion(...nodes.get(`${side}_Forearm`).getRotation())); // rest: near straight
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

/**
 * Plays an action take in place: its hips keep their height and turn but stand over the rig's rest hips. Returns the
 * ground they covered as travel, [time, x, z, ...] in the model's frame, for the game to move the body by: a step
 * then carries on into whatever plays next instead of snapping back.
 */
function rootMotion(clip, nodes) {
  const track = (name) => clip.tracks.find((t) => t.name === name);
  const rest = (name) => new THREE.Quaternion(...nodes.get(name).getRotation());
  const armature = new THREE.Quaternion().fromArray(track('Armature.quaternion').values);
  // Root's rest turn as the take keys it: the take's Armature turn differs from the rig's.
  const restRoot = armature.clone().invert().multiply(rest('Armature')).multiply(rest('Root'));
  const stand = new THREE.Vector3(...nodes.get('Hip').getTranslation()).applyQuaternion(restRoot);
  const hip = track('Hip.position');
  const turns = track('Root.quaternion').createInterpolant();
  const [q, p, moved] = [new THREE.Quaternion(), new THREE.Vector3(), new THREE.Vector3()];
  const travel = [];
  hip.times.forEach((t, i) => {
    q.fromArray(turns.evaluate(t));
    p.fromArray(hip.values, i * 3).applyQuaternion(q); // the Armature's frame: Z is up
    moved.set(p.x - stand.x, p.y - stand.y, 0).applyQuaternion(armature);
    travel.push(t, moved.x, moved.z);
    p.setX(stand.x).setY(stand.y).applyQuaternion(q.invert()).toArray(hip.values, i * 3);
  });
  return travel;
}

/** Turns `bone` so its world rotation is `rotation`. */
function setWorld(bone, rotation) {
  bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));
  bone.updateMatrixWorld(true);
}

/** Bends the chain `upper` -> `lower` -> `end` so `end` reaches `target`, the middle joint bowing toward `pole`. */
function reach(upper, lower, end, target, pole) {
  const [a, b, c] = [upper, lower, end].map((bone) => bone.getWorldPosition(new THREE.Vector3()));
  const [l1, l2] = [a.distanceTo(b), b.distanceTo(c)];
  const d = Math.min(a.distanceTo(target), (l1 + l2) * 0.999);
  const along = target.clone().sub(a).normalize();
  const bow = pole.clone().addScaledVector(along, -pole.dot(along)).normalize();
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const joint = a.clone().addScaledVector(along, x).addScaledVector(bow, Math.sqrt(Math.max(0, l1 * l1 - x * x)));
  const aim = (bone, from, to, child) => {
    const at = bone.getWorldPosition(new THREE.Vector3());
    const turn = new THREE.Quaternion().setFromUnitVectors(from.clone().sub(at).normalize(), to.clone().sub(at).normalize());
    setWorld(bone, turn.multiply(bone.getWorldQuaternion(new THREE.Quaternion())));
    return child.getWorldPosition(new THREE.Vector3());
  };
  aim(upper, b, joint, lower);
  aim(lower, end.getWorldPosition(new THREE.Vector3()), a.addScaledVector(along, d), end);
}

/** Rotation taking the frame (`x`, `y`) to (`toX`, `toY`); each pair orthogonal unit vectors. */
const frameTurn = (x, y, toX, toY) => {
  const basis = (u, v) => new THREE.Matrix4().makeBasis(u, v, u.clone().cross(v));
  return new THREE.Quaternion().setFromRotationMatrix(basis(toX, toY).multiply(basis(x, y).transpose()));
};

const smooth = (t, from, to) => THREE.MathUtils.smoothstep(t, from, to);

/**
 * Gorran's two-handed shove, which no take covers, keyed here over his folded-arms stance (+X forward, +Y up, left -Z).
 * His palms chamber at his chest and drive out at clip second 0.12 as he leans in and steps through with his left
 * foot; he holds, then folds his arms again by 0.75.
 */
function shove(nodes) {
  const bones = new Map([...nodes].map(([name, node]) => {
    const bone = new THREE.Object3D();
    bone.name = name;
    bone.position.fromArray(node.getTranslation());
    bone.quaternion.fromArray(node.getRotation());
    return [name, bone];
  }));
  for (const [name, node] of nodes) for (const child of node.listChildren()) bones.get(name).add(bones.get(child.getName()));
  const bone = (name) => bones.get(name);
  const rig = bone('Armature');
  rig.updateMatrixWorld(true);
  // Each palm in its hand's frame, from the rest T-pose: fingers out along the arm, palm down.
  const palms = Object.fromEntries(['L', 'R'].map((side) => {
    const hand = bone(`${side}_Hand`), inverse = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
    const fingers = hand.getWorldPosition(new THREE.Vector3()).sub(bone(`${side}_Forearm`).getWorldPosition(new THREE.Vector3()));
    fingers.normalize().applyQuaternion(inverse);
    const palm = new THREE.Vector3(0, -1, 0).applyQuaternion(inverse);
    return [side, [fingers, palm.addScaledVector(fingers, -palm.dot(fingers)).normalize()]];
  }));

  const take = takeOf(readFbx(fileIn(join(ARTIFACTS, 'tripo/npc-anim/fold_arms'), '.fbx')));
  take.tracks = take.tracks.filter((t) => !t.name.endsWith('.scale'));
  const mixer = new THREE.AnimationMixer(rig);
  mixer.clipAction(take).play().time = 8.5; // arms folded
  mixer.update(0);
  rig.updateMatrixWorld(true);
  const base = new Map([...bones.values()].map((b) => [b, [b.position.clone(), b.quaternion.clone()]]));
  const at = (name) => bone(name).getWorldPosition(new THREE.Vector3());
  const arm = at('L_Upperarm').distanceTo(at('L_Forearm')) + at('L_Forearm').distanceTo(at('L_Hand'));
  const [feet, soles] = [['L_Foot', 'R_Foot'].map(at), ['L_Foot', 'R_Foot'].map((n) => bone(n).getWorldQuaternion(new THREE.Quaternion()))];
  const hip = at('Hip');
  const lateral = new THREE.Vector3(0, 0, 1);

  const pose = (t) => {
    for (const [b, [position, quaternion]] of base) b.position.copy(position), b.quaternion.copy(quaternion);
    rig.updateMatrixWorld(true);
    const [drive, step, back] = [smooth(t, 0, 0.12), smooth(t, 0, 0.14), smooth(t, 0.32, 0.75)];
    // Weight onto the front foot: hips forward and down, the chest leaning in further, the head holding level.
    bone('Hip').position.copy(bone('Hip').parent.worldToLocal(hip.clone().add(new THREE.Vector3(0.24, -0.08, 0).multiplyScalar(arm * step))));
    for (const [name, angle] of [['Waist', -0.18], ['Spine01', -0.2], ['NeckTwist01', 0.24]]) {
      const b = bone(name);
      setWorld(b, new THREE.Quaternion().setFromAxisAngle(lateral, angle * step).multiply(b.getWorldQuaternion(new THREE.Quaternion())));
    }
    ['L', 'R'].forEach((side, i) => {
      const foot = feet[i].clone();
      if (side === 'L') foot.add(new THREE.Vector3(0.5 * step, 0.2 * Math.sin(Math.PI * step), 0).multiplyScalar(arm));
      reach(bone(`${side}_Thigh`), bone(`${side}_Calf`), bone(`${side}_Foot`), foot, new THREE.Vector3(1, 0, 0));
      setWorld(bone(`${side}_Foot`), soles[i]);
    });
    ['L', 'R'].forEach((side) => {
      const outward = side === 'L' ? -1 : 1; // along Z
      const shoulder = at(`${side}_Upperarm`);
      const chambered = new THREE.Vector3(0.3, -0.62, -0.2 * outward).multiplyScalar(arm);
      const extended = new THREE.Vector3(0.74, -0.52, -0.16 * outward).multiplyScalar(arm);
      const pole = new THREE.Vector3(-0.6, -1, 0.6 * outward).lerp(new THREE.Vector3(0, -1, 0.5 * outward), drive);
      reach(bone(`${side}_Upperarm`), bone(`${side}_Forearm`), bone(`${side}_Hand`), shoulder.add(chambered.lerp(extended, drive)), pole);
      // Palm forward, fingers up and a little in.
      const fingers = new THREE.Vector3(0.15, 1, -0.3 * outward).normalize();
      const palm = new THREE.Vector3(1, 0, 0).addScaledVector(fingers, -fingers.x).normalize();
      setWorld(bone(`${side}_Hand`), frameTurn(...palms[side], fingers, palm));
    });
    for (const [b, [position, quaternion]] of base) b.position.lerp(position, back), b.quaternion.slerp(quaternion, back);
  };

  const times = Array.from({ length: 24 }, (_, i) => i / 30);
  const tracks = take.tracks.map((track) => [track, []]);
  for (const t of times) {
    pose(t);
    for (const [track, values] of tracks) {
      const [name, property] = track.name.split('.');
      values.push(...bone(name)[property].toArray());
    }
  }
  return new THREE.AnimationClip('push', -1, tracks.map(([track, values]) => new track.constructor(track.name, times, values)));
}

const io = new NodeIO();
for (const [character, clips] of Object.entries(CHARACTERS)) {
  const doc = await io.read(fileIn(join(ARTIFACTS, 'tripo', `${character}-rig`, 'rig'), '.glb'));
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const nodes = new Map(root.listNodes().map((n) => [n.getName(), n]));

  for (const [name, source] of Object.entries(clips)) {
    const fbx = typeof source === 'string' && readFbx(fileIn(join(ARTIFACTS, source), '.fbx'));
    const clip = !fbx ? source(nodes) : fbx.getObjectByName('mixamorigHips') ? retarget(fbx, nodes) : takeOf(fbx);
    if (TRIM[source]) {
      for (const track of clip.tracks) track.trim(0, TRIM[source]);
      clip.resetDuration();
    }
    const animation = doc.createAnimation(name);
    if (IN_PLACE.has(name)) animation.setExtras({ groundSpeed: inPlace(clip) });
    else if (!STANDING.has(name)) animation.setExtras({ travel: rootMotion(clip, nodes) });
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
    console.log(`${character}/${name} <- ${fbx ? source : 'keyed'}: ${animation.listChannels().length} channels, ${clip.duration.toFixed(2)}s`);
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
