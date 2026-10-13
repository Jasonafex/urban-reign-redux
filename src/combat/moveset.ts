/**
 * Phase 0 baseline MOVESET — pure data, no behaviour.
 *
 * AGENTS.md §5: directional branching (Neutral / Up / Down / Side), target lock,
 * high/low guards, grabs and Special Arts all descend from one table like this.
 * The numbers below are the *declared* frame contract. The sim does not read them to
 * count frames — it runs its own state machine and `tools/feel-report.mjs` measures the
 * result. Any divergence between these declarations and measured frames fails gate 4.
 *
 * Frame convention (measured in whole ticks, 60Hz):
 *   - `startup`  = ticks from the accepting input tick until the first tick the hitbox is live.
 *   - `active`   = number of consecutive ticks the hitbox stays live.
 *   - `recovery` = ticks after the last active tick until the fighter is actionable again.
 *
 * This is a *baseline* table: enough distinct shapes (jab / poke / kick / low sweep /
 * launcher / heavy / two grabs / reversal / three SPA tiers / wall splat) to give the
 * determinism and feel gates something real to verify. Archetype-specific tables land in
 * later phases and extend this one rather than replacing it.
 */

export type MoveStance = 'neutral' | 'up' | 'down' | 'side';
export type MoveKind = 'strike' | 'low' | 'launcher' | 'sweep' | 'grab' | 'reversal' | 'special';
export type GuardLevel = 'high' | 'mid' | 'low' | 'unblockable' | 'throw';

export interface MoveDef {
  readonly id: string;
  readonly name: string;
  readonly stance: MoveStance;
  readonly kind: MoveKind;
  /** Which guard direction beats this move; drives high/low dodge reads. */
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
}

const move = (def: MoveDef): MoveDef => Object.freeze(def);

export const MOVESET: readonly MoveDef[] = Object.freeze([
  move({
    id: 'jab', name: 'Jab', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 4, active: 2, recovery: 8, hitstop: 8,
    damage: 18, hitstun: 12, blockstun: 10,
    reach: 1.2, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'straight', name: 'Straight', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 7, active: 3, recovery: 12, hitstop: 10,
    damage: 26, hitstun: 16, blockstun: 13,
    reach: 1.4, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'kick', name: 'Side Kick', stance: 'side', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 15, hitstop: 11,
    damage: 32, hitstun: 18, blockstun: 15,
    reach: 1.7, knockback: 130, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'low_sweep', name: 'Low Sweep', stance: 'down', kind: 'sweep', guard: 'low',
    startup: 11, active: 3, recovery: 20, hitstop: 12,
    damage: 30, hitstun: 18, blockstun: 14,
    reach: 1.6, knockback: 70, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'uppercut', name: 'Rising Uppercut', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 8, active: 4, recovery: 24, hitstop: 14,
    damage: 34, hitstun: 22, blockstun: 16,
    reach: 1.3, knockback: 180, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'heavy', name: 'Heavy Swing', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 16, active: 5, recovery: 26, hitstop: 18,
    damage: 62, hitstun: 34, blockstun: 22,
    reach: 1.9, knockback: 240, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'grab_high', name: 'High Grab', stance: 'neutral', kind: 'grab', guard: 'throw',
    startup: 6, active: 2, recovery: 20, hitstop: 16,
    damage: 45, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'grab_low', name: 'Low Grab', stance: 'down', kind: 'grab', guard: 'throw',
    startup: 9, active: 2, recovery: 22, hitstop: 16,
    damage: 40, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'reversal', name: 'Reversal Counter', stance: 'neutral', kind: 'reversal', guard: 'high',
    startup: 5, active: 2, recovery: 30, hitstop: 20,
    damage: 55, hitstun: 28, blockstun: 20,
    reach: 1.5, knockback: 200, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
  }),
  move({
    id: 'spa1', name: 'SPA 1 — Lethal Strike', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 10, active: 8, recovery: 30, hitstop: 20,
    damage: 140, hitstun: 40, blockstun: 20,
    reach: 2.2, knockback: 300, knockdown: false, launcher: false, spaCost: 50, spaTier: 1,
  }),
  move({
    id: 'spa2', name: 'SPA 2 — Crowd Clearer', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 14, active: 10, recovery: 34, hitstop: 16,
    damage: 120, hitstun: 30, blockstun: 26,
    reach: 3.2, knockback: 340, knockdown: true, launcher: false, spaCost: 100, spaTier: 2,
  }),
  move({
    id: 'wall_splat', name: 'Wall Splat', stance: 'side', kind: 'special', guard: 'unblockable',
    startup: 12, active: 4, recovery: 28, hitstop: 22,
    damage: 78, hitstun: 30, blockstun: 16,
    reach: 1.5, knockback: 420, knockdown: true, launcher: false, spaCost: 25, spaTier: 3,
  }),
]);

const MOVES_BY_ID: ReadonlyMap<string, MoveDef> = new Map(MOVESET.map((m) => [m.id, m]));

/** Lookup a move by id. Returns undefined for unknown ids — callers must handle it. */
export function getMove(id: string): MoveDef | undefined {
  return MOVES_BY_ID.get(id);
}

/** Lookup a move by id, throwing on unknown ids. Use at data-definition time, never mid-tick. */
export function requireMove(id: string): MoveDef {
  const found = MOVES_BY_ID.get(id);
  if (found === undefined) {
    throw new Error(`Unknown move id: ${id}`);
  }
  return found;
}

/** Total frames a move occupies from input to actionable again (no cancels in Phase 0). */
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
 * block scenario in Phase 0 and report 0 so the report never prints a bogus number.
 */
export function blockAdvantage(def: MoveDef): number {
  if (def.guard === 'throw' || def.guard === 'unblockable' || def.knockdown) {
    return 0;
  }
  return def.blockstun - (def.active + def.recovery);
}