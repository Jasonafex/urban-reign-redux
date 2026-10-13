/**
 * Split-keyboard input: two players on one keyboard, no modifier chording.
 *
 * A `KeyboardSource` holds one down-set per layout and samples each into a `ControlState`. It
 * takes `code` strings rather than `KeyboardEvent`s so it can be driven from Node with no DOM at
 * all, and so the same edge-detection rules apply to a real event and a synthetic one.
 *
 * Edge detection is latched here, at the device boundary, for the same reason as in `gamepad.ts`:
 * the only evidence that a press happened is the moment it arrives, and `keydown` with
 * `repeat: true` is the OS telling us it already did.
 */

import {
  INPUT_ACTIONS,
  KEYBOARD_LAYOUTS,
  layoutHasKey,
  NEUTRAL_CONTROL,
  type ControlState,
  type InputAction,
  type KeyboardLayout,
} from './layout';

export interface KeyboardState {
  readonly layout: KeyboardLayout;
  readonly control: ControlState;
  /** Actions that went down on the most recent `keyDown`. Drives join detection and buffering. */
  readonly pressed: readonly InputAction[];
  /** True when any key of this layout is currently down. */
  readonly active: boolean;
}

interface LayoutMemory {
  /** Codes currently down for this layout. Mutated in place; the reference never changes. */
  readonly down: Set<string>;
  /** Recomputed on every state change, so a sample is a pure function of `down`. */
  held: Readonly<Record<InputAction, boolean>>;
}

export class KeyboardSource {
  private readonly layouts: readonly KeyboardLayout[];
  private readonly memory = new Map<string, LayoutMemory>();
  /** Press edges seen since the last `poll()`, per layout. Consumed by sampling, never by time. */
  private readonly pending = new Map<string, InputAction[]>();

  constructor(layouts: readonly KeyboardLayout[] = KEYBOARD_LAYOUTS) {
    this.layouts = layouts.slice();
    for (const layout of this.layouts) {
      this.memory.set(layout.id, {
        down: new Set<string>(),
        held: NEUTRAL_CONTROL.held,
      });
      this.pending.set(layout.id, []);
    }
  }

  /** The layouts this source is listening for, in join-priority order. */
  get profiles(): readonly KeyboardLayout[] {
    return this.layouts;
  }

  /**
   * Record a key going down.
   *
   * `repeat` is the OS auto-repeat flag. A repeat is *not* a new press: the key is already in the
   * down-set, so it cannot produce an edge, and holding J must not machine-gun the chain opener.
   * It is still recorded as down, because a keydown that arrives after a missed keyup (focus loss,
   * a key held while the tab was hidden) has to be able to restore the held state.
   *
   * Returns the layout ids this press activated — the join signal.
   */
  keyDown(code: string, repeat = false): readonly string[] {
    const joined: string[] = [];
    for (const layout of this.layouts) {
      const memory = this.memory.get(layout.id);
      if (memory === undefined || !layoutHasKey(layout, code)) {
        continue;
      }
      const alreadyDown = memory.down.has(code);
      memory.down.add(code);
      if (alreadyDown && repeat) {
        // Nothing changed: the key was already down and this is an OS echo, not a press.
        continue;
      }
      const held = recomputeHeld(layout, memory.down);
      const previous = memory.held;
      memory.held = held;
      // Edges accumulate rather than replace: a strike and a dodge that both went down between two
      // polls are two presses, and overwriting would make the second one silently eat the first.
      const edges = this.pending.get(layout.id) ?? [];
      for (const action of INPUT_ACTIONS) {
        if (held[action] === true && previous[action] !== true && !edges.includes(action)) {
          edges.push(action);
        }
      }
      this.pending.set(layout.id, edges);
      joined.push(layout.id);
    }
    return joined;
  }

  /**
   * Record a key coming up. Returns the layout ids that were affected.
   *
   * Unknown codes are ignored rather than throwing: a keyup for a code this source never saw (the
   * key was pressed before the game took focus) is a fact about the OS, not an input-layer bug.
   */
  keyUp(code: string): readonly string[] {
    const affected: string[] = [];
    for (const layout of this.layouts) {
      const memory = this.memory.get(layout.id);
      if (memory === undefined || !memory.down.has(code)) {
        continue;
      }
      memory.down.delete(code);
      memory.held = recomputeHeld(layout, memory.down);
      affected.push(layout.id);
    }
    return affected;
  }

  /**
   * Drop every held key. Called on window blur, because a key released while the window was not
   * focused never delivers its keyup and would otherwise leave the fighter walking into a wall.
   *
   * Pending press edges are dropped too: a key that was down when focus was lost may have been
   * released a hundred times over while the tab was hidden, and firing that press on focus would
   * be an attack nobody asked for.
   */
  releaseAll(): void {
    for (const [id, memory] of this.memory) {
      memory.down.clear();
      memory.held = NEUTRAL_CONTROL.held;
      this.pending.set(id, []);
    }
  }

  /** True while any key of `layoutId` is down. */
  isActive(layoutId: string): boolean {
    return (this.memory.get(layoutId)?.down.size ?? 0) > 0;
  }

  /**
   * True when any served layout listens for `code`.
   *
   * The entry point uses this to `preventDefault()` the keys the game owns. Without it, P2's
   * arrow cluster scrolls the page and Space/arrows move focus off the canvas — the player loses
   * a frame to the browser in the middle of a string.
   */
  bindsKey(code: string): boolean {
    return this.layouts.some((layout) => layoutHasKey(layout, code));
  }

  /**
   * Sample every layout, in declaration order.
   *
   * Sampling consumes the press edges accumulated since the last poll, which is what makes them a
   * per-tick signal rather than a per-event one.
   */
  poll(): readonly KeyboardState[] {
    const states: KeyboardState[] = [];
    for (const layout of this.layouts) {
      const state = this.stateFor(layout.id);
      if (state !== undefined) {
        states.push(state);
      }
      this.pending.set(layout.id, []);
    }
    return states;
  }

  /** Sample one layout by id without consuming its pending press edges. */
  stateFor(layoutId: string): KeyboardState | undefined {
    const layout = this.layouts.find((candidate) => candidate.id === layoutId);
    const memory = this.memory.get(layoutId);
    if (layout === undefined || memory === undefined) {
      return undefined;
    }
    const down = memory.down;
    return {
      layout,
      control: {
        moveX: (down.has(layout.right) ? 1 : 0) - (down.has(layout.left) ? 1 : 0),
        moveZ: (down.has(layout.down) ? 1 : 0) - (down.has(layout.up) ? 1 : 0),
        held: memory.held,
      },
      pressed: [...(this.pending.get(layoutId) ?? [])],
      active: down.size > 0,
    };
  }
}

function recomputeHeld(
  layout: KeyboardLayout,
  down: ReadonlySet<string>,
): Readonly<Record<InputAction, boolean>> {
  const held = {} as Record<InputAction, boolean>;
  for (const action of INPUT_ACTIONS) {
    held[action] = down.has(layout.keys[action]);
  }
  return Object.freeze(held);
}