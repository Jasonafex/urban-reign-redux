/**
 * Fighter state — the authoritative simulation record for one combatant.
 *
 * Everything here is integer fixed-point (see `FP_SCALE` in `src/config.ts`) or an enum-like
 * string, so two machines running the same inputs produce the same numbers bit for bit.
 * `STATE_HASH_FIELDS` is the single source of truth for "what must be hashed": `stateHash()`
 * iterates it, and `test/determinism.test.mjs` iterates the same list to prove that leaving
 * any field out of the hash would break replay. If you add a field that can influence a
 * future tick, add it to that list in the same commit.
 */

import { DEFAULT_MAX_HEALTH, DEFAULT_SPA_MAX, FP_SCALE } from '../config';

export type FighterState =
  | 'idle'
  | 'walk'
  | 'startup'
  | 'active'
  | 'recovery'
  | 'hitstun'
  | 'blockstun'
  | 'launched'
  | 'down'
  | 'getup';

/** High guard covers mid and high strikes; low guard covers sweeps. */
export type GuardInput = 'none' | 'high' | 'low';

export interface Fighter {
  /** Player slot index. Also the index into the per-tick input array. */
  slot: number;
  archetypeId: string;

  /** Position in fixed-point subunits (1 unit == FP_SCALE). */
  x: number;
  y: number;
  z: number;
  /** Velocity in subunits per tick. */
  vx: number;
  vy: number;
  vz: number;

  facing: 1 | -1;
  state: FighterState;
  /** Ticks spent in the current `state`; reset by every transition. */
  stateFrame: number;

  /** Id of the move currently executing, or null when free. */
  currentMove: string | null;
  /** Ticks since the move was accepted. 0 on the accepting tick. */
  movePhaseFrame: number;

  health: number;
  maxHealth: number;
  spaMeter: number;
  spaMax: number;
  eliminated: boolean;

  juggleCount: number;
  /** Frames both fighters are frozen on contact; > 0 freezes this fighter's state machine. */
  hitstop: number;
  /** True only on the tick this fighter's hitbox connected. */
  hitConnect: boolean;
  /**
   * Set once the current move has connected. A hitbox may only make contact once per move
   * instance: without this, a hitstop-frozen attacker re-resolves the *same* active frame every
   * time the freeze lifts, and the pair locks in an endless freeze/contact cycle.
   */
  hitConsumed: boolean;
  stunRemaining: number;
  blockstunLeft: number;
  /** Slot of the fighter this one is locked on, or -1. */
  targetLockedSlot: number;
}

/**
 * Every field that can influence a future tick. Order is fixed so the canonical
 * serialisation is stable; `runner.stateHash()` walks this list twice (slot order).
 */
export const STATE_HASH_FIELDS: readonly (keyof Fighter)[] = Object.freeze([
  'slot',
  'archetypeId',
  'x',
  'y',
  'z',
  'vx',
  'vy',
  'vz',
  'facing',
  'state',
  'stateFrame',
  'currentMove',
  'movePhaseFrame',
  'health',
  'maxHealth',
  'spaMeter',
  'spaMax',
  'eliminated',
  'juggleCount',
  'hitstop',
  'hitConnect',
  'hitConsumed',
  'stunRemaining',
  'blockstunLeft',
  'targetLockedSlot',
]);

/**
 * Eight-way movement table in fixed-point subunits, keyed by "x,z" intent signs.
 * Baked literals rather than `Math.cos`/`Math.sin`: transcendental results are not
 * bit-identical across engines, and the sim must be. 724 ≈ round(1024 * √2/2).
 */
const DIR8: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  '0,0': [0, 0],
  '1,0': [FP_SCALE, 0],
  '1,1': [724, 724],
  '0,1': [0, FP_SCALE],
  '-1,1': [-724, 724],
  '-1,0': [-FP_SCALE, 0],
  '-1,-1': [-724, -724],
  '0,-1': [0, -FP_SCALE],
});

/** Snap a movement intent to the nearest of the eight fixed-point headings. */
export function directionFor(moveX: number, moveZ: number): readonly [number, number] {
  const ix = moveX > 0 ? 1 : moveX < 0 ? -1 : 0;
  const iz = moveZ > 0 ? 1 : moveZ < 0 ? -1 : 0;
  return DIR8[`${ix},${iz}`] ?? [0, 0];
}

export function createFighter(
  slot: number,
  archetypeId: string,
  x: number,
  z: number,
  facing: 1 | -1 = 1,
): Fighter {
  return {
    slot,
    archetypeId,
    x: Math.trunc(x),
    y: 0,
    z: Math.trunc(z),
    vx: 0,
    vy: 0,
    vz: 0,
    facing,
    state: 'idle',
    stateFrame: 0,
    currentMove: null,
    movePhaseFrame: 0,
    health: DEFAULT_MAX_HEALTH,
    maxHealth: DEFAULT_MAX_HEALTH,
    spaMeter: 0,
    spaMax: DEFAULT_SPA_MAX,
    eliminated: false,
    juggleCount: 0,
    hitstop: 0,
    hitConnect: false,
    hitConsumed: false,
    stunRemaining: 0,
    blockstunLeft: 0,
    targetLockedSlot: -1,
  };
}

/** Deep copy. `Fighter` holds only primitives, so a field-wise copy is a real copy. */
export function cloneFighter(fighter: Fighter): Fighter {
  return { ...fighter };
}

/** Transition helper: every state change resets the in-state tick counter. */
export function setState(fighter: Fighter, state: FighterState): void {
  fighter.state = state;
  fighter.stateFrame = 0;
}

/**
 * True when this fighter may start a new move this tick.
 * Phase 0 has no cancels: `recovery`, `startup`, `active` and every stun state all lock
 * input out until the state machine returns the fighter to `idle`/`walk`. That is what makes
 * the declared recovery frames in `MOVESET` measurable, and it is where cancel windows get
 * added later (a cancel would extend this predicate, never the frame contract).
 */
export function isActionable(fighter: Fighter): boolean {
  if (fighter.eliminated || fighter.hitstop > 0) {
    return false;
  }
  return fighter.state === 'idle' || fighter.state === 'walk';
}