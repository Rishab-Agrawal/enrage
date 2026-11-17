import * as THREE from 'three';

type Intent = 'strike' | 'dodge' | 'rematch' | 'speak' | 'pause' | 'map';

/** Phones and tablets, played on the on-screen pad instead of a keyboard and mouse. */
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
/** How far the stick must be pushed, as a share of its reach, up or down to walk, and sideways to start turning. */
const DEAD = 0.3;

/**
 * Keyboard + mouse, or touch, as game intents. Presses are latched until consumed so none are lost between frames.
 * A click captures the mouse (pointer lock) for looking; Esc releases it, natively. Losing it, or focus, asks for a pause.
 * On touch, a tap on the game captures it instead, a drag there looks, the pad's buttons hold keys, and the stick walks
 * her forward or back and turns her: a thumb can steer her without a second finger dragging.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<Intent>();
  private readonly listeners = new AbortController();
  private look = 0;
  private tilt = 0;
  /** Touch's stand-in for the pointer lock. */
  private engaged = false;
  /** Fingers on the pad's buttons, by pointer id, and the code each holds. */
  private readonly fingers = new Map<number, string>();
  /** The fingers on the stick and looking, and where the looking one last was. */
  private steering = -1;
  private looking = -1;
  private readonly last = new THREE.Vector2();
  /** The stick's push up or down, -1, 0 or 1 like the keys, and sideways, -1..1, rightward positive. */
  private walk = 0;
  private turn = 0;
  /** While set, moves, strikes, dodges and mouse travel are dropped, not saved for later; the mic and Esc still work. */
  still = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!event.repeat) this.press(event.code);
  };
  private readonly onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
  // Focus moving to another window or into a widget takes the keyups with it (lil-gui's swallow them): let held keys go.
  private readonly letGo = () => this.keys.clear();
  private readonly onBlur = () => {
    this.letGo();
    this.pause();
  };
  private readonly onLockChange = () => {
    if (!this.captured) this.pressed.add('pause');
  };
  private readonly onPointerDown = (event: PointerEvent) => {
    // The click that captures the mouse is not a strike. A refused lock (e.g. just after Esc) waits for the next click.
    if (!this.captured) return void this.capture();
    if (event.button === 0 && !this.still) this.pressed.add('strike');
  };
  private readonly onMouseMove = (event: MouseEvent) => {
    if (!this.captured || this.still) return;
    this.look += event.movementX;
    this.tilt += event.movementY;
  };
  private readonly onTouchDown = (event: PointerEvent) => {
    const target = event.target as Element;
    const button = target.closest<HTMLElement>('[data-code]');
    if (button) {
      this.fingers.set(event.pointerId, button.dataset.code!);
      this.press(button.dataset.code!);
    } else if (target.closest('#stick')) {
      this.steering = event.pointerId;
      this.steer(event);
    } else if (target === this.surface && this.captured && this.looking < 0) {
      this.looking = event.pointerId;
      this.last.set(event.clientX, event.clientY);
    }
  };
  private readonly onTouchMove = (event: PointerEvent) => {
    if (event.pointerId === this.steering) this.steer(event);
    if (event.pointerId !== this.looking) return;
    if (!this.still) {
      this.look += event.clientX - this.last.x;
      this.tilt += event.clientY - this.last.y;
    }
    this.last.set(event.clientX, event.clientY);
  };
  private readonly onTouchUp = (event: PointerEvent) => {
    const code = this.fingers.get(event.pointerId);
    if (code) this.keys.delete(code);
    this.fingers.delete(event.pointerId);
    if (event.pointerId === this.steering) {
      this.steering = -1;
      this.walk = this.turn = 0;
      this.knob.style.translate = '';
    }
    // The browser's bars take a big share of a phone held sideways: any tap goes fullscreen, as only a lifting touch may.
    // The mic's permission prompt can drop it, so each tap tries again. iPhones can't go fullscreen.
    if (!document.fullscreenElement && event.type === 'pointerup') void document.documentElement.requestFullscreen?.().catch(() => {});
    if (event.pointerId === this.looking) this.looking = -1;
    else if (event.target === this.surface && !this.captured && event.type === 'pointerup') void this.capture();
  };
  private readonly knob = document.querySelector<HTMLElement>('#stick i')!;

  /** `beforeCapture` runs on each capturing click, before the mouse is captured: a prompt it raises shows the cursor to answer it. */
  constructor(
    private readonly surface: HTMLElement,
    private readonly beforeCapture: () => Promise<unknown>,
  ) {
    const options = { signal: this.listeners.signal };
    window.addEventListener('keydown', this.onKeyDown, options);
    window.addEventListener('keyup', this.onKeyUp, options);
    window.addEventListener('blur', this.onBlur, options);
    window.addEventListener('focusin', this.letGo, options);
    if (TOUCH) {
      window.addEventListener('pointerdown', this.onTouchDown, options);
      window.addEventListener('pointermove', this.onTouchMove, options);
      window.addEventListener('pointerup', this.onTouchUp, options);
      window.addEventListener('pointercancel', this.onTouchUp, options);
      // A long press would open a menu, and the game is played sideways: turned upright, it pauses.
      window.addEventListener('contextmenu', (event) => event.preventDefault(), options);
      matchMedia('(orientation: portrait)').addEventListener('change', (event) => event.matches && this.pause(), options);
    } else {
      document.addEventListener('pointerlockchange', this.onLockChange, options);
      surface.addEventListener('pointerdown', this.onPointerDown, options);
      surface.addEventListener('contextmenu', (event) => event.preventDefault(), options);
      surface.addEventListener('mousemove', this.onMouseMove, options);
    }
  }

  /** Captures the mouse, or on touch the screen: only from a click, tap or key press, as browsers require. */
  async capture(): Promise<void> {
    await this.beforeCapture().catch(() => {});
    if (TOUCH) return void (this.engaged = true);
    // Raw movement: Chrome's default lock recentres the cursor, and fast travel then spikes or stalls at the window's
    // edge. Where raw input is unsupported, the plain lock. Firefox returns no promise.
    try {
      await this.surface.requestPointerLock({ unadjustedMovement: true });
    } catch (error) {
      if ((error as DOMException).name === 'NotSupportedError') await this.surface.requestPointerLock().catch(() => {});
    }
  }

  /** Lets go of the mouse, or on touch the screen. */
  release(): void {
    if (TOUCH) this.engaged = false;
    else document.exitPointerLock();
  }

  /** WASD/arrows, or the stick, as x (right) and y (forward), each -1, 0 or 1: the stick only walks forward or back. */
  movement(target: THREE.Vector2): THREE.Vector2 {
    if (this.still) return target.set(0, 0);
    const held = (a: string, b: string) => (this.keys.has(a) || this.keys.has(b) ? 1 : 0);
    return target.set(held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'), held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown') + this.walk);
  }

  /** Horizontal mouse travel since the last call, px, rightward positive. */
  consumeLook(): number {
    const look = this.look;
    this.look = 0;
    return look;
  }

  /** Vertical mouse travel since the last call, px, downward positive. */
  consumeTilt(): number {
    const tilt = this.tilt;
    this.tilt = 0;
    return tilt;
  }

  /** How hard the stick turns her, -1..1, rightward positive. */
  get turning(): number {
    return this.still ? 0 : this.turn;
  }

  get captured(): boolean {
    return TOUCH ? this.engaged : document.pointerLockElement === this.surface;
  }

  get speaking(): boolean {
    return this.keys.has('Space');
  }

  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  consume(intent: Intent): boolean {
    return this.pressed.delete(intent);
  }

  /** Forget latched presses and mouse travel, e.g. made on the result screen. */
  clear(): void {
    this.pressed.clear();
    this.look = this.tilt = 0;
  }

  dispose(): void {
    this.listeners.abort();
  }

  private press(code: string): void {
    // Shift sprints forward; with no movement key held, it dashes where the body faces.
    if (code.startsWith('Shift') && !this.still && this.movement(new THREE.Vector2()).lengthSq() === 0) this.pressed.add('dodge');
    this.keys.add(code);
    if (code === 'KeyR') this.pressed.add('rematch');
    if (code === 'Space') this.pressed.add('speak');
    if (code === 'Escape') this.pause();
    if (code === 'KeyM') this.pressed.add('map');
    if (code === 'Strike' && !this.still) this.pressed.add('strike');
  }

  private pause(): void {
    this.release();
    this.pressed.add('pause');
  }

  /** Pushes the stick, and its knob, toward the finger. */
  private steer({ clientX, clientY }: PointerEvent): void {
    const box = this.knob.parentElement!.getBoundingClientRect();
    const reach = box.width / 2;
    const push = new THREE.Vector2(clientX - box.left - reach, clientY - box.top - reach).clampLength(0, reach);
    this.knob.style.translate = `${push.x}px ${push.y}px`;
    push.divideScalar(reach);
    this.walk = Math.abs(push.y) > DEAD ? -Math.sign(push.y) : 0;
    this.turn = Math.sign(push.x) * Math.max(0, (Math.abs(push.x) - DEAD) / (1 - DEAD));
  }
}
