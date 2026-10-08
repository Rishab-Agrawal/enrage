import * as THREE from 'three';

/**
 * Keyboard + mouse as game intents. Presses are latched until consumed so none are lost between frames.
 * A click captures the mouse (pointer lock) for looking; Esc releases it, natively. Losing it, or focus, asks for a pause.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<'strike' | 'dodge' | 'rematch' | 'speak' | 'pause'>();
  private look = 0;
  /** `performance.now()` before which mouse travel is ignored. */
  private lookFrom = 0;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat) return;
    // Shift sprints forward; with no movement key held, it dashes where the body faces.
    if (event.key === 'Shift' && this.movement(new THREE.Vector2()).lengthSq() === 0) this.pressed.add('dodge');
    this.keys.add(event.code);
    if (event.code === 'KeyR') this.pressed.add('rematch');
    if (event.code === 'Space') this.pressed.add('speak');
    if (event.code === 'Escape') this.pressed.add('pause');
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  // Focus moving to another window or into a widget takes the keyups with it (lil-gui's swallow them): let held keys go.
  private readonly release = () => this.keys.clear();
  private readonly onBlur = () => {
    this.release();
    this.pressed.add('pause');
  };
  private readonly onLockChange = () => {
    if (!this.captured) this.pressed.add('pause');
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    // The click that captures the mouse is not a strike. A refused lock (e.g. just after Esc) waits for the next click.
    // Raw movement: Chrome's default lock recentres the cursor, and fast travel then spikes or stalls at the window's
    // edge. Where raw input is unsupported, the plain lock. Firefox returns no promise.
    if (!this.captured) return void this.lock();
    if (event.button === 0) this.pressed.add('strike');
  };
  private readonly onContextMenu = (event: MouseEvent) => event.preventDefault();
  private readonly onMouseMove = (event: MouseEvent) => {
    if (this.captured && event.timeStamp >= this.lookFrom) this.look += event.movementX;
  };

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focusin', this.release);
    document.addEventListener('pointerlockchange', this.onLockChange);
    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('contextmenu', this.onContextMenu);
    surface.addEventListener('mousemove', this.onMouseMove);
  }

  private async lock(): Promise<void> {
    try {
      await this.surface.requestPointerLock({ unadjustedMovement: true });
    } catch (error) {
      if ((error as DOMException).name === 'NotSupportedError') await this.surface.requestPointerLock().catch(() => {});
    }
  }

  /** WASD/arrows as x (right) and y (forward), each -1, 0 or 1. */
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

  get captured(): boolean {
    return document.pointerLockElement === this.surface;
  }

  get speaking(): boolean {
    return this.keys.has('Space');
  }

  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consume(intent: 'strike' | 'dodge' | 'rematch' | 'speak' | 'pause'): boolean {
    return this.pressed.delete(intent);
  }

  /** Ignore mouse travel for a second: the hand that just clicked or pressed R is still settling on the mouse. */
  holdLook(): void {
    this.lookFrom = performance.now() + 1000;
  }

  /** Forget latched presses and mouse travel, e.g. made on the result screen. */
  clear(): void {
    this.pressed.clear();
    this.look = 0;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focusin', this.release);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    this.surface.removeEventListener('contextmenu', this.onContextMenu);
    this.surface.removeEventListener('mousemove', this.onMouseMove);
  }
}
