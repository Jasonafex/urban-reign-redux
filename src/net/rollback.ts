/**
 * Speculative rollback netcode (AGENTS.md §3.3).
 *
 * The rule this file exists to satisfy: **the local player waits for nobody.** A tick executes with
 * the local input sampled this frame and a *prediction* of every remote input. When a real remote
 * input finally arrives and contradicts the prediction, the world rewinds to the last agreed tick
 * and re-simulates. A player never sees a stall; the correction is invisible unless it changes
 * what they are looking at.
 *
 * ## The invariants that make it correct
 *
 *  1. **Everything the engine stores goes through `canonicalizeInput`.** The local peer must
 *     simulate a tick with byte-identical input to the value its peers received. Without this, a
 *     gamepad axis of `0.30000000000000004` simulated locally and quantised on the wire would
 *     desync on every single rollback — permanently, and silently.
 *
 *  2. **`frameFor(tick)` is a pure function of stored state.** What the engine *simulates* for a
 *     tick and what it *believes* it simulated for that tick are computed by the same function, so
 *     "did my prediction turn out wrong?" is a comparison rather than a bookkeeping exercise that
 *     can drift out of sync with the simulation.
 *
 *  3. **Snapshots are a ring, and rewinds are clamped to it.** Rewinding past the oldest retained
 *     snapshot would need a replay from tick 0. Instead the rewind target is clamped and reported
 *     as `maxRewindTicks`, so the degradation is visible instead of unbounded.
 *
 *  4. **A departed peer goes neutral *retroactively*, from a known tick.** See `markDeparted`: this
 *     is the difference between a house LAN where a phone locks and everyone else stays in sync,
 *     and one where a phone locks and the match diverges for the rest of the evening.
 *
 * ## What this file must never do
 *
 * No DOM, no sockets, no wall clock, no randomness (AGENTS.md §3.1). Time enters only as `tick`
 * counts and as the explicit `atTick` a caller supplies. `test/rollback.test.mjs` gates all of it
 * by running the real engine headlessly, including the architecture scan.
 */

import type { FighterSpawn, FrameInput, MatchSnapshot } from '../sim/runner';
import { DT } from '../config';
import { MatchRunner } from '../sim/runner';
import type { SimEvent } from '../sim/events';
import {
  MAX_PLAYERS,
  NEUTRAL_FRAME_INPUT,
  canonicalizeInput,
  frameInputsEqual,
  isValidSlot,
} from './protocol';

/**
 * Default rewind depth in ticks.
 *
 * 12 ticks is 200ms at 60Hz, which comfortably covers a house Wi-Fi round trip on a phone in a
 * dead spot without letting a peer that stalls for a second stall the local player: a mispredict
 * older than the window is stored as confirmed but cannot be re-simulated, which is reported
 * through `maxRewindTicks` rather than hidden.
 */
export const DEFAULT_MAX_ROLLBACK_TICKS = 12;

/**
 * Predicted input for a slot whose latest confirmed input is `last`.
 *
 * The default repeats the last confirmed input verbatim, which is what AGENTS.md §3.3 specifies and
 * is the right default for a brawler: movement and guard are usually held, so a repeat is usually
 * correct. `null` means "this slot has never been heard from", which predicts neutral.
 *
 * Overridable because a one-shot press is the case a repeat gets wrong most expensively — holding
 * a chain opener across a 40ms prediction would auto-play a combo the player did not ask for. A
 * caller can pass a transform that nulls `attack`/`dodge` while keeping movement and guard.
 */
export type Predictor = (last: FrameInput | null, slot: number) => FrameInput;

/** Repeat the last confirmed input; neutral when the slot has never been heard from. */
export const repeatLastInput: Predictor = (last) =>
  last === null ? NEUTRAL_FRAME_INPUT : last;

export interface RollbackOptions {
  /** Which fighter this peer controls. Its input is applied with zero delay. */
  readonly localSlot: number;
  /** Rewind depth in ticks. Defaults to `DEFAULT_MAX_ROLLBACK_TICKS`. */
  readonly maxRollbackTicks?: number;
  /** Remote input prediction strategy. Defaults to `repeatLastInput`. */
  readonly predict?: Predictor;
  /** Starting roster. Defaults to the simulation's own four-archetype spawn. */
  readonly spawns?: readonly FighterSpawn[];
}

export interface AdvanceResult {
  /** The tick that was just simulated. */
  readonly tick: number;
  /**
   * Events from the final tick only.
   *
   * Events produced by ticks that were re-simulated during a rollback are *discarded*: they were
   * built from state that no longer exists, and the presentation layer has usually already played a
   * sound or a spark for them. Handing back the true, current tick's events is what keeps the
   * "presentation reads events, never state" contract (AGENTS.md §3.1) honest.
   */
  readonly events: readonly SimEvent[];
  /**
   * True when at least one remote slot ran on a prediction for this tick.
   *
   * The presentation layer uses this to avoid feeding speculative results back into input
   * buffering (which would accept or reject a press based on a state that is about to be rolled
   * back).
   */
  readonly speculative: boolean;
  /** Ticks re-simulated as part of this advance. Zero unless a rollback completed first. */
  readonly rolledBack: number;
}

export interface RemoteInputResult {
  /** The input was for a tick ahead of the simulation; it is queued, no rollback needed. */
  readonly queued: boolean;
  /** The input contradicted a prediction and the world was rewound and re-simulated. */
  readonly rolledBack: boolean;
  /** Ticks actually re-simulated. Clamped to the snapshot ring. */
  readonly rolledBackTicks: number;
  /** The slot is this peer's own slot; an echo of its own input was ignored. */
  readonly ignored: boolean;
  /** The input arrived from a peer that has since departed; it was discarded. */
  readonly departed: boolean;
}

export interface RollbackStats {
  /** Number of completed rollbacks. */
  readonly rollbacks: number;
  /** Total ticks re-simulated across all rollbacks. */
  readonly rolledBackTicks: number;
  /** Deepest single rewind, in ticks. */
  readonly maxRewindTicks: number;
  /** Remote inputs that contradicted a prediction. */
  readonly mispredictions: number;
  /** Remote inputs discarded because their peer had already departed. */
  readonly droppedAfterDeparture: number;
  /** Inputs received for a tick so old the ring can no longer re-simulate it. */
  readonly tooOldToCorrect: number;
}

const NO_RESULT: RemoteInputResult = Object.freeze({
  queued: false,
  rolledBack: false,
  rolledBackTicks: 0,
  ignored: false,
  departed: false,
});

export class RollbackSession {
  readonly runner: MatchRunner;

  private readonly local: number;
  private readonly predict: Predictor;
  private readonly ring: number;

  /** `snapshots[tick % ring]` is the world state *after* `tick`. */
  private readonly snapshots: (MatchSnapshot | null)[];
  /** `hashes[tick % ring]` is `stateHash()` *after* `tick`. */
  private readonly hashes: (string | null)[];
  /** `confirmed[slot][tick % ring]` is the verified input for that slot on that tick. */
  private readonly confirmed: (FrameInput | null)[][];
  /** Most recent verified input per slot, used as the prediction seed. */
  private readonly lastConfirmed: (FrameInput | null)[];
  /** Highest tick verified per slot, so a late packet cannot regress the prediction seed. */
  private readonly lastConfirmedTick: number[];
  /** Tick from which a departed slot goes neutral, or `null` while it is still present. */
  private readonly departedFrom: (number | null)[];

  /** The freshly-spawned tick-0 world, kept so `reset()` restores a real starting position. */
  private readonly initial: MatchSnapshot;

  private counters: RollbackStats = {
    rollbacks: 0,
    rolledBackTicks: 0,
    maxRewindTicks: 0,
    mispredictions: 0,
    droppedAfterDeparture: 0,
    tooOldToCorrect: 0,
  };

  constructor(options: RollbackOptions) {
    if (!isValidSlot(options.localSlot)) {
      throw new RangeError(`localSlot must be 0..${MAX_PLAYERS - 1}, got ${options.localSlot}`);
    }
    const maxRollback = options.maxRollbackTicks ?? DEFAULT_MAX_ROLLBACK_TICKS;
    if (!Number.isInteger(maxRollback) || maxRollback < 1) {
      throw new RangeError(`maxRollbackTicks must be a positive integer, got ${maxRollback}`);
    }

    this.local = options.localSlot;
    this.predict = options.predict ?? repeatLastInput;
    // Two extra slots of slack: one for the state *before* a rewind target, one so a full window
    // of confirmed inputs is still resident when the window is used to its limit.
    this.ring = maxRollback + 2;
    this.runner = new MatchRunner(options.spawns);

    this.snapshots = new Array<MatchSnapshot | null>(this.ring).fill(null);
    this.hashes = new Array<string | null>(this.ring).fill(null);
    this.confirmed = [];
    this.lastConfirmed = [];
    this.lastConfirmedTick = [];
    this.departedFrom = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      this.confirmed.push(new Array<FrameInput | null>(this.ring).fill(null));
      this.lastConfirmed.push(null);
      this.lastConfirmedTick.push(-1);
      this.departedFrom.push(null);
    }

    // Tick 0 is the agreed starting state on every peer, so it is always rewindable to.
    this.initial = this.runner.saveSnapshot();
    this.record(0);
  }

  get localSlot(): number {
    return this.local;
  }

  get tick(): number {
    return this.runner.tick;
  }

  get maxRollbackTicks(): number {
    return this.ring - 2;
  }

  get stats(): Readonly<RollbackStats> {
    return this.counters;
  }

  /** `stateHash()` after `tick`, if that tick is still inside the snapshot ring. */
  hashAt(tick: number): string | null {
    if (tick < 0 || tick > this.runner.tick) {
      return null;
    }
    return this.hashes[tick % this.ring] ?? null;
  }

  /** True when the slot has departed and is being fed neutral input from `departedFrom` onward. */
  isDeparted(slot: number): boolean {
    return this.departedFrom[slot] !== null;
  }

  /**
   * The input vector the engine simulates for `tick`.
   *
   * Pure with respect to the tick: it reads only stored confirmed inputs, the prediction seed and
   * departure state. Both `advance` and `simulatedInputAt` call it, which is what guarantees that
   * "what I predicted" and "what I ran" cannot drift apart (invariant 2 in the header).
   */
  frameFor(tick: number): FrameInput[] {
    const frame: FrameInput[] = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      frame.push(this.inputForSlot(slot, tick));
    }
    return frame;
  }

  /** What the engine actually fed the simulation for `slot` on `tick`. */
  simulatedInputAt(slot: number, tick: number): FrameInput {
    return this.inputForSlot(slot, tick);
  }

  /** True when the most recent advance for `tick` had to guess at this slot. */
  isSpeculating(slot: number, tick: number): boolean {
    if (slot === this.local) {
      return false;
    }
    if (this.departedFrom[slot] !== null && (this.departedFrom[slot] ?? 0) <= tick) {
      return false; // neutral is known, not predicted
    }
    return this.confirmed[slot]?.[tick % this.ring] === undefined ||
      this.confirmed[slot]?.[tick % this.ring] === null;
  }

  /**
   * Simulate exactly one tick with the local input applied immediately.
   *
   * This is the "0 input delay" guarantee: the input handed in here is consumed by the tick that
   * runs right now, not buffered for a frame later and not rounded to a network tick.
   */
  advance(input: FrameInput): AdvanceResult {
    const tick = this.runner.tick + 1;

    // Canonicalise *before* storing: this value is both what we simulate and what the relay will
    // rebroadcast to the other peers (invariant 1).
    const canonical = canonicalizeInput(input);
    this.store(this.local, tick, canonical);

    let speculative = false;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (this.isSpeculating(slot, tick)) {
        speculative = true;
        break;
      }
    }

    const events = this.runner.fixedUpdate(DT, this.frameFor(tick));
    this.record(tick);
    return { tick, events, speculative, rolledBack: 0 };
  }

  /**
   * Accept a verified remote input for `slot` on `tick`.
   *
   * If it contradicts what was simulated, the world rewinds to `tick - 1` and re-simulates forward
   * to the present. Returns what happened, including the clamped rewind depth so a caller can tell
   * a clean correction from one that ran out of history.
   */
  receiveRemoteInput(slot: number, tick: number, input: FrameInput): RemoteInputResult {
    if (!isValidSlot(slot)) {
      return NO_RESULT;
    }
    if (slot === this.local) {
      // Our own input echoed back through the relay. Storing it would be harmless but would let a
      // buggy relay overwrite the authoritative local input with a stale one.
      return { ...NO_RESULT, ignored: true };
    }
    if (!Number.isInteger(tick) || tick < 1) {
      return NO_RESULT;
    }
    const departed = this.departedFrom[slot] ?? null;
    if (departed !== null && tick >= departed) {
      this.counters = { ...this.stats, droppedAfterDeparture: this.counters.droppedAfterDeparture + 1 };
      return { ...NO_RESULT, departed: true };
    }

    const canonical = canonicalizeInput(input);
    const current = this.runner.tick;

    if (tick > current) {
      this.store(slot, tick, canonical);
      return { ...NO_RESULT, queued: true };
    }

    const simulated = this.simulatedInputAt(slot, tick);
    this.store(slot, tick, canonical);

    if (frameInputsEqual(simulated, canonical)) {
      return NO_RESULT;
    }

    this.counters = { ...this.stats, mispredictions: this.counters.mispredictions + 1 };

    const oldestRewindable = Math.max(1, current - this.ring + 2);
    if (tick < oldestRewindable) {
      // The snapshot we would need has already been overwritten. The input is stored, so the next
      // natural rewind will pick it up, but this misprediction cannot be corrected now.
      this.counters = { ...this.stats, tooOldToCorrect: this.counters.tooOldToCorrect + 1 };
      return { ...NO_RESULT };
    }

    const rolledBackTicks = this.rewind(tick);
    return {
      queued: false,
      rolledBack: rolledBackTicks > 0,
      rolledBackTicks,
      ignored: false,
      departed: false,
    };
  }

  /**
   * A peer has gone. Neutralise its slot from `atTick` onward and re-converge.
   *
   * `atTick` defaults to the current tick. Passing an *earlier* tick is how every peer agrees on
   * when the departure happened: each peer neutralises from the same tick and, if that tick is
   * already simulated, rewinds to it. Without that agreement a peer that learns of the drop one
   * tick later than its neighbour keeps the dropped player's fighter inputting for that tick, and
   * the two diverge forever with no packet left to correct them.
   *
   * Returns the number of ticks re-simulated.
   *
   * The owning peer calls this too, and it must be allowed to: when peer 1's phone locks, peer 1's
   * own session is the one that has to stop feeding its fighter input, or it keeps playing a
   * fighter that every other peer has already neutralised. `advance()` will still be called and
   * will still store the local input — `inputForSlot` consults `departedFrom` before anything
   * else, so a departed local slot reads as neutral regardless of what is handed in.
   */
  markDeparted(slot: number, atTick: number = this.runner.tick): number {
    if (!isValidSlot(slot)) {
      return 0;
    }
    const current = this.runner.tick;
    // `atTick` may be `current + 1`: the relay usually announces a departure one tick before it
    // takes effect, and refusing to record that here would mean the slot played one more live tick
    // on the peers that heard first. Anything further out than that is a scheduling error.
    if (!Number.isInteger(atTick) || atTick < 1 || atTick > current + 1) {
      return 0;
    }
    const existing = this.departedFrom[slot] ?? null;
    this.departedFrom[slot] = existing === null ? atTick : Math.min(existing, atTick);

    // Invalidate anything the departed peer said about the ticks that are now neutral, and reset the
    // prediction seed so a resurrected seed cannot leak a moving ghost back into the match.
    for (let tick = atTick; tick <= current; tick += 1) {
      const entry = this.confirmed[slot];
      if (entry !== undefined) {
        entry[tick % this.ring] = null;
      }
    }
    this.lastConfirmed[slot] = null;
    this.lastConfirmedTick[slot] = -1;

    // Only re-simulate if the departure is already in the past. A departure effective on the next
    // tick needs nothing rewound; it simply takes effect when that tick is built.
    return atTick <= current ? this.rewind(atTick) : 0;
  }

  /**
   * Put a slot back in play at the current tick, clearing a previous departure.
   *
   * A reconnecting phone gets a fresh slot from the relay and is re-seeded with neutral input; the
   * input buffer is the input layer's problem, not the netcode's.
   */
  markReturned(slot: number): void {
    if (!isValidSlot(slot)) {
      return;
    }
    this.departedFrom[slot] = null;
  }

  /** Wipe the match back to the freshly-spawned world for a rematch. */
  reset(): void {
    // Restoring the *initial* snapshot rather than zeroing the tick is what makes this a real
    // reset: fighters go back to their spawn positions with full health and an empty gauge.
    this.runner.restoreSnapshot(this.initial);
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      const entry = this.confirmed[slot];
      if (entry !== undefined) {
        entry.fill(null);
      }
      this.lastConfirmed[slot] = null;
      this.lastConfirmedTick[slot] = -1;
      this.departedFrom[slot] = null;
    }
    this.snapshots.fill(null);
    this.hashes.fill(null);
    this.record(0);
  }

  /** `stateHash()` at the current tick. The value peers exchange in the `sync` audit. */
  hash(): string {
    return this.runner.stateHash();
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  private inputForSlot(slot: number, tick: number): FrameInput {
    const departed = this.departedFrom[slot] ?? null;
    if (departed !== null && tick >= departed) {
      return NEUTRAL_FRAME_INPUT;
    }

    const stored = this.confirmed[slot]?.[tick % this.ring];
    if (stored !== undefined && stored !== null) {
      return stored;
    }

    // The local slot is never predicted: if its own input is missing for a tick we are replaying
    // (a rewind deeper than its ring entry), standing still is the only honest choice, and the
    // relay will have the real one on the next pass.
    if (slot === this.local) {
      return NEUTRAL_FRAME_INPUT;
    }

    return this.predict(this.lastConfirmed[slot] ?? null, slot);
  }

  private store(slot: number, tick: number, input: FrameInput): void {
    const entry = this.confirmed[slot];
    if (entry !== undefined) {
      entry[tick % this.ring] = input;
    }
    // Only advance the prediction seed forwards. A late packet for tick 40 arriving after tick 60
    // was seen must not drag the prediction seed backwards for tick 61.
    if (tick > (this.lastConfirmedTick[slot] ?? -1)) {
      this.lastConfirmedTick[slot] = tick;
      this.lastConfirmed[slot] = input;
    }
  }

  private record(tick: number): void {
    this.snapshots[tick % this.ring] = this.runner.saveSnapshot();
    this.hashes[tick % this.ring] = this.runner.stateHash();
  }

  /**
   * Rewind to the state *before* `fromTick` and re-simulate to where the world was.
   *
   * Returns ticks re-simulated. Returns 0 when the world is already at the rewind point or the
   * target snapshot is gone, in which case the caller simply continues forward from a state that
   * still contains a known-wrong tick — a bounded, reported failure rather than an unbounded one.
   */
  private rewind(fromTick: number): number {
    const current = this.runner.tick;
    if (fromTick > current) {
      return 0;
    }
    // The target is simply "the state just before `fromTick`". Clamping it to
    // `current - ring + 2` is the *caller's* guard to make (it refuses an impossible rewind up
    // front); applying the same clamp here as well was wrong, because for a world younger than the
    // ring that bound is negative and it dragged every rewind down to tick 0 — turning a one-tick
    // correction into a full replay of the match, every time, for the first few seconds of play.
    const target = Math.max(0, Math.min(fromTick - 1, current));
    if (target >= current) {
      return 0;
    }

    const snapshot = this.snapshots[target % this.ring];
    if (snapshot === null || snapshot === undefined) {
      return 0;
    }

    this.runner.restoreSnapshot(snapshot);

    // Re-simulate forward. The event stream from the intermediate ticks is intentionally discarded:
    // those events were generated by a lineage that no longer exists, and `receiveRemoteInput` does
    // not need them. Only the next `advance()`'s events are real again, and by then the world is
    // back on the corrected lineage.
    for (let tick = target + 1; tick <= current; tick += 1) {
      this.runner.fixedUpdate(DT, this.frameFor(tick));
      this.record(tick);
    }

    const depth = current - target;
    this.counters = {
      ...this.stats,
      rollbacks: this.counters.rollbacks + 1,
      rolledBackTicks: this.counters.rolledBackTicks + depth,
      maxRewindTicks: Math.max(this.counters.maxRewindTicks, depth),
    };
    return depth;
  }
}