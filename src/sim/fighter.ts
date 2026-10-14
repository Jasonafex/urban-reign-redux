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

import { getArchetype } from '../combat/archetypes';
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
  | 'getup'
  /** High/low dodge. `stateFrame` is the window counter — see `DODGE_*` in `src/config.ts`. */
  | 'dodge_high'
  | 'dodge_low'
  /** Holding a charged special (Jack-5's five-level Gigaton). */
  | 'charging';

/** High guard covers mid and high strikes; low guard covers sweeps. */
export type GuardInput = 'none' | 'high' | 'low';

export interface Fighter {
  /** Player slot index. Also the index into the per-tick input array. */
  slot: number;
  archetypeId: string;
  /**
   * Side this fighter fights for: 0 for Team A (slots 0 and 2), 1 for Team B (slots 1 and 3),
   * or null in a Free-For-All where every pair of fighters is hostile.
   *
   * Phase 5 added this as a *fighter* field rather than a match-side table, because team
   * membership changes what a hitbox is allowed to reach (§3.2: anything that can influence a
   * future tick belongs in `STATE_HASH_FIELDS`, and this one does). A 2v2 that kept its teams
   * outside the world state would hash identically whether teammates were fighting each other or
   * not, and a rollback would happily rewind into the wrong match.
   */
  team: 0 | 1 | null;

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

  /**
   * Chain this fighter is currently branched into, or ''. Set when a hit-confirm link connects:
   * it is the ticket that lets the next link be pressed in, and it is cleared as soon as the
   * window lapses or a different move is started.
   */
  chainId: string;
  /**
   * The one move this fighter may cancel into next, or ''.
   *
   * Deliberately a single move rather than "any link of the chain": a confirm has to buy the
   * *next* hit. Letting a player jump straight to a five-hit string's finisher would let them skip
   * four links by mashing, which is the opposite of what a confirm is for.
   */
  branchTarget: string;
  /** Ticks left in the hit-confirm cancel window. 0 means no branch is available. */
  chainWindow: number;
  /** Ticks left of the post-whiff lockout, during which no new chain may be started. */
  whiffLockout: number;
  /** Ticks left before this fighter may dodge again. */
  dodgeCooldown: number;
  /** Ticks the current charge hold has accumulated. */
  chargeFrames: number;
  /**
   * True once the charge button has been released. The release is buffered until the first windup
   * completes, which is what makes the windup a commitment instead of a suggestion.
   */
  chargeRelease: boolean;
  /**
   * Charge tier 1..5 of the last charge reached, 0 when no charged move has been thrown this
   * match. Drives the Gigaton's damage tier and is what the HUD reads.
   */
  chargeLevel: number;
}

/**
 * Every field that can influence a future tick. Order is fixed so the canonical
 * serialisation is stable; `runner.stateHash()` walks this list twice (slot order).
 */
export const STATE_HASH_FIELDS: readonly (keyof Fighter)[] = Object.freeze([
  'slot',
  'archetypeId',
  'team',
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
  'chainId',
  'branchTarget',
  'chainWindow',
  'whiffLockout',
  'dodgeCooldown',
  'chargeFrames',
  'chargeRelease',
  'chargeLevel',
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
  team: 0 | 1 | null = null,
): Fighter {
  // An unknown archetype id (the frame-measurement rig uses `'frame_probe'`, the harnesses use
  // `'probe'`) must still produce a legal fighter, so every archetype field falls back to the
  // Phase 0 default rather than throwing.
  const archetype = getArchetype(archetypeId);
  return {
    slot,
    archetypeId,
    team,
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
    health: archetype?.maxHealth ?? DEFAULT_MAX_HEALTH,
    maxHealth: archetype?.maxHealth ?? DEFAULT_MAX_HEALTH,
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
    chainId: '',
    branchTarget: '',
    chainWindow: 0,
    whiffLockout: 0,
    dodgeCooldown: 0,
    chargeFrames: 0,
    chargeRelease: false,
    chargeLevel: 0,
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
 *
 * Phase 1 opens exactly two windows into an existing move, and both are cancellations *out of*
 * a move that has already connected or *into* the next link of a string — never an arbitrary
 * cancel. `startup`, `active` and every stun state still lock input out, which is what makes the
 * declared recovery frames measurable.
 */
export function isActionable(fighter: Fighter): boolean {
  if (fighter.eliminated || fighter.hitstop > 0) {
    return false;
  }
  return fighter.state === 'idle' || fighter.state === 'walk';
}