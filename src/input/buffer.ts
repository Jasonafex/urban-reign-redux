/**
 * Input history: the tick buffer that turns held buttons into `FrameInput`.
 *
 * This is the only place in the input stack that knows what a `FrameInput` is. Gamepads,
 * keyboards and touch screens all produce the same `ControlState`; from here on the three devices
 * are indistinguishable, which is what makes a phone player and a pad player behave identically.
 *
 * Two things happen here that a raw `keys.has(...)` cannot do:
 *
 *   1. **Edge detection.** `FrameInput.attack` is read by the sim on every actionable tick, so
 *      feeding it a *held* button re-fires the chain opener the instant the fighter recovers. One
 *      physical press must mean exactly one button input.
 *
 *   2. **Buffering.** A press made during recovery is not lost: it is remembered for
 *      `INPUT_BUFFER_TICKS` ticks and offered again every tick until the sim takes it. This is the
 *      behaviour that makes a five-link string land instead of eating its inputs, and it is why the
 *      buffer needs to know whether the sim *accepted* the press it handed out — see `settle()`.
 *
 * AGENTS.md §3.2: no wall clock here. Everything is counted in simulation ticks, so a replayed or
 * rolled-back tick re-derives the same input from the same history.
 */

import { CHAIN_PRESS, NEUTRAL_INPUT, type DodgeInput, type FrameInput } from '../sim/runner';
import type { MoveStance } from '../combat/moveset';
import {
  INPUT_ACTIONS,
  isHeld,
  type ControlState,
  type InputAction,
} from './layout';

/**
 * How long a press stays eligible after the tick it was made on.
 *
 * Eight ticks is ~133ms at 60Hz — about seven times a jab's startup, and comfortably inside the
 * `CHAIN_CANCEL_WINDOW` of 14 frames, so a confirm-press made on the contact frame still lands in
 * the window it was opened for. Longer would start eating inputs the player has clearly abandoned;
 * shorter would punish the normal rhythm of a link-then-confirm string.
 */
export const INPUT_BUFFER_TICKS = 8;

/** Actions that resolve to an `attack` token. */
export type AttackAction = 'strike' | 'grab' | 'special';

/** Actions that resolve to a `dodge` direction. */
export type DodgeAction = 'dodgeHigh' | 'dodgeLow';

const ATTACK_ACTIONS: readonly InputAction[] = Object.freeze(['strike', 'grab', 'special']);
const DODGE_ACTIONS: readonly InputAction[] = Object.freeze(['dodgeHigh', 'dodgeLow']);

/** Baseline grabs. Universal move ids, so one grab button works on every archetype. */
export const GRAB_HIGH_MOVE = 'grab_high';
export const GRAB_LOW_MOVE = 'grab_low';

/**
 * Baseline SPA tiers. `spa1` is the lethal single-target strike; `spa2` is the 360 crowd clearer,
 * which AGENTS.md §5 pairs with "emergency escape" — so pressing SPA *while guarding* buys the
 * escape, and pressing it bare buys the damage.
 */
export const SPA_LETHAL_MOVE = 'spa1';
export const SPA_CROWD_MOVE = 'spa2';

export interface PressOptions {
  /** Direction held when the press was made. A buffered press keeps the stance it was made with. */
  readonly stance: MoveStance;
  /** Whether a guard was held when the press was made. */
  readonly guarding: boolean;
}

/**
 * The `attack` token one press becomes.
 *
 * Returns `null` for anything that is not an attack press (dodges, guards, target switch), so a
 * caller can use this as the "is this a press I can attack with" test.
 *
 * Stance is read at *press* time, not at fire time. A player who presses up-attack and lets the
 * stick drift forward before the buffer releases still asked for the up chain, and a buffered press
 * that re-resolved its stance every tick would make strings unplayable on a phone.
 */
export function attackTokenFor(
  action: InputAction,
  options: PressOptions,
): string | null {
  switch (action) {
    case 'strike':
      // The sentinel resolves against `FrameInput.stance`, which `frameInput` sets to the press's
      // own stance. One button, four chains — this is the 4-way branching of AGENTS.md §5.
      return CHAIN_PRESS;
    case 'grab':
      // Holding down is the low grab; everything else is the standing high grab.
      return options.stance === 'down' ? GRAB_LOW_MOVE : GRAB_HIGH_MOVE;
    case 'special':
      return options.guarding ? SPA_CROWD_MOVE : SPA_LETHAL_MOVE;
    default:
      return null;
  }
}

/** The dodge direction one press becomes, or `'none'` when it is not a dodge press. */
export function dodgeFor(action: InputAction): DodgeInput {
  if (action === 'dodgeHigh') return 'high';
  if (action === 'dodgeLow') return 'low';
  return 'none';
}

/** One button press waiting to be consumed by the simulation. */
export interface BufferedPress {
  readonly action: InputAction;
  /** `attack` token for attack presses, `null` for dodges. */
  readonly attack: string | null;
  /** `dodge` direction for dodge presses, `'none'` otherwise. */
  readonly dodge: DodgeInput;
  /** Stance held when the press was made; drives `FrameInput.stance` while the press is live. */
  readonly stance: MoveStance;
  /** Guard held when the press was made; picks SPA 1 vs SPA 2. */
  readonly guarding: boolean;
  /** Tick the press was made on. Expiry is measured from here, never from wall clock. */
  readonly tick: number;
}

export interface ControlSample {
  readonly tick: number;
  readonly control: ControlState;
}

export interface InputHistoryOptions {
  /** Buffer length. Defaults to `INPUT_BUFFER_TICKS`. Kept injectable so tests can prove that the
   *  8-tick default is the behaviour the sim's cancel windows were tuned against. */
  readonly bufferTicks?: number;
}

/**
 * Rolling 8-tick control history plus the press buffer for one player slot.
 *
 * One history per slot, never shared: two players pressing strike on the same tick are two
 * independent presses, and a shared buffer would let one player's input cancel the other's.
 */
export class InputHistory {
  readonly slot: number;
  readonly capacity: number;

  private readonly ring: (ControlSample | null)[];
  /** Next write position in `ring`. */
  private head = 0;
  /** Samples currently stored, saturating at `capacity`. */
  private stored = 0;
  /** Tick of the most recent `record()`, or -1 before the first. */
  private lastTick = -1;

  /** Presses waiting for the sim, oldest first. */
  private queue: BufferedPress[] = [];
  /** The press handed out on the current tick, kept until `settle()` says what happened to it. */
  private inFlight: BufferedPress | null = null;
  /** Cache making `frameInput(tick)` idempotent within a tick (rollback re-simulation safety). */
  private built: { tick: number; input: FrameInput } | null = null;

  constructor(slot: number, options: InputHistoryOptions = {}) {
    this.slot = slot;
    const capacity = options.bufferTicks ?? INPUT_BUFFER_TICKS;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`bufferTicks must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.ring = new Array<ControlSample | null>(capacity).fill(null);
  }

  /** Most recent recorded tick, or -1 before the first sample. */
  get tick(): number {
    return this.lastTick;
  }

  /** Presses currently waiting for the sim, including the one in flight. */
  get pendingPresses(): number {
    return this.queue.length + (this.inFlight === null ? 0 : 1);
  }

  /** The press most recently handed to the sim, if any. */
  get currentPress(): BufferedPress | null {
    return this.inFlight;
  }

  /**
   * Record this tick's control sample and latch any press edges it contains.
   *
   * Edges are derived here rather than taken from the device, so the buffer behaves identically
   * whether the device layer detected the edge (gamepad polling) or simply reports held state.
   */
  record(control: ControlState, tick: number): void {
    // The newest sample *before* this one is the previous state — reading `sampleAt(1)` here
    // would skip past it, and every held button would look like a fresh press on every tick.
    const previous = this.stored === 0 ? null : this.sampleAt(0);
    this.push({ tick, control });

    const nowHeld = control.held;
    const wasHeld = previous?.control.held;
    const stance = stanceFor(control.moveX, control.moveZ);
    const guarding = nowHeld.guardHigh === true || nowHeld.guardLow === true;

    for (const action of INPUT_ACTIONS) {
      const isDown = nowHeld[action] === true;
      // On the very first sample there is nothing to compare against, so anything already down
      // counts as a press: a key held while the page gained focus must not be silently swallowed.
      const wasDown = previous === null ? false : wasHeld?.[action] === true;
      if (!isDown || wasDown) {
        continue;
      }
      if (!ATTACK_ACTIONS.includes(action) && !DODGE_ACTIONS.includes(action)) {
        continue; // guard and target switch are levels, not presses
      }
      this.enqueue({
        action,
        attack: attackTokenFor(action, { stance, guarding }),
        dodge: dodgeFor(action),
        stance,
        guarding,
        tick,
      });
    }
  }

  /**
   * Whether `action` went down within the buffer window ending at `tick`.
   *
   * This is the *device* edge (did the button go down), not the press queue (was the sim given an
   * attack) — the join screen and the HUD read it, and the test suite uses it to prove one press
   * produces exactly one edge.
   */
  pressed(action: InputAction, tick: number = this.lastTick): boolean {
    if (tick < 0) {
      return false;
    }
    const oldest = tick - (this.capacity - 1);
    for (let back = 0; back < this.stored; back += 1) {
      const sample = this.sampleAt(back);
      if (sample === null || sample.tick < oldest || sample.tick > tick) {
        continue;
      }
      const newer = this.sampleAt(back - 1);
      if (isHeld(sample.control, action) && (newer === null || !isHeld(newer.control, action))) {
        return true;
      }
    }
    return false;
  }

  /** Whether `action` was held at `tick`. Absent samples report false, not a throw. */
  held(action: InputAction, tick: number = this.lastTick): boolean {
    return this.sampleAtTick(tick)?.control.held[action] === true;
  }

  /** The control sample recorded at `tick`, or `undefined` when it has aged out. */
  sampleAtTick(tick: number): ControlSample | undefined {
    for (let back = 0; back < this.stored; back += 1) {
      const sample = this.sampleAt(back);
      if (sample !== null && sample.tick === tick) {
        return sample;
      }
    }
    return undefined;
  }

  /**
   * Build this tick's `FrameInput`.
   *
   * Movement and guard are *levels*: they are read straight off the newest sample, because holding
   * a direction means "keep walking that way". Attack and dodge are *presses*: at most one press
   * leaves the queue per tick, oldest first, and only while it is still inside the buffer window.
   *
   * Idempotent within a tick — calling it twice for the same tick returns the identical object, so
   * a rollback that re-simulates tick N with the same history re-derives the same input.
   */
  frameInput(tick: number): FrameInput {
    if (this.built !== null && this.built.tick === tick) {
      return this.built.input;
    }
    this.expire(tick);
    this.built = { tick, input: this.build(tick) };
    return this.built.input;
  }

  /**
   * Report what the sim did with the press handed out on `tick`.
   *
   * Accepted: the press is done and every *older* queued press is dropped too. A landed jab should
   * not still have the strike you mashed before it waiting to fire the moment you recover.
   *
   * Rejected: the fighter was not actionable (recovery, stun, hitstop). The press stays live and is
   * offered again next tick, until it ages out of the buffer window.
   */
  settle(accepted: boolean, tick: number): void {
    const press = this.inFlight;
    if (press === null) {
      return;
    }
    if (!this.built || this.built.tick !== tick) {
      // Settling a tick that handed out nothing is a no-op rather than an error: the sim may have
      // been driven past this slot's tick (a catch-up burst, a restore), and dropping the press is
      // the conservative reading.
      return;
    }
    if (accepted) {
      this.inFlight = null;
      this.queue = [];
      return;
    }
    if (tick - press.tick >= this.capacity) {
      this.inFlight = null;
    }
  }

  /** Drop all history and buffered presses. Called when a slot's device goes away. */
  reset(): void {
    this.ring.fill(null);
    this.head = 0;
    this.stored = 0;
    this.lastTick = -1;
    this.queue = [];
    this.inFlight = null;
    this.built = null;
  }

  // -------------------------------------------------------------------------------------------

  private build(tick: number): FrameInput {
    // Prefer the sample for this exact tick; fall back to the newest one so a caller that records
    // late (or a catch-up burst) still gets a movement vector instead of a throw.
    const control = (this.sampleAtTick(tick) ?? this.newest()).control;
    const press = this.pressFor(tick);
    return {
      moveX: control.moveX,
      moveZ: control.moveZ,
      attack: press?.attack ?? null,
      stance: press?.stance ?? stanceFor(control.moveX, control.moveZ),
      // Low guard wins when both are held: down+guard on a pad sets both, and the sweep guard is
      // the one the player meant.
      guard: control.held.guardLow === true
        ? 'low'
        : control.held.guardHigh === true
          ? 'high'
          : 'none',
      dodge: press?.dodge ?? 'none',
    };
  }

  /** The press this tick should hand to the sim, arming `inFlight` on first use. */
  private pressFor(tick: number): BufferedPress | null {
    if (this.inFlight !== null && tick - this.inFlight.tick < this.capacity) {
      return this.inFlight;
    }
    this.inFlight = null;
    const head = this.queue[0];
    if (head === undefined || tick - head.tick >= this.capacity) {
      return null;
    }
    this.queue.shift();
    this.inFlight = head;
    return head;
  }

  /** Drop anything that has aged out of the window, in flight presses included. */
  private expire(tick: number): void {
    this.queue = this.queue.filter((press) => tick - press.tick < this.capacity);
    if (this.inFlight !== null && tick - this.inFlight.tick >= this.capacity) {
      this.inFlight = null;
    }
  }

  /**
   * Enqueue a press.
   *
   * Re-pressing a button already waiting replaces the queued one rather than stacking: holding
   * strike through a five-link string must not bank five chain presses and then fire them all the
   * instant the fighter recovers. The edge detection above makes that impossible for a held button;
   * this makes it impossible for a button mashed faster than the fighter can act.
   */
  private enqueue(press: BufferedPress): void {
    const sameAction = this.queue.findIndex((queued) => queued.action === press.action);
    if (sameAction >= 0) {
      this.queue[sameAction] = press;
      return;
    }
    this.queue.push(press);
  }

  private push(sample: ControlSample): void {
    this.ring[this.head] = sample;
    this.head = (this.head + 1) % this.capacity;
    if (this.stored < this.capacity) {
      this.stored += 1;
    }
    this.lastTick = Math.max(this.lastTick, sample.tick);
  }

  /** Sample `back` positions behind the newest, 0 being the newest. */
  private sampleAt(back: number): ControlSample | null {
    const index = ((this.head - 1 - back) % this.capacity + this.capacity) % this.capacity;
    return this.ring[index] ?? null;
  }

  private newest(): ControlSample {
    const sample = this.sampleAt(0);
    if (sample === null) {
      throw new RangeError('InputHistory has no samples; call record() before frameInput().');
    }
    return sample;
  }
}

/**
 * The stance a movement intent selects for the 4-way chain branching (AGENTS.md §5).
 *
 * Up before side, because up+side is the diagonal a player holds while approaching with a launcher
 * intended — and the sim's `directionFor` already collapses diagonals for movement, so the same
 * rule reads consistently for both.
 */
export function stanceFor(moveX: number, moveZ: number): MoveStance {
  if (moveZ < 0) return 'up';
  if (moveZ > 0) return 'down';
  if (moveX !== 0) return 'side';
  return 'neutral';
}

/** Re-exported so callers building a rig do not have to reach into the sim for the neutral input. */
export { NEUTRAL_INPUT };