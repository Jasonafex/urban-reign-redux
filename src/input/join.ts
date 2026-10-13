/**
 * JoinManager — who is playing, on what, in which slot.
 *
 * A living-room match has no lobby: pads arrive when someone plugs them in, a second player sits
 * down at the keyboard mid-match, and a phone joins over the house LAN by touching the screen. This
 * manager turns all of that into a stable `FrameInput[4]` for `MatchRunner.fixedUpdate`.
 *
 * Two properties matter more than the allocation policy itself:
 *
 *   1. **A resting device never claims a slot.** Four pads plugged in and sitting on a shelf are not
 *      four players; the join signal is *activity*, so a slot is only ever taken by a device that
 *      has been touched. This is also what keeps a pad from stealing the slot of a player who put
 *      their controller down.
 *
 *   2. **Slots are sticky.** A device that loses a poll (a pad that went to sleep, a browser that
 *      briefly reports no gamepads) keeps its slot for `GAMEPAD_LOSS_POLLS` polls before being
 *      dropped. Releasing on the first empty poll would hand a player's fighter to somebody else
 *      mid-string, which is the one thing a brawler must never do.
 *
 * The manager depends on the *shape* of its sources (`GamepadSampler`, `KeyboardSampler`,
 * `TouchSampler`) rather than on the classes that implement them. That keeps `src/input/` free of
 * any dependency on `src/ui/`, so the touch overlay's DOM never reaches the input graph — and it is
 * why the headless suite can drive this file with plain objects.
 */

import { InputHistory } from './buffer';
import type { KeyboardState } from './keyboard';
import type { GamepadSample } from './gamepad';
import { MAX_GAMEPADS } from './gamepad';
import {
  NEUTRAL_CONTROL,
  type ControlState,
} from './layout';
import { NEUTRAL_INPUT, type FrameInput } from '../sim/runner';

/** Fighters a match supports (AGENTS.md §5: four simultaneous combatants). */
export const MAX_PLAYER_SLOTS = 4;

/**
 * Consecutive polls a claimed gamepad may be missing before its slot is released.
 *
 * Chrome empties `getGamepads()` for a frame or two whenever a pad sleeps, and a wireless pad drops
 * out constantly. Three polls is ~50ms: long enough to ride out the flicker, short enough that a
 * genuinely unplugged pad frees its slot before anyone notices.
 */
export const GAMEPAD_LOSS_POLLS = 3;

export type JoinKind = 'gamepad' | 'keyboard' | 'touch' | 'bot' | 'empty';

export interface PlayerSlot {
  readonly slot: number;
  readonly kind: JoinKind;
  /** Gamepad index, keyboard layout id, or -1. Identifies *which* device owns the slot. */
  readonly deviceId: string;
  readonly label: string;
  /** False for bot fill. */
  readonly human: boolean;
  /** Tick the device was claimed on. */
  readonly joinedTick: number;
}

export type JoinEventKind = 'join' | 'leave' | 'release';

export interface JoinEvent {
  readonly type: JoinEventKind;
  readonly slot: number;
  readonly kind: JoinKind;
  readonly label: string;
}

/** Anything that can report connected pads. Implemented by `GamepadSource`. */
export interface GamepadSampler {
  poll(): readonly GamepadSample[];
}

/** Anything that can report per-layout keyboard state. Implemented by `KeyboardSource`. */
export interface KeyboardSampler {
  poll(): readonly KeyboardState[];
}

/** The pure half of the touch controller: activity plus a control sample. */
export interface TouchSampler {
  readonly active: boolean;
  control(): ControlState;
}

export interface JoinManagerOptions {
  readonly maxSlots?: number;
  /**
   * How many slots bots fill once humans have claimed what they want.
   *
   * A bot slot holds neutral input: the fighter exists, holds a corner and can be fought, but does
   * not act. Shipping a real CPU opponent is a Phase 3 system, and a fake one that flails would
   * break the determinism contract this engine is built on, so the fill stays honest about what it
   * is instead of pretending to be an AI.
   */
  readonly botFill?: number;
  readonly gamepads?: GamepadSampler | null;
  readonly keyboard?: KeyboardSampler | null;
  readonly touch?: TouchSampler | null;
}

interface SlotRecord {
  kind: JoinKind;
  deviceId: string;
  label: string;
  human: boolean;
  joinedTick: number;
  /** Consecutive polls the device has been missing. Only gamepads are debounced. */
  misses: number;
  history: InputHistory;
}

export class JoinManager {
  readonly maxSlots: number;

  private readonly records: SlotRecord[];
  private readonly byDevice = new Map<string, number>();
  private readonly gamepads: GamepadSampler | null;
  private readonly keyboard: KeyboardSampler | null;
  private readonly touch: TouchSampler | null;
  private botFill: number;
  private tick = -1;
  private controls = new Map<number, ControlState>();

  constructor(options: JoinManagerOptions = {}) {
    this.maxSlots = Math.min(Math.max(options.maxSlots ?? MAX_PLAYER_SLOTS, 1), MAX_PLAYER_SLOTS);
    this.gamepads = options.gamepads ?? null;
    this.keyboard = options.keyboard ?? null;
    this.touch = options.touch ?? null;
    this.botFill = clampFill(options.botFill ?? 0, this.maxSlots);
    this.records = Array.from({ length: this.maxSlots }, (_, slot) => emptyRecord(slot));
  }

  /** Current tick, as of the last `poll()`/`frameInputs()`. */
  get currentTick(): number {
    return this.tick;
  }

  /** Slots, in slot order. Unclaimed slots report `kind: 'empty'`. */
  get slots(): readonly PlayerSlot[] {
    return this.records.map((record, slot) => toPlayerSlot(slot, record));
  }

  /** Slots with a live device behind them. */
  get joinedCount(): number {
    return this.records.reduce((count, record) => (record.kind === 'empty' ? count : count + 1), 0);
  }

  /** Slots driven by a human device (not bot fill). */
  get humanCount(): number {
    return this.records.reduce(
      (count, record) => (record.kind !== 'empty' && record.human ? count + 1 : count),
      0,
    );
  }

  /** How many bot slots bot fill is holding open. */
  setBotFill(count: number): void {
    this.botFill = clampFill(count, this.maxSlots);
  }

  get botsWanted(): number {
    return this.botFill;
  }

  /**
   * Observe the devices and reconcile the slot table.
   *
   * `tick` is the tick that is about to be simulated, and it is what a fresh claim records as its
   * join tick — join bookkeeping and simulation time share one clock, so a slot table can be
   * compared against a replay without a second timeline.
   *
   * Claim order is fixed — gamepads by index, then keyboard layouts in declaration order, then
   * touch — so two peers running the same code and the same devices allocate the same slots, which
   * is what lets the rollback netcode in Phase 3 agree on who is in which slot.
   *
   * Returns the join/leave events this poll produced, for the HUD and for the test suite.
   */
  poll(tick: number = this.tick + 1): readonly JoinEvent[] {
    this.tick = tick;
    const events: JoinEvent[] = [];
    const controls = new Map<number, ControlState>();

    if (this.gamepads !== null) {
      const samples = this.gamepads.poll();
      const seen = new Set<string>();
      for (const sample of samples) {
        if (sample.index >= MAX_GAMEPADS) {
          continue;
        }
        const deviceId = `gamepad:${sample.index}`;
        seen.add(deviceId);
        const slot = this.byDevice.get(deviceId);
        if (slot !== undefined) {
          const record = this.records[slot];
          if (record !== undefined) {
            record.misses = 0;
            controls.set(slot, sample.control);
          }
          continue;
        }
        if (!sample.active) {
          continue; // a resting pad is not a player
        }
        const claimed = this.claim('gamepad', deviceId, `${deviceId} · ${sample.id}`);
        if (claimed >= 0) {
          controls.set(claimed, sample.control);
          events.push(joinEvent('join', claimed, this.records[claimed] as SlotRecord));
        }
      }
      this.releaseMissing('gamepad', seen, controls, events);
    }

    if (this.keyboard !== null) {
      for (const state of this.keyboard.poll()) {
        const deviceId = `keyboard:${state.layout.id}`;
        const slot = this.byDevice.get(deviceId);
        if (slot !== undefined) {
          controls.set(slot, state.control);
          continue;
        }
        if (!state.active) {
          continue;
        }
        const claimed = this.claim('keyboard', deviceId, state.layout.label);
        if (claimed >= 0) {
          controls.set(claimed, state.control);
          events.push(joinEvent('join', claimed, this.records[claimed] as SlotRecord));
        }
      }
    }

    if (this.touch !== null) {
      const deviceId = 'touch:0';
      const control = this.touch.active ? this.touch.control() : NEUTRAL_CONTROL;
      const slot = this.byDevice.get(deviceId);
      if (slot !== undefined) {
        controls.set(slot, control);
      } else if (this.touch.active) {
        const claimed = this.claim('touch', deviceId, 'P4 · Touch');
        if (claimed >= 0) {
          controls.set(claimed, control);
          events.push(joinEvent('join', claimed, this.records[claimed] as SlotRecord));
        }
      }
    }

    this.controls = controls;
    this.fillBots(events);
    return events;
  }

  /**
   * Record this tick's controls into each slot's history and build the sim's input array.
   *
   * A slot with no device yields `NEUTRAL_INPUT` — the fighter still exists in the hash and is
   * still simulated, which is exactly what the determinism suite needs when three of four slots
   * are empty.
   */
  frameInputs(tick: number): readonly FrameInput[] {
    this.tick = tick;
    const inputs: FrameInput[] = [];
    for (let slot = 0; slot < this.maxSlots; slot += 1) {
      const record = this.records[slot] as SlotRecord;
      if (record.kind === 'empty') {
        record.history.reset();
        inputs.push({ ...NEUTRAL_INPUT });
        continue;
      }
      record.history.record(this.controls.get(slot) ?? NEUTRAL_CONTROL, tick);
      inputs.push(record.history.frameInput(tick));
    }
    return inputs;
  }

  /**
   * Tell each slot's history whether the sim took the press it was handed.
   *
   * This is the whole reason the input layer can buffer: a press made during recovery is kept and
   * re-offered until `accepted` is true, which is what makes a five-link string land instead of
   * eating the press that started it.
   */
  settle(tick: number, accepted: readonly boolean[]): void {
    for (let slot = 0; slot < this.maxSlots; slot += 1) {
      const record = this.records[slot] as SlotRecord;
      if (record.kind === 'empty') {
        continue;
      }
      record.history.settle(accepted[slot] === true, tick);
    }
  }

  /**
   * Whether this slot's owner pressed target switch on `tick`.
   *
   * The sim has no manual target-switch input yet — `targetLockedSlot` is written by contact in
   * `resolveHit` — so this is surfaced as a HUD event rather than smuggled into `FrameInput` as a
   * field the sim would ignore. Cycling the lock itself is a Phase 3 combat change.
   */
  targetSwitchPressed(slot: number, tick: number): boolean {
    const record = this.records[slot];
    return record !== undefined && record.kind !== 'empty'
      ? record.history.pressed('targetSwitch', tick)
      : false;
  }

  /** The control sample a slot is holding this tick. */
  controlFor(slot: number): ControlState {
    return this.controls.get(slot) ?? NEUTRAL_CONTROL;
  }

  /** Free a slot deliberately (a player standing up). Clears its buffered presses too. */
  release(slot: number, reason: JoinEventKind = 'release'): JoinEvent | null {
    const record = this.records[slot];
    if (record === undefined || record.kind === 'empty') {
      return null;
    }
    const event = joinEvent(reason, slot, record);
    this.clearSlot(record);
    return event;
  }

  /** Drop every device, human and bot alike. */
  reset(): void {
    for (const record of this.records) {
      this.clearSlot(record);
    }
    this.controls = new Map<number, ControlState>();
  }

  // -------------------------------------------------------------------------------------------

  private claim(kind: JoinKind, deviceId: string, label: string): number {
    if (this.byDevice.has(deviceId)) {
      return -1;
    }
    const slot = this.records.findIndex((record) => record.kind === 'empty');
    if (slot < 0) {
      // More than four players pressed start. The match still runs on the four slots that exist;
      // the overflow device is simply not seated, and it will claim a slot the moment one frees.
      return -1;
    }
    const record = this.records[slot] as SlotRecord;
    record.kind = kind;
    record.deviceId = deviceId;
    record.label = label;
    record.human = true;
    record.joinedTick = this.tick;
    record.misses = 0;
    // A new occupant never inherits the previous one's buffered presses: a slot handed from a
    // disconnected pad to a keyboard must not fire the pad's last input.
    record.history.reset();
    this.byDevice.set(deviceId, slot);
    return slot;
  }

  /** Debounced release for devices that can vanish between polls (gamepads). */
  private releaseMissing(
    family: JoinKind,
    seen: ReadonlySet<string>,
    controls: Map<number, ControlState>,
    events: JoinEvent[],
  ): void {
    for (let slot = 0; slot < this.maxSlots; slot += 1) {
      const record = this.records[slot] as SlotRecord;
      if (record.kind !== family || seen.has(record.deviceId)) {
        continue;
      }
      record.misses += 1;
      if (record.misses < GAMEPAD_LOSS_POLLS) {
        // Hold the slot — and keep feeding neutral input, so the fighter stands still rather than
        // freezing mid-move with the last stick position still applied.
        controls.set(slot, NEUTRAL_CONTROL);
        continue;
      }
      events.push(joinEvent('leave', slot, record));
      this.clearSlot(record);
    }
  }

  private fillBots(events: JoinEvent[]): void {
    let bots = this.records.reduce(
      (count, record) => (record.kind === 'bot' ? count + 1 : count),
      0,
    );
    while (bots < this.botFill) {
      const slot = this.records.findIndex((record) => record.kind === 'empty');
      if (slot < 0) {
        return;
      }
      const record = this.records[slot] as SlotRecord;
      record.kind = 'bot';
      record.deviceId = `bot:${slot}`;
      record.label = `CPU ${slot + 1}`;
      record.human = false;
      record.joinedTick = this.tick;
      record.misses = 0;
      record.history.reset();
      bots += 1;
      events.push(joinEvent('join', slot, record));
    }
  }

  private clearSlot(record: SlotRecord): void {
    if (record.kind !== 'empty') {
      this.byDevice.delete(record.deviceId);
    }
    // Mutated in place rather than replaced: callers hold a reference to this record (to read the
    // label off it after the release), and swapping the object out from under them is how a slot
    // ends up labelled with the previous occupant's device.
    Object.assign(record, emptyRecord(record.history.slot));
  }
}

function emptyRecord(slot: number): SlotRecord {
  return {
    kind: 'empty',
    deviceId: '',
    label: '',
    human: false,
    joinedTick: -1,
    misses: 0,
    history: new InputHistory(slot),
  };
}

function toPlayerSlot(slot: number, record: SlotRecord): PlayerSlot {
  return {
    slot,
    kind: record.kind,
    deviceId: record.deviceId,
    label: record.label,
    human: record.human,
    joinedTick: record.joinedTick,
  };
}

function joinEvent(type: JoinEventKind, slot: number, record: SlotRecord): JoinEvent {
  return { type, slot, kind: record.kind, label: record.label };
}

function clampFill(count: number, maxSlots: number): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(count), maxSlots);
}