import * as THREE from 'three';

/**
 * Keyboard + mouse as game intents. Presses are latched until consumed so none are lost between frames.
 * A click captures the mouse (pointer lock) for looking; Esc releases it, natively.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<'strike' | 'dodge' | 'rematch' | 'mute'>();
  private look = 0;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    // Shift sprints forward; with no movement key held, it dashes where the body faces.
    if (event.key === 'Shift' && this.movement(new THREE.Vector2()).lengthSq() === 0) this.pressed.add('dodge');
    this.keys.add(event.code);
    if (event.code === 'KeyR') this.pressed.add('rematch');
    if (event.code === 'KeyM') this.pressed.add('mute');
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  private readonly onBlur = () => this.keys.clear();
  private readonly onPointerDown = (event: PointerEvent) => {
    // The click that captures the mouse is not a strike. A refused lock (e.g. just after Esc) waits for the next click.
    // Firefox returns no promise.
    if (document.pointerLockElement !== this.surface) return void this.surface.requestPointerLock()?.catch(() => {});
    if (event.button === 0) this.pressed.add('strike');
    if (event.button === 2) this.pressed.add('dodge');
  };
  private readonly onContextMenu = (event: MouseEvent) => event.preventDefault();
  private readonly onMouseMove = (event: MouseEvent) => {
    if (document.pointerLockElement === this.surface) this.look += event.movementX;
  };

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('contextmenu', this.onContextMenu);
    surface.addEventListener('mousemove', this.onMouseMove);
  }

  /** WASD/arrows as x (turn right) and y (forward), each -1, 0 or 1. */
  movement(target: THREE.Vector2): THREE.Vector2 {
    const held = (a: string, b: string) => (this.keys.has(a) || this.keys.has(b) ? 1 : 0);
    return target.set(held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'), held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown'));
  }

  /** Horizontal mouse travel since the last call, px, rightward positive. */
  consumeLook(): number {
    const look = this.look;
    this.look = 0;
    return look;
  }

  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consume(intent: 'strike' | 'dodge' | 'rematch' | 'mute'): boolean {
    return this.pressed.delete(intent);
  }

  /** Forget latched presses, e.g. clicks made on the result screen. */
  clear(): void {
    this.pressed.clear();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('contextmenu', this.onContextMenu);
    this.surface.removeEventListener('mousemove', this.onMouseMove);
  }
}
