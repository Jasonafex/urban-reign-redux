/**
 * MatchRunner — the deterministic 60Hz world.
 *
 * AGENTS.md §3.2: the simulation must be bit-identical across runs, platforms and display
 * refresh rates. That is enforced here by construction:
 *   - `fixedUpdate` advances exactly one tick and rejects any `dt` that is not 1/60, so a
 *     caller cannot smuggle a variable timestep into the tick path.
 *   - All motion is integer fixed-point; there is no `Date.now()`/`performance.now()` anywhere.
 *   - Iteration order is slot order, so the event stream is reproducible.
 *   - `stateHash()` covers every field in `STATE_HASH_FIELDS` — the inputs needed to predict
 *     a future tick are exactly the inputs needed to reproduce it.
 *
 * Tick order (fixed, and asserted by the determinism suite):
 *   1. consume inputs (a started move consumes its own tick)
 *   2. freeze/hitstop, advance state machines, integrate motion + arena clamp
 *   3. resolve live hitboxes, apply damage, stun, gauge and SPA events
 */

import {
  AIRBORNE_Y,
  ARENA_HALF_EXTENT,
  DT,
  FP_SCALE,
  GETUP_FRAMES,
  GRAVITY_PER_TICK,
  KNOCKDOWN_FRAMES,
  LAUNCH_VELOCITY,
  SPA_ON_HIT,
  SPA_ON_LAND,
  TICK_HZ,
  WALK_SPEED,
} from '../config';
import { getMove, totalFrames, type MoveDef } from '../combat/moveset';
import type { SimEvent } from './events';
import {
  STATE_HASH_FIELDS,
  cloneFighter,
  createFighter,
  directionFor,
  isActionable,
  setState,
  type Fighter,
  type GuardInput,
} from './fighter';

export interface FrameInput {
  /** Movement intent, each component in -1..1; snapped to the eight-way table. */
  moveX: number;
  moveZ: number;
  /** Attack to attempt this tick, or null. */
  attack: string | null;
  /** Guard held this tick. 'high' blocks mid/high strikes, 'low' blocks sweeps. */
  guard: GuardInput;
}

export const NEUTRAL_INPUT: FrameInput = Object.freeze({
  moveX: 0,
  moveZ: 0,
  attack: null,
  guard: 'none',
});

export function idleInput(overrides: Partial<FrameInput> = {}): FrameInput {
  return { ...NEUTRAL_INPUT, ...overrides };
}

export interface MatchSnapshot {
  readonly tick: number;
  readonly fighters: readonly Fighter[];
}

export interface FighterSpawn {
  readonly slot: number;
  readonly archetypeId: string;
  readonly x: number;
  readonly z: number;
  readonly facing?: 1 | -1;
}

/** Deterministic default roster for Phase 0: four combatants, Free-For-All. */
export function defaultSpawns(): FighterSpawn[] {
  const half = ARENA_HALF_EXTENT - 2;
  return [
    { slot: 0, archetypeId: 'street_brawler', x: -half * FP_SCALE, z: -half * FP_SCALE, facing: 1 },
    { slot: 1, archetypeId: 'parkour_thug', x: half * FP_SCALE, z: -half * FP_SCALE, facing: -1 },
    { slot: 2, archetypeId: 'pipe_enforcer', x: -half * FP_SCALE, z: half * FP_SCALE, facing: 1 },
    { slot: 3, archetypeId: 'blade_runner', x: half * FP_SCALE, z: half * FP_SCALE, facing: -1 },
  ];
}

const ARENA_LIMIT = (ARENA_HALF_EXTENT - 0.5) * FP_SCALE;

function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export class MatchRunner {
  readonly fighters: Fighter[];
  tick = 0;

  constructor(spawns: readonly FighterSpawn[] = defaultSpawns()) {
    this.fighters = spawns
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map((spawn) =>
        createFighter(
          spawn.slot,
          spawn.archetypeId,
          spawn.x * FP_SCALE,
          spawn.z * FP_SCALE,
          spawn.facing ?? 1,
        ),
      );
  }

  get aliveCount(): number {
    return this.fighters.reduce((count, fighter) => (fighter.eliminated ? count : count + 1), 0);
  }

  isMatchOver(): boolean {
    return this.aliveCount <= 1;
  }

  fighterAt(slot: number): Fighter | undefined {
    return this.fighters.find((fighter) => fighter.slot === slot);
  }

  /** Advance the world by exactly one tick. Throws on any non-1/60 `dt`. */
  fixedUpdate(dt: number = DT, inputs?: readonly FrameInput[]): SimEvent[] {
    if (!Number.isFinite(dt) || Math.abs(dt - DT) > 1e-9) {
      throw new RangeError(
        `MatchRunner.fixedUpdate advances whole ${TICK_HZ}Hz ticks; got dt=${dt}. ` +
          'Drive it from FixedStepAccumulator instead of passing elapsed time.',
      );
    }

    this.tick += 1;
    const events: SimEvent[] = [];
    for (const fighter of this.fighters) {
      fighter.hitConnect = false;
    }

    this.applyInputs(inputs, events);
    this.syncGuards(inputs);
    for (const fighter of this.fighters) {
      if (fighter.hitstop > 0) {
        fighter.hitstop -= 1;
        continue;
      }
      this.advanceState(fighter);
      this.integrateMotion(fighter, events);
    }

    for (const attacker of this.fighters) {
      if (
        attacker.hitstop > 0 ||
        attacker.state !== 'active' ||
        attacker.currentMove === null ||
        attacker.hitConsumed
      ) {
        continue;
      }
      const def = getMove(attacker.currentMove);
      if (def === undefined) {
        continue;
      }
      for (const defender of this.fighters) {
        if (defender === attacker) {
          continue;
        }
        if (this.resolveHit(attacker, defender, def, events)) {
          break; // one contact per active frame in Phase 0
        }
      }
    }

    return events;
  }

  /** Convenience wrapper for scripted scenarios: advance `count` ticks with a fixed input. */
  step(count: number, input: FrameInput = NEUTRAL_INPUT, perSlot?: readonly FrameInput[]): SimEvent[] {
    const collected: SimEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      const inputs = perSlot ?? this.fighters.map(() => input);
      collected.push(...this.fixedUpdate(DT, inputs));
    }
    return collected;
  }

  saveSnapshot(): MatchSnapshot {
    return { tick: this.tick, fighters: this.fighters.map(cloneFighter) };
  }

  restoreSnapshot(snapshot: MatchSnapshot): void {
    if (snapshot.fighters.length !== this.fighters.length) {
      throw new RangeError(
        `Snapshot has ${snapshot.fighters.length} fighters, runner has ${this.fighters.length}.`,
      );
    }
    this.tick = snapshot.tick;
    for (let i = 0; i < this.fighters.length; i += 1) {
      const source = snapshot.fighters[i];
      const target = this.fighters[i];
      if (source === undefined || target === undefined || source.slot !== target.slot) {
        throw new RangeError(`Snapshot fighter at index ${i} does not match runner slot order.`);
      }
      Object.assign(target, cloneFighter(source));
    }
  }

  /**
   * 32-bit FNV-1a over the canonical serialisation of every hashed field, in slot order.
   * Returns 8 lowercase hex characters.
   */
  stateHash(): string {
    const parts: string[] = [String(this.tick), String(this.fighters.length)];
    for (const fighter of this.fighters) {
      parts.push(STATE_HASH_FIELDS.map((field) => serializeField(fighter[field])).join('|'));
    }
    return fnv1a(parts.join('\n'));
  }

  private applyInputs(inputs: readonly FrameInput[] | undefined, events: SimEvent[]): void {
    for (const fighter of this.fighters) {
      if (!isActionable(fighter)) {
        continue;
      }
      const input = inputs?.[fighter.slot] ?? NEUTRAL_INPUT;
      if (input.attack !== null && input.attack !== undefined) {
        this.beginMove(fighter, input.attack, events);
        continue;
      }
      this.applyMovementIntent(fighter, input);
    }
  }

  private beginMove(fighter: Fighter, moveId: string, events: SimEvent[]): boolean {
    const def = getMove(moveId);
    if (def === undefined) {
      throw new RangeError(`Unknown move id requested: ${moveId}`);
    }
    if (def.spaCost > 0) {
      if (fighter.spaMeter < def.spaCost) {
        return false; // not enough gauge: the input is swallowed, no move starts
      }
      fighter.spaMeter -= def.spaCost;
      events.push({
        type: 'spa',
        tick: this.tick,
        slot: fighter.slot,
        moveId: def.id,
        tier: def.spaTier === 0 ? 1 : def.spaTier,
        gaugeSpent: def.spaCost,
        gaugeRemaining: fighter.spaMeter,
      });
    }
    fighter.currentMove = def.id;
    fighter.movePhaseFrame = 0;
    fighter.hitConsumed = false;
    setState(fighter, 'startup');
    return true;
  }

  private applyMovementIntent(fighter: Fighter, input: FrameInput): void {
    const [dirX, dirZ] = directionFor(input.moveX, input.moveZ);
    if (dirX === 0 && dirZ === 0) {
      fighter.vx = 0;
      fighter.vz = 0;
      if (fighter.state === 'walk') {
        setState(fighter, 'idle');
      }
      return;
    }
    fighter.vx = Math.trunc((dirX * WALK_SPEED) / FP_SCALE);
    fighter.vz = Math.trunc((dirZ * WALK_SPEED) / FP_SCALE);
    if (input.moveX > 0) {
      fighter.facing = 1;
    } else if (input.moveX < 0) {
      fighter.facing = -1;
    }
    if (fighter.state !== 'walk') {
      // Only re-enter the state when it actually changes, so `stateFrame` keeps counting
      // ticks spent walking instead of being reset every tick.
      setState(fighter, 'walk');
    }
  }

  private advanceState(fighter: Fighter): void {
    switch (fighter.state) {
      case 'startup':
      case 'active':
      case 'recovery': {
        const def = fighter.currentMove === null ? undefined : getMove(fighter.currentMove);
        if (def === undefined) {
          fighter.currentMove = null;
          setState(fighter, 'idle');
          return;
        }
        const phase = fighter.movePhaseFrame + 1;
        const total = totalFrames(def);
        if (phase >= total) {
          fighter.currentMove = null;
          fighter.movePhaseFrame = 0;
          setState(fighter, 'idle');
          return;
        }
        fighter.movePhaseFrame = phase;
        if (phase < def.startup) {
          setState(fighter, 'startup');
        } else if (phase < def.startup + def.active) {
          setState(fighter, 'active');
        } else {
          setState(fighter, 'recovery');
        }
        return;
      }
      case 'hitstun': {
        fighter.stunRemaining -= 1;
        fighter.stateFrame += 1;
        if (fighter.stunRemaining <= 0) {
          fighter.stunRemaining = 0;
          fighter.vx = 0;
          fighter.vz = 0;
          setState(fighter, 'idle');
        }
        return;
      }
      case 'blockstun': {
        fighter.blockstunLeft -= 1;
        fighter.stateFrame += 1;
        if (fighter.blockstunLeft <= 0) {
          fighter.blockstunLeft = 0;
          setState(fighter, 'idle');
        }
        return;
      }
      case 'launched': {
        fighter.stateFrame += 1;
        return;
      }
      case 'down': {
        if (fighter.stateFrame + 1 >= KNOCKDOWN_FRAMES) {
          setState(fighter, 'getup');
        } else {
          fighter.stateFrame += 1;
        }
        return;
      }
      case 'getup': {
        if (fighter.stateFrame + 1 >= GETUP_FRAMES) {
          setState(fighter, 'idle');
          fighter.targetLockedSlot = -1;
        } else {
          fighter.stateFrame += 1;
        }
        return;
      }
      case 'idle':
      case 'walk': {
        fighter.stateFrame += 1;
        return;
      }
      default: {
        const exhaustive: never = fighter.state;
        throw new Error(`Unhandled fighter state: ${String(exhaustive)}`);
      }
    }
  }

  private integrateMotion(fighter: Fighter, events: SimEvent[]): void {
    if (fighter.state === 'launched' || fighter.y > 0) {
      fighter.vy -= GRAVITY_PER_TICK;
      fighter.x += fighter.vx;
      fighter.z += fighter.vz;
      fighter.y += fighter.vy;
      if (fighter.y <= 0) {
        fighter.y = 0;
        fighter.vy = 0;
        fighter.vx = Math.trunc(fighter.vx / 2);
        fighter.vz = Math.trunc(fighter.vz / 2);
        if (fighter.state === 'launched') {
          setState(fighter, 'down');
        }
      }
    } else if (fighter.state !== 'idle') {
      fighter.x += fighter.vx;
      fighter.z += fighter.vz;
    }

    if (fighter.x > ARENA_LIMIT) {
      events.push({ type: 'wallImpact', tick: this.tick, slot: fighter.slot, axis: 'x', speed: Math.abs(fighter.vx) });
      fighter.x = ARENA_LIMIT;
      fighter.vx = -Math.trunc(Math.abs(fighter.vx) / 2);
    } else if (fighter.x < -ARENA_LIMIT) {
      events.push({ type: 'wallImpact', tick: this.tick, slot: fighter.slot, axis: 'x', speed: Math.abs(fighter.vx) });
      fighter.x = -ARENA_LIMIT;
      fighter.vx = Math.trunc(Math.abs(fighter.vx) / 2);
    }

    if (fighter.z > ARENA_LIMIT) {
      events.push({ type: 'wallImpact', tick: this.tick, slot: fighter.slot, axis: 'z', speed: Math.abs(fighter.vz) });
      fighter.z = ARENA_LIMIT;
      fighter.vz = -Math.trunc(Math.abs(fighter.vz) / 2);
    } else if (fighter.z < -ARENA_LIMIT) {
      events.push({ type: 'wallImpact', tick: this.tick, slot: fighter.slot, axis: 'z', speed: Math.abs(fighter.vz) });
      fighter.z = -ARENA_LIMIT;
      fighter.vz = Math.trunc(Math.abs(fighter.vz) / 2);
    }
  }

  private resolveHit(attacker: Fighter, defender: Fighter, def: MoveDef, events: SimEvent[]): boolean {
    if (defender.eliminated) {
      return false;
    }
    if (defender.y > AIRBORNE_Y) {
      return false; // airborne targets are safe from grounded hitboxes in Phase 0
    }
    const reach = Math.trunc(def.reach * FP_SCALE);
    const dx = defender.x - attacker.x;
    const dz = defender.z - attacker.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq > reach * reach) {
      return false;
    }
    // Forgiving rear hitbox: a strike still connects slightly behind the attacker.
    if (dx * attacker.facing < -(reach >> 1)) {
      return false;
    }

    const distanceFp = integerSqrt(distanceSq);
    const blocked = this.isGuarded(defender, def);
    const damage = blocked ? 0 : def.damage;

    attacker.hitstop = def.hitstop;
    defender.hitstop = def.hitstop;
    attacker.hitConnect = true;
    attacker.hitConsumed = true;
    attacker.targetLockedSlot = defender.slot;

    if (blocked) {
      defender.blockstunLeft = def.blockstun;
      setState(defender, 'blockstun');
      defender.vx = Math.trunc((def.knockback * attacker.facing) / 2);
      defender.vz = 0;
    } else {
      defender.health = Math.max(0, defender.health - def.damage);
      defender.spaMeter = clampInt(defender.spaMeter + SPA_ON_HIT, 0, defender.spaMax);
      if (def.launcher || def.knockdown) {
        setState(defender, 'launched');
        defender.vy = LAUNCH_VELOCITY;
        defender.vx = def.knockback * attacker.facing;
        defender.vz = 0;
        defender.juggleCount += 1;
        defender.stunRemaining = 0;
        defender.blockstunLeft = 0;
      } else {
        setState(defender, 'hitstun');
        defender.stunRemaining = def.hitstun;
        defender.vx = def.knockback * attacker.facing;
        defender.vz = 0;
        defender.juggleCount = 0;
      }
      if (defender.health === 0) {
        defender.eliminated = true;
        setState(defender, 'down');
      }
    }
    attacker.spaMeter = clampInt(attacker.spaMeter + SPA_ON_LAND, 0, attacker.spaMax);

    events.push({
      type: 'hit',
      tick: this.tick,
      attackerSlot: attacker.slot,
      defenderSlot: defender.slot,
      moveId: def.id,
      damage,
      hitstun: blocked ? 0 : def.hitstun,
      blockstun: blocked ? def.blockstun : 0,
      hitstop: def.hitstop,
      guarded: blocked,
      knockdown: !blocked && (def.knockdown || def.launcher),
      launcher: !blocked && def.launcher,
      distanceFp,
    });
    return true;
  }

  private isGuarded(defender: Fighter, def: MoveDef): boolean {
    if (def.guard === 'throw' || def.guard === 'unblockable') {
      return false;
    }
    // Phase 0 guard state is derived from the defender's current state: only a free fighter
    // holding a guard can block, so a hit taken mid-move is always a clean hit.
    if (defender.state !== 'idle' && defender.state !== 'walk') {
      return false;
    }
    return this.guardHeld[defender.slot] === 'high'
      ? def.guard === 'high' || def.guard === 'mid'
      : this.guardHeld[defender.slot] === 'low'
        ? def.guard === 'low'
        : false;
  }

  /** Guard held per slot this tick, refreshed from `FrameInput.guard` before hit resolution. */
  private readonly guardHeld: GuardInput[] = [];

  private syncGuards(inputs: readonly FrameInput[] | undefined): void {
    for (const fighter of this.fighters) {
      const input = inputs?.[fighter.slot];
      this.guardHeld[fighter.slot] = input?.guard ?? 'none';
    }
  }
}

function serializeField(value: Fighter[keyof Fighter]): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic integer square root (Newton-free: binary search over integers only). */
function integerSqrt(value: number): number {
  if (value <= 0) return 0;
  let low = 0;
  let high = 1 << 16;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (mid * mid <= value) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}