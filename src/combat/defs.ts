/**
 * Move definition — the shape every entry in the frame-data tables has.
 *
 * This module exists so `moveset.ts` (the baseline table) and `archetypes.ts` (the character
 * tables) can both build moves without importing each other. The dependency graph is a strict
 * one-way street: `defs` <- `archetypes` <- `moveset` <- `sim`. That matters because the tables
 * are initialised at module load: an `import` cycle between `moveset` and `archetypes` would work
 * by accident under hoisting and then break the moment the bundler's ordering changed, which is
 * exactly the class of bug that only shows up in the browser.
 *
 * AGENTS.md §3.1: this is pure data. No DOM, no clock, no randomness.
 */

export type MoveStance = 'neutral' | 'up' | 'down' | 'side';
export type MoveKind = 'strike' | 'low' | 'launcher' | 'sweep' | 'grab' | 'reversal' | 'special';
export type GuardLevel = 'high' | 'mid' | 'low' | 'unblockable' | 'throw';

/**
 * How a move hands off to the next link of its chain.
 *
 *   - `none`        the link ends the chain.
 *   - `automatic`   the next link starts by itself when this one completes. This is the
 *                   spec.py rule "multiple source records in one group are automatic hits of one
 *                   animation": one button, several contacts, no second press.
 *   - `hitConfirm`  the next link only starts if this one actually connected, and only inside
 *                   the cancel window. Whiff and the chain is gone.
 */
export type ChainMode = 'none' | 'automatic' | 'hitConfirm';

/**
 * Where a move's numbers come from. Not cosmetic: the balance report and the test suite treat
 * `trial13` and `authored` differently, because only one of them has a traceable upstream.
 */
export type MoveOrigin =
  /** Phase 0 generic table — no character attached. */
  | 'baseline'
  /** Ported from `runtime/combat-trial13` (spec.py / gigaton_charge.py / bryan_spa.py / ...). */
  | 'trial13'
  /** Authored for this engine against AGENTS.md §5. No Trial 13 source exists for these. */
  | 'authored';

export interface MoveDef {
  readonly id: string;
  readonly name: string;
  readonly stance: MoveStance;
  readonly kind: MoveKind;
  /** Which guard direction beats this move; drives both blocking and high/low dodge reads. */
  readonly guard: GuardLevel;
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  /** Frames the attacker's own state is frozen on contact (both fighters). */
  readonly hitstop: number;
  readonly damage: number;
  readonly hitstun: number;
  readonly blockstun: number;
  /** Horizontal reach of the hitbox centre, in world units. */
  readonly reach: number;
  /** Knockback applied to the defender along the attacker's facing, subunits/tick. */
  readonly knockback: number;
  readonly knockdown: boolean;
  readonly launcher: boolean;
  /** SPA gauge cost as a whole percentage of SPA_MAX. */
  readonly spaCost: number;
  /** SPA tier, or 0 for ordinary moves. */
  readonly spaTier: 0 | 1 | 2 | 3;

  /** Id of the next link of this move's chain, or null when it ends the chain. */
  readonly chainNext: string | null;
  /** How `chainNext` is entered. */
  readonly chainNextMode: ChainMode;
  /** True for the 360 crowd-clearers: one hitbox resolves against *every* live opponent. */
  readonly hitsAll: boolean;
  /**
   * Aerial strike: the hitbox only reaches a target that is off the ground. These are the only
   * moves that can juggle, so they are the only ones `JUGGLE_LIMIT` applies to.
   */
  readonly airOnly: boolean;
  /** Leaves the opponent reeling without knocking them down — what keeps a string alive. */
  readonly stagger: boolean;
  /** Charge level 1..5 for the five-tier Gigaton; 0 for everything else. */
  readonly chargeLevel: 0 | 1 | 2 | 3 | 4 | 5;
  /** Which limb animates the strike ('LH','RH','LF','RF'), ported from spec.py. */
  readonly limb: string;
  /** The original animation record id in the Trial 13 ISO, or 0 when there is no upstream. */
  readonly sourceActionId: number;
  /** The character the animation was taken from, or '' when there is no upstream. */
  readonly source: string;
  readonly origin: MoveOrigin;
}

/** Fields `move()` fills in when a table entry does not care to say. */
const DEFAULTS = {
  chainNext: null,
  chainNextMode: 'none',
  hitsAll: false,
  airOnly: false,
  stagger: false,
  chargeLevel: 0,
  limb: '',
  sourceActionId: 0,
  source: '',
  origin: 'authored',
} as const;

/** Fields a table entry may override; everything else comes from `DEFAULTS`. */
export type MoveOverrides = Partial<MoveDef>;

function freezeMove(def: MoveDef): MoveDef {
  return Object.freeze(def);
}

/**
 * Build a frozen `MoveDef`, defaulting the Phase 1 fields.
 *
 * `id`, `name`, `stance`, `kind`, `guard`, `startup`, `active`, `recovery`, `hitstop`,
 * `damage`, `hitstun`, `blockstun`, `reach`, `knockback`, `knockdown`, `launcher`, `spaCost` and
 * `spaTier` have no sensible default — a move without damage or startup is a data bug, not a
 * shorthand — so they are required.
 */
export function move(def: MoveOverrides & Pick<
  MoveDef,
  | 'id'
  | 'name'
  | 'stance'
  | 'kind'
  | 'guard'
  | 'startup'
  | 'active'
  | 'recovery'
  | 'hitstop'
  | 'damage'
  | 'hitstun'
  | 'blockstun'
  | 'reach'
  | 'knockback'
  | 'knockdown'
  | 'launcher'
  | 'spaCost'
  | 'spaTier'
>): MoveDef {
  return freezeMove({
    ...DEFAULTS,
    ...def,
  } as MoveDef);
}

/** Total frames a move occupies from input to actionable again. */
export function totalFrames(def: MoveDef): number {
  return def.startup + def.active + def.recovery;
}

/**
 * Frame advantage of a move that is not blocked and does not knock down.
 * Positive = the attacker recovers first and may act again before the defender.
 * Throws and knockdowns report 0: they end in a knockdown rather than a hitstun race, so an
 * advantage number for them would be noise (the report prints "—" for those rows).
 */
export function hitAdvantage(def: MoveDef): number {
  if (def.guard === 'throw' || def.knockdown) {
    return 0;
  }
  return def.hitstun - (def.active + def.recovery);
}

/**
 * Frame advantage on block. Grabs, knockdowns and unblockables have no meaningful
 * block scenario and report 0 so the report never prints a bogus number.
 */
export function blockAdvantage(def: MoveDef): number {
  if (def.guard === 'throw' || def.guard === 'unblockable' || def.knockdown) {
    return 0;
  }
  return def.blockstun - (def.active + def.recovery);
}