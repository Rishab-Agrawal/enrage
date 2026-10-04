import * as THREE from 'three';

/** Keyboard + mouse as game intents. Presses are latched until consumed so none are lost between frames. */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<'strike' | 'dodge' | 'rematch' | 'mute'>();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    this.keys.add(event.code);
    if (event.code === 'Space') this.pressed.add('dodge');
    if (event.code === 'KeyR') this.pressed.add('rematch');
    if (event.code === 'KeyM') this.pressed.add('mute');
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  private readonly onBlur = () => this.keys.clear();
  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button === 0) this.pressed.add('strike');
    if (event.button === 2) this.pressed.add('dodge');
  };
  private readonly onContextMenu = (event: MouseEvent) => event.preventDefault();

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('contextmenu', this.onContextMenu);
  }

  /** WASD/arrows as x (right) and y (forward), length ≤ 1. */
  movement(target: THREE.Vector2): THREE.Vector2 {
    const held = (a: string, b: string) => (this.keys.has(a) || this.keys.has(b) ? 1 : 0);
    target.set(held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'), held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'));
    return target.lengthSq() > 1 ? target.normalize() : target;
  }

  consume(intent: 'strike' | 'dodge' | 'rematch' | 'mute'): boolean {
    return this.pressed.delete(intent);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('contextmenu', this.onContextMenu);
  }
}
