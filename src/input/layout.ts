/**
 * Input vocabulary shared by every device layer.
 *
 * AGENTS.md §3.1 splits the engine into a DOM-free simulation core and a presentation layer.
 * Device code (gamepad, keyboard, touch) lives on the *input* side of that line: it may read the
 * Gamepad API and the DOM, but it may never touch `MatchRunner` state. Everything here is pure
 * arithmetic and plain data so that the headless test runner can drive it in Node with no browser
 * globals present.
 *
 * The abstraction is deliberately small. Every device — a stick, a WASD cluster, a thumb on glass —
 * reduces to the same `ControlState`: a movement vector plus a set of held actions. Mapping that
 * onto `FrameInput` (edge detection, buffering, attack token choice) happens once, in
 * `input/buffer.ts`, so a phone player and a pad player cannot drift apart in behaviour.
 */

/**
 * The eight things a player can ask for. Deliberately not move ids: the sim resolves these into
 * moves, and one device button must mean the same thing on every archetype (AGENTS.md §5's
 * Street-Fighter-style face buttons, not per-character quirks).
 *
 *   - `strike`      chain opener; resolves against the held direction (4-way branching)
 *   - `grab`       close-range throw; `grab_low` when holding down, `grab_high` otherwise
 *   - `special`    SPA 1, or SPA 2 (crowd clear) while guarding — the emergency-escape read
 *   - `guardHigh`  block mid/high strikes
 *   - `guardLow`   block sweeps
 *   - `dodgeHigh`  slip high/mid strikes (counter-throws on a frame-perfect contact)
 *   - `dodgeLow`   hop sweeps
 *   - `targetSwitch` target-lock cycle (see `input/join.ts` for how the lock is surfaced)
 */
export type InputAction =
  | 'strike'
  | 'grab'
  | 'special'
  | 'guardHigh'
  | 'guardLow'
  | 'dodgeHigh'
  | 'dodgeLow'
  | 'targetSwitch';

/** Canonical action order. Iteration order is stable so hash-free snapshots stay comparable. */
export const INPUT_ACTIONS: readonly InputAction[] = Object.freeze([
  'strike',
  'grab',
  'special',
  'guardHigh',
  'guardLow',
  'dodgeHigh',
  'dodgeLow',
  'targetSwitch',
]);

/**
 * What a device looks like after one tick of sampling: a movement intent and the actions
 * currently held down. This is the only thing device code hands to the input layer.
 *
 * `moveX`/`moveZ` are floats in -1..1 and are **not** snapped here. The sim snaps movement itself
 * (`directionFor` in `sim/fighter.ts` reads signs only), so passing an analog magnitude through is
 * safe for determinism: two peers that sampled the same stick position get the same heading, and a
 * different magnitude can never change a tick's outcome.
 */
export interface ControlState {
  readonly moveX: number;
  readonly moveZ: number;
  readonly held: Readonly<Record<InputAction, boolean>>;
}

/** Every action released, no movement. Frozen: it is the shared "nothing is happening" value. */
export const NEUTRAL_CONTROL: ControlState = Object.freeze({
  moveX: 0,
  moveZ: 0,
  held: Object.freeze(
    Object.fromEntries(INPUT_ACTIONS.map((action) => [action, false])) as Record<
      InputAction,
      boolean
    >,
  ),
});

/** Copy `base` with `overrides` applied. Used by device code and by the test rigs. */
export function controlWith(
  base: ControlState = NEUTRAL_CONTROL,
  overrides: Partial<Pick<ControlState, 'moveX' | 'moveZ'>> & {
    readonly held?: Partial<Readonly<Record<InputAction, boolean>>>;
  } = {},
): ControlState {
  return {
    moveX: overrides.moveX ?? base.moveX,
    moveZ: overrides.moveZ ?? base.moveZ,
    held: { ...base.held, ...(overrides.held ?? {}) },
  };
}

/** True when the action is held in this sample. Total function — an unknown action is not held. */
export function isHeld(control: ControlState, action: InputAction): boolean {
  return control.held[action] === true;
}

// -------------------------------------------------------------------------------------------
// Axis shaping
// -------------------------------------------------------------------------------------------

/**
 * Radial deadzone.
 *
 * The deadzone is applied to the *magnitude* of the stick vector, not per axis, because a per-axis
 * deadzone leaves the diagonals of the gate visibly usable while the cardinals are not: a stick at
 * (0.13, 0.13) reads as a strong diagonal on a pad whose gates are tuned for (0.13, 0). Scaling by
 * magnitude means "0.18 away from centre" means the same thing in every direction.
 *
 * Beyond the gate the remaining range is rescaled to a full 0..1 so the player does not lose the
 * outer 18% of every direction to the gate itself.
 */
export const INPUT_DEADZONE = 0.18;

export interface Vector2 {
  readonly x: number;
  readonly z: number;
}

export function applyRadialDeadzone(
  x: number,
  z: number,
  deadzone: number = INPUT_DEADZONE,
): Vector2 {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return { x: 0, z: 0 };
  }
  const gate = Math.min(Math.max(deadzone, 0), 0.99);
  const magnitude = Math.hypot(x, z);
  if (magnitude <= gate) {
    return { x: 0, z: 0 };
  }
  // A stick shoved past its own range reports magnitudes above 1; clamp before rescaling so the
  // result can never leave the unit circle, then divide by the *original* magnitude to keep the
  // direction. Dividing by the clamped value instead would scale a 45-degree push by 2.83.
  const clamped = Math.min(magnitude, 1);
  const rescaled = ((clamped - gate) / (1 - gate)) * clamped;
  return { x: (x / magnitude) * rescaled, z: (z / magnitude) * rescaled };
}

/**
 * Snap a vector to the eight compass headings, keeping its direction but discarding magnitude.
 *
 * Digital sources (D-pad, arrow keys, a thumb on glass) have no analog range to preserve, and a
 * phone player holding a 0.2-magnitude drift should not walk slower than one holding 0.9 — the
 * sim quantises movement to eight headings anyway, so magnitude here is pure dead weight.
 */
export function snapToOctant(x: number, z: number): Vector2 {
  const sx = x > 0 ? 1 : x < 0 ? -1 : 0;
  const sz = z > 0 ? 1 : z < 0 ? -1 : 0;
  return { x: sx, z: sz };
}

/** Clamp one axis to -1..1, mapping non-finite input to 0. */
export function clampAxis(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, value));
}

// -------------------------------------------------------------------------------------------
// Keyboard layouts
// -------------------------------------------------------------------------------------------

/**
 * A split-keyboard profile: four direction keys plus one `KeyboardEvent.code` per action.
 *
 * Codes rather than keys, deliberately. `event.code` is the physical key position, so a player on
 * AZERTY or a Dvorak layout still finds WASD where their hand expects it, and two players sharing
 * one keyboard are matched by position rather than by whichever layout the OS happened to report.
 */
export interface KeyboardLayout {
  readonly id: string;
  /** Player slot this layout is advertised for. Not binding: `JoinManager` allocates slots itself. */
  readonly slot: number;
  readonly label: string;
  readonly up: string;
  readonly down: string;
  readonly left: string;
  readonly right: string;
  readonly keys: Readonly<Record<InputAction, string>>;
}

/**
 * Player 1 — left hand on WASD, right hand on the JKL/UIO cluster.
 *
 * J/K/L keep the Phase 1 muscle memory (they were the three attack keys) but take their Phase 2
 * roles: chain opener, grab, SPA. Guard is Shift/C rather than the modifiers alone, because Shift
 * is where a player puts *every* modifier and a guard that fires during a sprint is unusable.
 */
export const P1_KEYBOARD: KeyboardLayout = Object.freeze({
  id: 'p1-wasd-jkl',
  slot: 0,
  label: 'P1 · WASD + JKL',
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  keys: Object.freeze({
    strike: 'KeyJ',
    grab: 'KeyK',
    special: 'KeyL',
    guardHigh: 'ShiftLeft',
    guardLow: 'KeyC',
    dodgeHigh: 'KeyU',
    dodgeLow: 'KeyI',
    targetSwitch: 'KeyO',
  }),
});

/**
 * Player 2 — left hand on the arrow cluster, right hand on the numpad's 3x3 grid.
 *
 * The numpad is the only block of keys far enough from WASD and the JKL cluster for two players to
 * share one keyboard without either one's guard press leaking into the other's stick. Every key
 * here is disjoint from `P1_KEYBOARD`, which `layoutKeyOverlap` asserts at module load.
 */
export const P2_KEYBOARD: KeyboardLayout = Object.freeze({
  id: 'p2-arrows-numpad',
  slot: 1,
  label: 'P2 · Arrows + Numpad',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  keys: Object.freeze({
    strike: 'Numpad1',
    grab: 'Numpad2',
    special: 'Numpad3',
    guardHigh: 'Numpad4',
    guardLow: 'Numpad6',
    dodgeHigh: 'Numpad7',
    dodgeLow: 'Numpad9',
    targetSwitch: 'Numpad8',
  }),
});

/** The two supported split-keyboard profiles, in join-priority order. */
export const KEYBOARD_LAYOUTS: readonly KeyboardLayout[] = Object.freeze([
  P1_KEYBOARD,
  P2_KEYBOARD,
]);

/** Every `KeyboardEvent.code` a layout listens for, including its four direction keys. */
export function layoutKeyCodes(layout: KeyboardLayout): ReadonlySet<string> {
  return new Set<string>([
    layout.up,
    layout.down,
    layout.left,
    layout.right,
    ...INPUT_ACTIONS.map((action) => layout.keys[action]),
  ]);
}

/** True when `code` belongs to `layout`. */
export function layoutHasKey(layout: KeyboardLayout, code: string): boolean {
  return (
    code === layout.up ||
    code === layout.down ||
    code === layout.left ||
    code === layout.right ||
    INPUT_ACTIONS.some((action) => layout.keys[action] === code)
  );
}

/** Layout lookup by id. */
export function keyboardLayoutById(id: string): KeyboardLayout | undefined {
  return KEYBOARD_LAYOUTS.find((layout) => layout.id === id);
}

/**
 * Keys two layouts both listen for — the pairs that make split-keyboard play impossible.
 * Exported (rather than asserted once) because the invariant is what the multi-input suite gates.
 */
export function layoutKeyOverlap(a: KeyboardLayout, b: KeyboardLayout): readonly string[] {
  const mine = layoutKeyCodes(a);
  return [...layoutKeyCodes(b)].filter((code) => mine.has(code)).sort();
}