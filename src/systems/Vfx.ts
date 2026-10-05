import * as THREE from 'three';
import type { Mood } from '../game/events';

const EMBERS = 60;
const EMBER_HEIGHT = 2.6;
const hash = (n: number) => {
  const x = Math.sin(n * 91.345) * 47453.5453;
  return x - Math.floor(x);
};

type Burst = { sprite: THREE.Sprite; age: number; life: number; size: number; rise: number };

function radialTexture(stops: [number, string][], spikes = 0): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  if (spikes) {
    // Anime impact star: long thin rays around a bright core.
    ctx.translate(64, 64);
    for (let i = 0; i < spikes; i += 1) {
      ctx.rotate((Math.PI * 2) / spikes);
      const len = i % 2 ? 40 : 62;
      ctx.beginPath();
      ctx.moveTo(-5, 0);
      ctx.lineTo(0, -len);
      ctx.lineTo(5, 0);
      ctx.fill();
    }
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Event-driven effects (impact stars, dust, his roar's shockwave) plus the NPC's rage embers. */
export class Vfx {
  readonly group = new THREE.Group();
  private readonly bursts: Burst[] = [];
  private readonly impact = radialTexture([[0, '#ffffff'], [0.35, '#fff2b0'], [1, 'rgba(255,170,60,0)']], 12);
  private readonly dust = radialTexture([[0, 'rgba(226,205,170,0.9)'], [1, 'rgba(226,205,170,0)']]);
  private readonly shock: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly embers: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private rage = 0;
  private shockAge = 1;

  constructor() {
    this.shock = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1, 64),
      new THREE.MeshBasicMaterial({ color: '#ffb070', transparent: true, depthWrite: false, opacity: 0 }),
    );
    this.shock.rotation.x = -Math.PI / 2;

    const positions = new Float32Array(EMBERS * 3);
    for (let i = 0; i < EMBERS; i += 1) positions[i * 3 + 1] = hash(i) * EMBER_HEIGHT;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.embers = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: '#ff7a2a',
        map: this.dust,
        size: 0.12,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.group.add(this.shock, this.embers);
  }

  hit(at: THREE.Vector3, heavy: boolean): void {
    this.spawn(this.impact, at, heavy ? 1.6 : 1.1, 0.16, 0, THREE.AdditiveBlending);
    this.puff(at.clone().setY(0.2), heavy ? 3 : 1);
  }

  puff(at: THREE.Vector3, count = 3): void {
    for (let i = 0; i < count; i += 1) {
      const p = at.clone().add(new THREE.Vector3(Math.sin(i * 2.1) * 0.35, 0, Math.cos(i * 2.1) * 0.35));
      this.spawn(this.dust, p, 0.9 + (i % 3) * 0.3, 0.7, 0.6, THREE.NormalBlending);
    }
  }

  roar(): void {
    this.shockAge = 0;
  }

  update(delta: number, npc: THREE.Vector3, mood: Mood): void {
    this.rage = THREE.MathUtils.damp(this.rage, mood === 'enraged' ? 1 : 0, 4, delta);

    this.shockAge += delta;
    const s = Math.min(this.shockAge / 0.6, 1);
    this.shock.position.set(npc.x, 0.06, npc.z);
    this.shock.scale.setScalar(1 + s * 9);
    this.shock.material.opacity = (1 - s) * 0.8;

    this.embers.position.set(npc.x, 0, npc.z);
    this.embers.material.opacity = this.rage;
    const positions = this.embers.geometry.getAttribute('position') as THREE.BufferAttribute;
    // Each ember rises on its own column and drifts outward as it climbs.
    for (let i = 0; i < EMBERS; i += 1) {
      const y = (positions.getY(i) + delta * (0.6 + hash(i + 7) * 0.9)) % EMBER_HEIGHT;
      const angle = hash(i + 3) * Math.PI * 2 + y * 0.6;
      const r = 0.25 + hash(i + 11) * 0.45 + y * 0.15;
      positions.setXYZ(i, Math.cos(angle) * r, y, Math.sin(angle) * r);
    }
    positions.needsUpdate = true;

    for (let i = this.bursts.length - 1; i >= 0; i -= 1) {
      const b = this.bursts[i];
      b.age += delta;
      const t = b.age / b.life;
      if (t >= 1) {
        this.group.remove(b.sprite);
        b.sprite.material.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      b.sprite.scale.setScalar(b.size * (0.4 + 0.6 * Math.sqrt(t)));
      b.sprite.position.y += b.rise * delta;
      b.sprite.material.opacity = 1 - t * t;
    }
  }

  private spawn(map: THREE.Texture, at: THREE.Vector3, size: number, life: number, rise: number, blending: THREE.Blending): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending }));
    sprite.position.copy(at);
    sprite.material.rotation = this.bursts.length * 1.3;
    this.bursts.push({ sprite, age: 0, life, size, rise });
    this.group.add(sprite);
  }
}
