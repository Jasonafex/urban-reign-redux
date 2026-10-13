/**
 * The frame-data table — every move in the game, in one flat, immutable list.
 *
 * The numbers here are the *declared* frame contract. The sim does not read them to count
 * frames — it runs its own state machine, and `tools/feel-report.mjs` measures the result.
 * Any divergence between these declarations and measured frames fails gate 4.
 *
 * Frame convention (measured in whole ticks, 60Hz):
 *   - `startup`  = ticks from the accepting input tick until the first tick the hitbox is live.
 *   - `active`   = number of consecutive ticks the hitbox stays live.
 *   - `recovery` = ticks after the last active tick until the fighter is actionable again.
 *
 * Two families live in this table:
 *   - `BASELINE_MOVES`, the Phase 0 generic shapes (jab / poke / kick / sweep / launcher / heavy
 *     / two grabs / reversal / three SPA tiers / wall splat). They have no character attached and
 *     exist so the deterministic harnesses have something character-independent to drive.
 *   - `ARCHETYPE_MOVES`, the character tables ported from `runtime/combat-trial13` in
 *     `archetypes.ts`. These extend the baseline rather than replacing it: the report and the
 *     determinism suite walk `MOVESET` wholesale, so both families are checked by the same gates.
 */

import { ARCHETYPE_MOVES } from './archetypes';
import { move, totalFrames, type MoveDef } from './defs';

export type {
  ChainMode,
  GuardLevel,
  MoveDef,
  MoveKind,
  MoveOrigin,
  MoveStance,
} from './defs';
export { totalFrames, hitAdvantage, blockAdvantage } from './defs';

export const BASELINE_MOVES: readonly MoveDef[] = Object.freeze([
  move({
    id: 'jab', name: 'Jab', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 4, active: 2, recovery: 8, hitstop: 8,
    damage: 18, hitstun: 12, blockstun: 10,
    reach: 1.2, knockback: 60, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'straight', name: 'Straight', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 7, active: 3, recovery: 12, hitstop: 10,
    damage: 26, hitstun: 16, blockstun: 13,
    reach: 1.4, knockback: 90, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'kick', name: 'Side Kick', stance: 'side', kind: 'strike', guard: 'high',
    startup: 9, active: 3, recovery: 15, hitstop: 11,
    damage: 32, hitstun: 18, blockstun: 15,
    reach: 1.7, knockback: 130, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'low_sweep', name: 'Low Sweep', stance: 'down', kind: 'sweep', guard: 'low',
    startup: 11, active: 3, recovery: 20, hitstop: 12,
    damage: 30, hitstun: 18, blockstun: 14,
    reach: 1.6, knockback: 70, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'uppercut', name: 'Rising Uppercut', stance: 'up', kind: 'launcher', guard: 'mid',
    startup: 8, active: 4, recovery: 24, hitstop: 14,
    damage: 34, hitstun: 22, blockstun: 16,
    reach: 1.3, knockback: 180, knockdown: true, launcher: true, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'heavy', name: 'Heavy Swing', stance: 'neutral', kind: 'strike', guard: 'high',
    startup: 16, active: 5, recovery: 26, hitstop: 18,
    damage: 62, hitstun: 34, blockstun: 22,
    reach: 1.9, knockback: 240, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'grab_high', name: 'High Grab', stance: 'neutral', kind: 'grab', guard: 'throw',
    startup: 6, active: 2, recovery: 20, hitstop: 16,
    damage: 45, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'grab_low', name: 'Low Grab', stance: 'down', kind: 'grab', guard: 'throw',
    startup: 9, active: 2, recovery: 22, hitstop: 16,
    damage: 40, hitstun: 0, blockstun: 0,
    reach: 1.1, knockback: 0, knockdown: true, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'reversal', name: 'Reversal Counter', stance: 'neutral', kind: 'reversal', guard: 'high',
    startup: 5, active: 2, recovery: 30, hitstop: 20,
    damage: 55, hitstun: 28, blockstun: 20,
    reach: 1.5, knockback: 200, knockdown: false, launcher: false, spaCost: 0, spaTier: 0,
    origin: 'baseline',
  }),
  move({
    id: 'spa1', name: 'SPA 1 — Lethal Strike', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 10, active: 8, recovery: 30, hitstop: 20,
    damage: 140, hitstun: 40, blockstun: 20,
    reach: 2.2, knockback: 300, knockdown: false, launcher: false, spaCost: 50, spaTier: 1,
    origin: 'baseline',
  }),
  move({
    id: 'spa2', name: 'SPA 2 — Crowd Clearer', stance: 'neutral', kind: 'special', guard: 'high',
    startup: 14, active: 10, recovery: 34, hitstop: 16,
    damage: 120, hitstun: 30, blockstun: 26,
    reach: 3.2, knockback: 340, knockdown: true, launcher: false, spaCost: 100, spaTier: 2,
    origin: 'baseline',
  }),
  move({
    id: 'wall_splat', name: 'Wall Splat', stance: 'side', kind: 'special', guard: 'unblockable',
    startup: 12, active: 4, recovery: 28, hitstop: 22,
    damage: 78, hitstun: 30, blockstun: 16,
    reach: 1.5, knockback: 420, knockdown: true, launcher: false, spaCost: 25, spaTier: 3,
    origin: 'baseline',
  }),
]);

/** Baseline plus every archetype move. The one list both gates walk. */
export const MOVESET: readonly MoveDef[] = Object.freeze([
  ...BASELINE_MOVES,
  ...ARCHETYPE_MOVES,
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

export { move };

/**
 * The move and every automatic link that follows it, in execution order.
 *
 * Hit-confirm links are deliberately *not* included: they only run on a second input, so they
 * are not part of a single press's frame budget. This is the function that keeps the frame gates
 * honest now that one button can be several contacts.
 */
export function automaticChain(def: MoveDef): readonly MoveDef[] {
  const chain: MoveDef[] = [def];
  let current = def;
  // Bounded by the table, not by hope: a cycle in the data would otherwise hang the report.
  for (let guard = 0; guard < MOVESET.length; guard += 1) {
    if (current.chainNextMode !== 'automatic' || current.chainNext === null) {
      break;
    }
    const next = MOVES_BY_ID.get(current.chainNext);
    if (next === undefined) {
      break;
    }
    chain.push(next);
    current = next;
  }
  return chain;
}

/** Frames a single button press occupies on a whiff, including its automatic links. */
export function chainFrameBudget(def: MoveDef): number {
  return automaticChain(def).reduce((sum, link) => sum + totalFrames(link), 0);
}

/**
 * Hitstop a full-contact version of this button press costs. One press that lands N contacts is
 * frozen N times, so the busy window is frames + every link's hitstop.
 */
export function chainHitstopBudget(def: MoveDef): number {
  return automaticChain(def).reduce((sum, link) => sum + link.hitstop, 0);
}

/** Total damage a full-contact version of this button press deals to one victim. */
export function chainDamageBudget(def: MoveDef): number {
  return automaticChain(def).reduce((sum, link) => sum + link.damage, 0);
}