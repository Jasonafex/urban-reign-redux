/**
 * Touch input — the phone player's whole control scheme (AGENTS.md §3.3, "house LAN").
 *
 * The file is deliberately split in two, because the two halves live on opposite sides of the
 * architecture line in AGENTS.md §3.1:
 *
 *   - **`TouchInputState`** is pure arithmetic. Pointer tracking, the radial deadzone, the digital
 *     octant snap and the button hit-testing all happen with no DOM in sight, which is why
 *     `test/touch-lan.test.mjs` can drive a full two-thumb session in Node and assert exact numbers.
 *     It imports nothing from `sim/`, and nothing but the shared vocabulary from `input/`.
 *
 *   - **`TouchController`** is presentation. It owns a fixed-position overlay, the floating
 *     thumbstick and the action buttons, and forwards browser pointer events into the state. It
 *     touches `document` and `globalThis`, and it is safe to construct in Node, where `attach()`
 *     reports `false` instead of throwing.
 *
 * Geometry is stored in **normalised overlay coordinates** (0..1 of the overlay box), never in CSS
 * pixels: the same layout then works on a 360px phone, a tablet and a desktop window without a
 * single conversion constant, and a hit test is a distance comparison rather than a hit-test
 * against real DOM rects.
 */

import {
  applyRadialDeadzone,
  INPUT_ACTIONS,
  INPUT_DEADZONE,
  snapToOctant,
  type ControlState,
  type InputAction,
} from '../input/layout';

/** Radial deadzone of the virtual stick, as a fraction of its travel radius. */
export const TOUCH_DEADZONE = INPUT_DEADZONE;

/** How far the stick knob can travel, as a fraction of the overlay width/height. */
const STICK_RADIUS = 0.12;

export interface TouchButton {
  readonly action: InputAction;
  /** Centre in normalised overlay coordinates. */
  readonly x: number;
  readonly y: number;
  /** Hit radius in normalised units — also the drawn radius. */
  readonly radius: number;
  readonly label: string;
}

export interface TouchLayout {
  /** Where the stick rests when nothing is touching it. */
  readonly stickX: number;
  readonly stickY: number;
  /** Travel radius, as a fraction of the overlay size. */
  readonly stickRadius: number;
  /** Fraction of the travel radius that counts as "centred". */
  readonly deadzone: number;
  readonly buttons: readonly TouchButton[];
}

/**
 * Phone layout: thumbstick bottom-left, the face actions bottom-right, defence on the left of that
 * cluster (a phone is held in two hands, so guard has to be reachable by the left thumb while the
 * right thumb is fighting).
 *
 * Only one guard button exists, and it resolves high-or-low from the stick exactly as the gamepad
 * guard does — see `control()`.
 *
 * The circles are kept clear of each other, and clear of the stick's resting circle: two controls
 * whose hit areas touch are two controls where a thumb roll fires the wrong move. That is not a
 * comment about taste — `test/touch-lan.test.mjs` fails the build if any two of them overlap.
 */
export const PHONE_TOUCH_LAYOUT: TouchLayout = Object.freeze({
  stickX: 0.18,
  stickY: 0.7,
  stickRadius: STICK_RADIUS,
  deadzone: TOUCH_DEADZONE,
  buttons: Object.freeze<TouchButton[]>([
    { action: 'strike', x: 0.85, y: 0.78, radius: 0.085, label: 'STRIKE' },
    { action: 'grab', x: 0.7, y: 0.66, radius: 0.07, label: 'GRAB' },
    { action: 'special', x: 0.93, y: 0.6, radius: 0.07, label: 'SPA' },
    { action: 'dodgeHigh', x: 0.6, y: 0.88, radius: 0.06, label: 'DODGE-HI' },
    { action: 'dodgeLow', x: 0.9, y: 0.93, radius: 0.05, label: 'DODGE-LO' },
    { action: 'guardHigh', x: 0.5, y: 0.7, radius: 0.06, label: 'GUARD' },
    { action: 'targetSwitch', x: 0.42, y: 0.88, radius: 0.055, label: 'LOCK' },
  ]),
});

/** One tracked finger. */
export interface TouchPoint {
  readonly id: number;
  readonly kind: 'stick' | 'button';
  /** Current normalised position. */
  readonly x: number;
  readonly y: number;
  /** For button pointers: the button this finger owns for its whole life. */
  readonly action: InputAction | null;
}

export interface TouchInputStateOptions {
  readonly layout?: TouchLayout;
}

/**
 * Pure touch state machine: multi-touch pointers in, `ControlState` out.
 *
 * Multi-touch discipline, which is where a virtual pad usually goes wrong: a finger that lands on
 * STRIKE keeps STRIKE for its whole life even if it slides across SPA, and a second finger landing
 * on the stick does not steal STRIKE. Actions are therefore owned by *pointer*, not by position —
 * without that, every thumb roll becomes a mash of three different attacks.
 */
export class TouchInputState {
  readonly layout: TouchLayout;

  private readonly pointers = new Map<number, TouchPoint>();
  private readonly heldActions = new Set<InputAction>();
  private originX: number;
  private originY: number;
  private travelX = 0;
  private travelY = 0;

  constructor(options: TouchInputStateOptions = {}) {
    this.layout = options.layout ?? PHONE_TOUCH_LAYOUT;
    this.originX = this.layout.stickX;
    this.originY = this.layout.stickY;
  }

  /** Pointer ids currently tracked. */
  get pointerCount(): number {
    return this.pointers.size;
  }

  /** Pointer id that owns the stick, or null. */
  get stickPointerId(): number | null {
    for (const [id, point] of this.pointers) {
      if (point.kind === 'stick') {
        return id;
      }
    }
    return null;
  }

  /** Every tracked pointer, in insertion order. */
  get points(): readonly TouchPoint[] {
    return [...this.pointers.values()];
  }

  /** Where the stick currently reads, in normalised coordinates (0 when centred). */
  get knob(): { x: number; y: number } {
    return { x: this.travelX, y: this.travelY };
  }

  /** Where the stick is resting. It re-centres under whichever finger took it. */
  get stickOrigin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  /** True while any finger or button is down. The join signal for a phone. */
  get active(): boolean {
    return this.pointers.size > 0 || this.heldActions.size > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Pointer tracking
  // -------------------------------------------------------------------------------------------

  /**
   * A finger went down.
   *
   * Resolution order matters: a finger that lands on a button *is* that button, even when it also
   * happens to sit inside the stick's resting circle. Otherwise every dodge press on a phone would
   * also start walking the fighter.
   *
   * The stick floats — the first free finger re-centres it wherever it landed, and the deadzone
   * inside that circle is the only gate. A fixed stick would demand an exact hit on a small circle,
   * which is the most reliable way to make a virtual pad feel broken.
   */
  beginPointer(id: number, x: number, y: number): void {
    if (this.pointers.has(id)) {
      // A duplicate id can only be a browser bug; re-arming from it would teleport the knob.
      return;
    }
    const button = this.buttonAt(x, y);
    if (button !== null) {
      this.pointers.set(id, { id, kind: 'button', x, y, action: button.action });
      this.heldActions.add(button.action);
      return;
    }
    if (this.stickPointerId !== null) {
      // A second finger with no button under it is ignored rather than fighting for the stick: the
      // knob jumping under a fighter that is already walking is never what was meant.
      return;
    }
    this.pointers.set(id, { id, kind: 'stick', x, y, action: null });
    this.originX = clamp01(x);
    this.originY = clamp01(y);
    this.travelX = 0;
    this.travelY = 0;
  }

  /** A finger moved. Untracked ids are ignored (a stray `pointermove` before `pointerdown`). */
  movePointer(id: number, x: number, y: number): void {
    const point = this.pointers.get(id);
    if (point === undefined) {
      return;
    }
    this.pointers.set(id, { ...point, x, y });
  }

  /** A finger lifted. Releasing the stick re-centres it; the resting place is kept. */
  endPointer(id: number): void {
    const point = this.pointers.get(id);
    if (point === undefined) {
      return;
    }
    this.pointers.delete(id);
    if (point.action !== null) {
      this.heldActions.delete(point.action);
    }
    if (point.kind === 'stick') {
      this.travelX = 0;
      this.travelY = 0;
    }
  }

  /** Drop every finger. Called on blur, for the same reason as the keyboard's `releaseAll()`. */
  releaseAll(): void {
    this.pointers.clear();
    this.heldActions.clear();
    this.travelX = 0;
    this.travelY = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------------------------

  /** Sample once per tick. Identical to `control()`; kept as the named per-tick entry point. */
  sample(): ControlState {
    return this.control();
  }

  /**
   * The current `ControlState`.
   *
   * The stick is digital: the travel vector is clamped to the gate circle, deadzoned radially, then
   * snapped to the eight compass headings. A phone has no analog range to preserve, and a fighter
   * walking at 30% speed because a thumb drifted is a fighter the player cannot aim.
   */
  control(): ControlState {
    const stickId = this.stickPointerId;
    if (stickId !== null) {
      const point = this.pointers.get(stickId);
      if (point !== undefined) {
        this.travelX = point.x - this.originX;
        this.travelY = point.y - this.originY;
      }
    }

    const radius = this.layout.stickRadius;
    const magnitude = Math.hypot(this.travelX, this.travelY);
    let moveX = 0;
    let moveZ = 0;
    if (magnitude > 0) {
      const clamped = Math.min(magnitude, radius);
      const deadzoned = applyRadialDeadzone(
        (this.travelX / magnitude) * (clamped / radius),
        (this.travelY / magnitude) * (clamped / radius),
        this.layout.deadzone,
      );
      const snapped = snapToOctant(deadzoned.x, deadzoned.z);
      moveX = snapped.x;
      moveZ = snapped.z;
    }

    const held = {} as Record<InputAction, boolean>;
    for (const action of INPUT_ACTIONS) {
      held[action] = this.heldActions.has(action);
    }
    // Same rule as the gamepad guard: the stick decides which guard, so down+guard blocks sweeps
    // without costing a second thumb.
    held.guardLow = held.guardHigh === true && moveZ > 0;
    return { moveX, moveZ, held: Object.freeze(held) };
  }

  /** Which button, if any, sits under this normalised point. Nearest wins on an overlap. */
  buttonAt(x: number, y: number): TouchButton | null {
    let best: TouchButton | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const button of this.layout.buttons) {
      const distance = Math.hypot(button.x - x, button.y - y);
      if (distance <= button.radius && distance < bestDistance) {
        best = button;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** True when this host is a touch-first device (coarse pointer plus touch events). */
  static isTouchDevice(): boolean {
    const host = globalThis as {
      navigator?: { maxTouchPoints?: number };
      matchMedia?: (query: string) => { matches: boolean };
    };
    const touchPoints = host.navigator?.maxTouchPoints ?? 0;
    const coarse = host.matchMedia?.('(pointer: coarse)').matches ?? false;
    return touchPoints > 0 && coarse;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

// -------------------------------------------------------------------------------------------
// Presentation: the on-screen overlay
// -------------------------------------------------------------------------------------------

export interface TouchControllerOptions {
  /** Reuse an existing state (the join manager owns one in practice). */
  readonly state?: TouchInputState;
  /** Overlay parent. Defaults to `document.body`. */
  readonly parent?: HTMLElement;
  /** Reuse an existing document (tests, alternate hosts). */
  readonly document?: Document;
}

/**
 * The on-screen controls: a floating thumbstick and the action buttons.
 *
 * Presentation only — it reads the pure `TouchInputState` and writes DOM. It never reads a
 * `Fighter`, and constructing it in Node is safe: `attach()` reports `false` instead of throwing, so
 * importing this module into a headless bundle cannot take the process down.
 */
export class TouchController {
  readonly state: TouchInputState;

  private readonly doc: Document | null;
  private readonly parent: HTMLElement | null;
  private root: HTMLDivElement | null = null;
  private readonly nodes = new Map<InputAction, HTMLDivElement>();
  private readonly cleanups: (() => void)[] = [];
  private attached = false;

  constructor(options: TouchControllerOptions = {}) {
    this.state = options.state ?? new TouchInputState();
    this.doc =
      options.document ?? (typeof document === 'undefined' ? null : document);
    this.parent = options.parent ?? this.doc?.body ?? null;
  }

  /** True while the overlay is live in the DOM. */
  get mounted(): boolean {
    return this.attached;
  }

  /**
   * Build the overlay and start listening. Returns false in a headless host, where there is no
   * document to build it in — a legitimate outcome, not an error.
   */
  attach(): boolean {
    if (this.attached) {
      return true;
    }
    const doc = this.doc;
    const parent = this.parent;
    if (doc === null || parent === null) {
      return false;
    }

    const root = doc.createElement('div');
    root.className = 'ur-touch';
    root.setAttribute('data-ur-touch', 'overlay');
    root.style.cssText =
      'position:fixed;inset:0;z-index:20;touch-action:none;pointer-events:auto;' +
      '-webkit-user-select:none;user-select:none;opacity:0;transition:opacity 160ms ease';

    const stickBase = doc.createElement('div');
    stickBase.className = 'ur-touch-stick';
    stickBase.style.cssText =
      'position:absolute;left:0;top:0;width:26vmin;height:26vmin;margin:-13vmin 0 0 -13vmin;' +
      'border:2px solid rgba(232,230,225,.28);border-radius:50%;pointer-events:none';
    const stickKnob = doc.createElement('div');
    stickKnob.className = 'ur-touch-knob';
    stickKnob.style.cssText =
      'position:absolute;left:0;top:0;width:11vmin;height:11vmin;margin:-5.5vmin 0 0 -5.5vmin;' +
      'border-radius:50%;background:rgba(232,230,225,.55);pointer-events:none';
    stickBase.appendChild(stickKnob);
    root.appendChild(stickBase);

    for (const button of this.state.layout.buttons) {
      const node = doc.createElement('div');
      node.className = `ur-touch-button ur-touch-${button.action}`;
      node.textContent = button.label;
      // Positioned by left/top in viewport units rather than vmin margins, because the hit radius
      // and the drawn circle then stay the same size whatever the aspect ratio is.
      const size = `${(button.radius * 2 * 100).toFixed(2)}vmin`;
      node.style.cssText =
        `position:absolute;left:${(button.x * 100).toFixed(2)}vw;top:${(button.y * 100).toFixed(2)}vh;` +
        `width:${size};height:${size};margin:${(-button.radius * 100).toFixed(2)}vmin 0 0 ${(-button.radius * 100).toFixed(2)}vmin;` +
        'display:grid;place-content:center;border-radius:50%;pointer-events:none;' +
        'font:600 2.6vmin/1 ui-monospace,monospace;letter-spacing:.04em;color:#0d0f13;' +
        'background:rgba(232,230,225,.42)';
      this.nodes.set(button.action, node);
      root.appendChild(node);
    }

    const onPointerDown = (event: PointerEvent): void => {
      const point = this.normalise(event);
      if (point === null) {
        return;
      }
      this.state.beginPointer(event.pointerId, point.x, point.y);
      this.paint();
      // The overlay already sets `touch-action:none`, but a stray page scroll under a thumb is
      // still a bug worth closing at the event.
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent): void => {
      const point = this.normalise(event);
      if (point !== null) {
        this.state.movePointer(event.pointerId, point.x, point.y);
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      this.state.endPointer(event.pointerId);
      this.paint();
    };
    const onBlur = (): void => {
      this.state.releaseAll();
      this.paint();
    };

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    parent.appendChild(root);
    globalThis.addEventListener?.('blur', onBlur);

    // Every listener registered here is torn down by `detach()`. Without this list the overlay
    // would leak its four pointer handlers on every re-mount.
    this.cleanups.push(
      () => root.removeEventListener('pointerdown', onPointerDown),
      () => root.removeEventListener('pointermove', onPointerMove),
      () => root.removeEventListener('pointerup', onPointerUp),
      () => root.removeEventListener('pointercancel', onPointerUp),
      () => globalThis.removeEventListener?.('blur', onBlur),
    );

    this.root = root;
    this.attached = true;
    // Draw the stick and buttons once up front; the stick is positioned in `paint()`, so without
    // this the controls would not appear where the layout says they are until the first touch.
    this.paint();

    // Start hidden and reveal on the first real touch. The overlay is full-screen, so leaving it
    // interactive on a desktop would put an invisible sheet over the whole page — swallowing
    // clicks that belong to everything else. A phone or tablet fails this test on the first
    // `pointerType: 'touch'` and never sees a controller-free screen again.
    this.setVisible(false);
    const onFirstTouch = (event: Event): void => {
      const pointerType = (event as PointerEvent).pointerType;
      if (pointerType === undefined || pointerType === 'mouse') {
        return;
      }
      this.setVisible(true);
      globalThis.removeEventListener?.('pointerdown', onFirstTouch);
    };
    globalThis.addEventListener?.('pointerdown', onFirstTouch);
    this.cleanups.push(() => globalThis.removeEventListener?.('pointerdown', onFirstTouch));
    return true;
  }

  /** Remove the overlay and every listener it installed. Safe to call when never attached. */
  detach(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.root?.remove();
    this.root = null;
    this.nodes.clear();
    this.attached = false;
  }

  /**
   * Show or hide the controls without tearing the listeners down.
   *
   * A hidden overlay also stops taking pointer events, so a desktop gets its clicks back. On a
   * phone the overlay is revealed by the first touch and stays visible for the rest of the match —
   * hiding it mid-fight would leave the player with no controls and no way to bring them back.
   */
  setVisible(visible: boolean): void {
    if (this.root === null) {
      return;
    }
    this.root.style.opacity = visible ? '1' : '0';
    this.root.style.pointerEvents = visible ? 'auto' : 'none';
    this.root.setAttribute('data-visible', visible ? 'true' : 'false');
  }

  /** Reposition the stick visuals and light up whichever buttons are held. */
  paint(): void {
    const root = this.root;
    if (root === null) {
      return;
    }
    const base = root.querySelector<HTMLDivElement>('.ur-touch-stick');
    const knob = root.querySelector<HTMLDivElement>('.ur-touch-knob');
    if (base !== null) {
      const origin = this.state.stickOrigin;
      base.style.left = `${(origin.x * 100).toFixed(2)}%`;
      base.style.top = `${(origin.y * 100).toFixed(2)}%`;
    }
    if (knob !== null) {
      const travel = this.state.knob;
      knob.style.transform = `translate(${(travel.x * 100).toFixed(2)}vw, ${(travel.y * 100).toFixed(2)}vh)`;
    }
    const control = this.state.control();
    for (const [action, node] of this.nodes) {
      const down = control.held[action] === true;
      node.style.background = down ? 'rgba(216,68,60,.92)' : 'rgba(232,230,225,.42)';
      node.style.transform = down ? 'scale(0.94)' : 'scale(1)';
    }
  }

  /** Convert a pointer event to normalised overlay coordinates. */
  private normalise(event: PointerEvent): { x: number; y: number } | null {
    const rect = this.root?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  }
}