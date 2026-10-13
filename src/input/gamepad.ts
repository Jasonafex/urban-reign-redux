/**
 * Gamepad polling — up to four physical pads, one player each.
 *
 * Reads the W3C *Standard Gamepad* layout (the one every modern browser exposes for Xbox, PlayStation
 * and generic USB pads). Button indices are the standard ones, so a PlayStation pad and an Xbox pad
 * are the same code path: index 0 is the bottom face button on both, and only the plastic differs.
 *
 * AGENTS.md §3.1: this is input, not simulation. It reads a device and produces a `ControlState`;
 * it never writes to a `Fighter`. `globalThis.navigator.getGamepads` does not exist in Node, so the
 * source degrades to "no pads" instead of throwing — the headless suite drives it with a fake
 * navigator instead.
 *
 * Known limitation, documented rather than papered over: pads that report their triggers on
 * `axes[2..5]` instead of `buttons[4..7]` (SDL-mapped hardware on some Linux/Chrome builds) will not
 * register the shoulder/trigger bindings. Phase 2 maps buttons only; axis-as-trigger support is a
 * netcode-visible input change and belongs with the rollback work.
 */

import {
  applyRadialDeadzone,
  clampAxis,
  INPUT_ACTIONS,
  INPUT_DEADZONE,
  NEUTRAL_CONTROL,
  snapToOctant,
  type ControlState,
  type InputAction,
} from './layout';

/** Hard ceiling on simultaneously polled pads: one per player slot, per AGENTS.md §5. */
export const MAX_GAMEPADS = 4;

/**
 * The deadzone every pad axis passes through before it reaches the sim.
 *
 * 0.18 is the W3C "recommended default" zone, and it is the value that survives a cheap
 * third-party pad: the cheap ones rest around 0.08-0.12 and drift to 0.2 when the case is flexed,
 * while a genuine Microsoft pad sits below 0.05. 0.18 leaves the honest pads untouched and rejects
 * most of the noise from the cheap ones.
 */
export const GAMEPAD_DEADZONE = INPUT_DEADZONE;

/** One pad button, in the shape `navigator.getGamepads()` returns. */
export interface GamepadButtonLike {
  readonly pressed: boolean;
  /** 0..1 on digital-capable triggers; unused by the standard mapping. */
  readonly value?: number;
}

/** One pad, in the shape `navigator.getGamepads()` returns. Deliberately structural, not DOM. */
export interface GamepadLike {
  readonly index: number;
  readonly id: string;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonLike[];
}

/** The slice of `navigator` this source needs. Injected so tests can drive it in Node. */
export interface GamepadNavigator {
  getGamepads(): readonly (GamepadLike | null)[];
}

/**
 * Standard-mapping button indices, per action. More than one index per action is allowed so a
 * control can live on both its primary and its alias (target lock on LT *and* on L3 press).
 */
export const STANDARD_BUTTONS: Readonly<Record<InputAction, readonly number[]>> = Object.freeze({
  // A / Cross — bottom face. The chain opener, matching every other brawler.
  strike: Object.freeze([0]),
  // X / Square — left face. Grabs live away from the strike so a mashing hand does not mash them.
  grab: Object.freeze([2]),
  // Y / Triangle — top face. SPA: the one button you never want to press by accident, so it sits
  // furthest from the strike and takes a deliberate two-finger reach on a pad.
  special: Object.freeze([3]),
  // B / Circle holds guard. Which guard (high or low) follows the left stick: down + guard is the
  // sweep guard. One hold button instead of two means guard is reachable while the stick moves,
  // which is the whole point of guarding.
  guardHigh: Object.freeze([1]),
  guardLow: Object.freeze([1]),
  // LB / RB — dodge high and low. Bumpers rather than the face buttons, because a dodge is a
  // reaction: it has to be pressable while the strike hand is still on A.
  dodgeHigh: Object.freeze([4]),
  dodgeLow: Object.freeze([5]),
  // LT and L3 both cycle the target lock (AGENTS.md §5: "L2/R2 / bumper / stick flick").
  targetSwitch: Object.freeze([6, 10]),
});

/** D-pad buttons of the standard mapping, folded into the movement vector. */
export const DPAD_BUTTONS = Object.freeze({
  up: 12,
  down: 13,
  left: 14,
  right: 15,
});

/** Start/select. Not an `InputAction`: it is menu intent, consumed by the presentation layer. */
export const START_BUTTONS: readonly number[] = Object.freeze([9]);

/** One pad's state after a single poll. */
export interface GamepadSample {
  readonly index: number;
  readonly id: string;
  readonly connected: true;
  readonly control: ControlState;
  /** Actions that went down during *this* poll — the join signal and the buffer's edge source. */
  readonly pressed: readonly InputAction[];
  /** Start/select went down this poll. */
  readonly startPressed: boolean;
  /** True when the pad is doing anything at all. A resting pad must not claim a player slot. */
  readonly active: boolean;
}

export interface GamepadSourceOptions {
  /** Pads to poll. Defaults to `MAX_GAMEPADS`. */
  readonly maxPads?: number;
  /** Override the device source (tests, replay rigs). `null` forces "no pads at all". */
  readonly navigator?: GamepadNavigator | null;
}

/**
 * Resolve the real `navigator.getGamepads` if this host has one.
 * Returns `null` in Node, in a worker without gamepad access, and behind a permission policy that
 * withholds the API — all of which mean "no pads", never an exception.
 */
export function detectGamepadNavigator(): GamepadNavigator | null {
  const host = (
    globalThis as { navigator?: { getGamepads?: () => readonly (GamepadLike | null)[] } }
  ).navigator;
  const getGamepads = host?.getGamepads;
  if (typeof getGamepads !== 'function') {
    return null;
  }
  return {
    getGamepads: () => (typeof getGamepads === 'function' ? getGamepads.call(host) ?? [] : []),
  };
}

/**
 * Polls up to four pads and turns each into a `ControlState`.
 *
 * Edge detection lives here, not in `input/buffer.ts`: a pad is only readable *now*, so the press
 * that happened between two polls has to be latched at the device boundary or it is lost for good.
 * Keyboard and touch sample continuously and latch for the same reason in their own layers.
 */
export class GamepadSource {
  private readonly maxPads: number;
  private readonly navigator: GamepadNavigator | null;
  /** Held actions per pad index, carried across polls purely for edge detection. */
  private readonly previous = new Map<number, Readonly<Record<InputAction, boolean>>>();

  constructor(options: GamepadSourceOptions = {}) {
    this.maxPads = Math.min(Math.max(options.maxPads ?? MAX_GAMEPADS, 0), MAX_GAMEPADS);
    this.navigator =
      options.navigator === undefined ? detectGamepadNavigator() : options.navigator;
  }

  /** True when this host can poll pads at all. */
  get available(): boolean {
    return this.navigator !== null;
  }

  /**
   * Read every connected pad once.
   *
   * Samples come back sorted by pad index and capped at `maxPads`, so the mapping from physical
   * device to player slot does not depend on the enumeration order the browser happens to use.
   * Pads that have gone away simply stop appearing; `JoinManager` notices the missing index.
   */
  poll(): readonly GamepadSample[] {
    if (this.navigator === null) {
      return [];
    }
    let devices: readonly (GamepadLike | null)[];
    try {
      devices = this.navigator.getGamepads() ?? [];
    } catch {
      // Some browsers expose `getGamepads` but throw when the page is not focused or a pad is
      // asleep. A device layer that can throw takes the whole render loop with it, so a throwing
      // API is read here as "no pads" and the slot table simply keeps what it had.
      return [];
    }
    const live = devices
      .filter((pad): pad is GamepadLike => pad !== null && pad !== undefined)
      .slice(0, this.maxPads)
      .sort((a, b) => a.index - b.index);

    const samples: GamepadSample[] = [];
    const seen = new Set<number>();
    for (const pad of live) {
      seen.add(pad.index);
      samples.push(this.samplePad(pad));
    }
    // Forget pads that disconnected, so reconnecting the same device starts from a clean edge state
    // instead of reporting every button as newly pressed on the first poll after a replug.
    for (const index of [...this.previous.keys()]) {
      if (!seen.has(index)) {
        this.previous.delete(index);
      }
    }
    return samples;
  }

  private samplePad(pad: GamepadLike): GamepadSample {
    const buttonDown = (indices: readonly number[]): boolean =>
      indices.some((index) => pad.buttons[index]?.pressed === true);

    // The D-pad is reported as buttons, not axes. Fold it in before the deadzone so a pad with a
    // worn stick still walks cleanly on its D-pad.
    const dpadX = (buttonDown([DPAD_BUTTONS.right]) ? 1 : 0) - (buttonDown([DPAD_BUTTONS.left]) ? 1 : 0);
    const dpadZ = (buttonDown([DPAD_BUTTONS.down]) ? 1 : 0) - (buttonDown([DPAD_BUTTONS.up]) ? 1 : 0);

    const stickX = clampAxis((pad.axes[0] ?? 0) + dpadX);
    const stickZ = clampAxis((pad.axes[1] ?? 0) + dpadZ);
    const deadzoned = applyRadialDeadzone(stickX, stickZ, GAMEPAD_DEADZONE);

    // Guard follows the stick: B alone is the high guard, B + down is the sweep guard. Both actions
    // are mapped to the same button, so the resolution has to happen here rather than in the table.
    const holdingGuard = buttonDown(STANDARD_BUTTONS.guardHigh);
    const held = {} as Record<InputAction, boolean>;
    for (const action of INPUT_ACTIONS) {
      held[action] = buttonDown(STANDARD_BUTTONS[action]);
    }
    held.guardHigh = holdingGuard;
    held.guardLow = holdingGuard && deadzoned.z > 0;

    const before = this.previous.get(pad.index) ?? NEUTRAL_CONTROL.held;
    const pressed = INPUT_ACTIONS.filter(
      (action) => held[action] === true && before[action] !== true,
    );
    this.previous.set(pad.index, held);

    const magnitude = Math.hypot(deadzoned.x, deadzoned.z);
    return {
      index: pad.index,
      id: pad.id,
      connected: true,
      control: { moveX: deadzoned.x, moveZ: deadzoned.z, held },
      pressed,
      startPressed: START_BUTTONS.some((index) => pad.buttons[index]?.pressed === true),
      active: magnitude > 0 || pressed.length > 0 || holdingGuard,
    };
  }
}

/**
 * Snap a pad vector to the eight compass headings.
 *
 * Exported for the touch layer's analog-free path and for tests; the pad path itself keeps the
 * analog magnitude, because a stick that leans 30% should walk slower than one that leans 90%.
 */
export function snapPadVector(x: number, z: number): { x: number; z: number } {
  return snapToOctant(x, z);
}