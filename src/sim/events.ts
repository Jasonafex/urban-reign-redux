/**
 * Simulation event stream.
 *
 * AGENTS.md §3.1: the sim emits events and the presentation layer consumes them. Events are
 * plain frozen data — no DOM handles, no Three.js objects, nothing a Node runner cannot build.
 * `DodgeEvent` arrives with the high/low dodge work in a later phase; the union is the
 * contract the render/audio layers code against, so it is declared in full now.
 */

export interface HitEvent {
  readonly type: 'hit';
  readonly tick: number;
  readonly attackerSlot: number;
  readonly defenderSlot: number;
  readonly moveId: string;
  readonly damage: number;
  readonly hitstun: number;
  readonly blockstun: number;
  readonly hitstop: number;
  readonly guarded: boolean;
  readonly knockdown: boolean;
  readonly launcher: boolean;
  readonly distanceFp: number;
}

export interface WallImpactEvent {
  readonly type: 'wallImpact';
  readonly tick: number;
  readonly slot: number;
  readonly axis: 'x' | 'z';
  readonly speed: number;
}

export interface SpaEvent {
  readonly type: 'spa';
  readonly tick: number;
  readonly slot: number;
  readonly moveId: string;
  readonly tier: 1 | 2 | 3;
  readonly gaugeSpent: number;
  readonly gaugeRemaining: number;
}

/** A high/low dodge or evasive hop resolved on this tick (Phase 1). */
export interface DodgeEvent {
  readonly type: 'dodge';
  readonly tick: number;
  readonly slot: number;
  readonly direction: 'high' | 'low';
  readonly evadedMoveId: string | null;
}

export type SimEvent = HitEvent | WallImpactEvent | SpaEvent | DodgeEvent;

/** Narrow an event to a landed hit — the presentation layer's main consumer of the stream. */
export function isHit(event: SimEvent): event is HitEvent {
  return event.type === 'hit';
}