/**
 * The CPU opponent — a deterministic bot controller (Phase 5).
 *
 * This lives in `src/sim/`, not in the client, for one reason: **a bot is a source of `FrameInput`,
 * and `FrameInput` is the only thing the simulation is allowed to read.** A bot that reached into
 * `Fighter` records to deal damage directly would be a second, non-hashed, non-replayable channel
 * into the world — exactly what AGENTS.md §3.1 forbids. So the bot presses buttons. It walks up and
 * throws a punch like anyone else, and the fight that results is the same fight a player is in.
 *
 * ## Purity: why there is no `Math.random()` and no remembered state
 *
 * Every decision is a pure function of `(seed, slot, tick, world state)`. That is not a stylistic
 * choice, it is the property the rest of the engine needs:
 *
 *   - **Replay.** Two runs with the same seed produce byte-identical input, so the 10,000-tick soak
 *     can assert "no desync" by running the same seed twice rather than by hoping.
 *   - **Rollback.** `src/net/rollback.ts` rewinds the world and re-simulates. A bot holding a
 *     mutable RNG would have already drawn a *different* number by the time the world was rewound
 *     to before that draw, so the rewound tick would diverge and never re-converge. Hashing
 *     `(seed, slot, tick)` means a rewind asks the same question and gets the same answer.
 *   - **Lockstep across peers.** On the house LAN every peer derives every bot's input from the
 *     shared seed and the shared tick, so bots need no packets and cannot disagree.
 *
 * The randomness is therefore a *hash*, not a stream — `unit(seed, slot, tick, salt)` below.
 *
 * ## What it plays
 *
 * Navigation, the four directional chain branches of AGENTS.md §5, hit-confirm branching,
 * high/low dodges chosen by the level of the incoming strike, grabs, and the SPA gauge when it
 * fills. It is a competent opponent, not a good one: it has no feints, no spacing discipline and
 * no memory of what happened to it last round.
 */

import { AIRBORNE_Y, FP_SCALE } from '../config';
import { chargeProfileOf, defaultChainMoveId, getArchetype } from '../combat/archetypes';
import { getMove, type MoveDef, type MoveStance } from '../combat/moveset';
import { areAllies } from './modes';
import type { Fighter } from './fighter';
import { CHAIN_PRESS, idleInput, NEUTRAL_INPUT, type FrameInput, type MatchRunner } from './runner';

/** Default seed. Fixed so a bot match is reproducible out of the box. */
export const DEFAULT_AI_SEED = 0x5eed1234;

/** Distance bands, in world units, for what the bot decides to do. */
const CLOSE_RANGE = 1.6;
const MID_RANGE = 2.6;

/** Ticks of warning the bot wants on an incoming hitbox before it commits to a dodge. */
const THREAT_WINDOW = 14;

/**
 * How far outside a move's declared reach the bot still treats it as a threat.
 *
 * Generous on purpose: the bot has no knowledge of the attacker's facing, so it must assume the
 * worst case (a crowd-clearer hitting behind it) rather than the average one.
 */
const THREAT_MARGIN = 0.9;

export interface AiOptions {
  readonly seed?: number;
  /**
   * How hard the bot plays, 0..1. Scales its reaction window, how often it commits to a heavy
   * option and how eagerly it spends the SPA gauge. Clamped: a caller passing 5 gets a bot that is
   * simply always at maximum, never one that is *better* than the design allows.
   */
  readonly aggression?: number;
}

/** Per-tick scratch input. Reused across bots so a four-bot tick allocates one object, not four. */
const NO_INPUT: FrameInput = NEUTRAL_INPUT;

export class AiController {
  readonly seed: number;
  readonly aggression: number;

  constructor(options: AiOptions = {}) {
    this.seed = (options.seed ?? DEFAULT_AI_SEED) >>> 0;
    this.aggression = clamp01(options.aggression ?? 0.6);
  }

  /**
   * The input this bot wants to submit on the tick the world is about to run.
   *
   * Called with the world *before* the tick — the same view `MatchRunner.fixedUpdate` gets — so
   * `runner.tick` is the tick being decided and every read here describes the state it starts from.
   */
  decide(runner: MatchRunner, slot: number): FrameInput {
    const me = runner.fighterAt(slot);
    if (me === undefined || me.eliminated) {
      return NO_INPUT;
    }

    // A charge hold owns its fighter until it is released (see `MatchRunner.updateCharge`). While
    // it holds, the only decision left is *when* to let go, and `chargeFrames` is world state, so
    // reading it keeps the bot stateless.
    if (me.state === 'charging') {
      return this.releaseCharge(me);
    }

    // Anything that is not free to act ignores its input anyway. Returning neutral rather than
    // re-deciding keeps the bot from burning a "press" it cannot deliver — which matters, because
    // a real client's buffer would still be holding it.
    if (me.hitstop > 0 || (me.state !== 'idle' && me.state !== 'walk')) {
      return NO_INPUT;
    }

    const target = pickTarget(runner, me);
    if (target === null) {
      return NO_INPUT; // a dead heat with nobody left to fight
    }

    const tick = runner.tick;
    const distance = distanceBetween(me, target);

    // A hit-confirm window is the most valuable thing the bot is ever offered, and it is
    // offered for a fixed number of ticks. Take it before anything else.
    if (me.chainWindow > 0 && me.branchTarget !== '') {
      return idleInput({ attack: me.branchTarget, stance: 'neutral' });
    }

    // Read an incoming hitbox and answer it. Checked before attacking because a whiffed string
    // into a launch is how a bot loses a round it was winning.
    const threat = this.readThreat(runner, me, tick);
    if (threat !== null) {
      return threat;
    }

    // The archetype's signature move is asked for *before* the generic SPA. Jack-5's level-1
    // Gigaton and SPA 1 both cost a half gauge, and whichever is checked first wins every race for
    // it — checked in this order, an archetype with a charged special actually uses it instead of
    // spending the identical cost on the same button.
    const charge = this.considerCharge(me, target, distance, tick);
    if (charge !== null) {
      return charge;
    }

    const spa = this.considerSpa(me, target, distance, tick);
    if (spa !== null) {
      return spa;
    }

    const grab = this.considerGrab(me, target, distance, tick);
    if (grab !== null) {
      return grab;
    }

    // Nothing playable from where the bot is standing: it closes the distance rather than guarding
    // in place. This is the fallback that makes the commit range self-correcting — with a hard
    // distance gate instead, a bot whose opener reaches less than that gate would stand in the
    // gap forever, guarding an opponent it never walks in on.
    return this.strike(me, target, distance, tick) ?? this.navigate(me, target, distance, tick);
  }

  /**
   * Fill in the bot-controlled slots of an input array, passing every other slot through untouched.
   *
   * Non-mutating, so the caller's array — the client's own `join.frameInputs()` result — is not
   * modified underneath the humans. Returns a new array only when there is actually a bot to place;
   * with no bots configured it hands the original back, which keeps the four-human path free of
   * any per-tick allocation at all.
   */
  fill(
    runner: MatchRunner,
    inputs: readonly FrameInput[],
    botSlots: readonly number[],
  ): readonly FrameInput[] {
    if (botSlots.length === 0) {
      return inputs;
    }
    const out = inputs.slice();
    for (const slot of botSlots) {
      if (slot < 0 || slot >= out.length) {
        continue;
      }
      out[slot] = this.decide(runner, slot);
    }
    return out;
  }

  /**
   * Answer an incoming strike with the dodge that actually covers it.
   *
   * The read is deliberately structural rather than clever: find any hostile fighter whose hitbox
   * is live or about to be, check whether this bot would actually be in it, and slip the right way.
   * A throw or an unblockable is *not* answered — those are not dodged, and pretending otherwise is
   * how a bot walks into a grab it could have walked out of by backing off instead.
   */
  private readThreat(runner: MatchRunner, me: Fighter, tick: number): FrameInput | null {
    if (me.dodgeCooldown > 0) {
      return null;
    }
    const window = Math.round(THREAT_WINDOW * (0.5 + this.aggression));

    for (const other of runner.fighters) {
      if (other === me || other.eliminated || areAllies(me, other)) {
        continue;
      }
      const moveId = other.currentMove;
      if (moveId === null) {
        continue;
      }
      const def = getMove(moveId);
      if (def === undefined) {
        continue;
      }

      const ticksUntilActive = ticksUntilHitbox(other, def);
      if (ticksUntilActive > window) {
        continue;
      }

      const danger = (def.reach + THREAT_MARGIN) * FP_SCALE;
      if (distanceBetween(me, other) > danger) {
        continue;
      }

      if (def.guard === 'throw' || def.guard === 'unblockable') {
        // Unanswerable by dodging. Guarding is still better than nothing for the blockable half
        // of the roster, and retreating out of reach is better than standing in it.
        const away = stepAway(me, other, tick);
        if (away !== null) {
          return away;
        }
        continue;
      }

      // A low dodge hops sweeps; a high dodge slips everything above them. This is the whole
      // high/low read of AGENTS.md §5, and getting it backwards is the single easiest way to
      // write a bot that never dodges anything correctly.
      const direction = def.guard === 'low' ? 'low' : 'high';
      return idleInput({ dodge: direction, moveX: -stepTowardSign(me, other) });
    }
    return null;
  }

  /**
   * Spend the gauge.
   *
   * Tier 2 is the crowd-clearer and is worth it in a four-way; tier 1 is a single-target lethal
   * strike and is only thrown when there is one target to point it at. Both need to be *in
   * range* first — the declared `reach` on the table, not a guess — or the bot simply whiffs its
   * meter and spends ninety frames of recovery doing it.
   */
  private considerSpa(me: Fighter, target: Fighter, distance: number, tick: number): FrameInput | null {
    const candidates: readonly MoveDef[] = SPA_CANDIDATES;
    for (const def of candidates) {
      if (me.spaMeter < def.spaCost) {
        continue;
      }
      if (!canConnect(target, distance, def)) {
        continue;
      }
      // Not every full gauge should be spent on the first opponent that wanders into range; the
      // gauge is a resource, and dumping it wastes the round.
      if (!chance(this.seed, me.slot, tick, def.spaTier + 40, 0.35 + 0.5 * this.aggression)) {
        continue;
      }
      return idleInput({ attack: def.id, stance: 'neutral' });
    }
    return null;
  }

  /**
   * Jack-5's five-level Gigaton.
   *
   * Only one archetype has a charge, and the hold is 28 frames before it will even let go, so the
   * bot only enters it when the target is already inside the release's reach — otherwise it is a
   * two-second gift to whoever is standing next to it.
   */
  private considerCharge(me: Fighter, target: Fighter, distance: number, tick: number): FrameInput | null {
    const profile = chargeProfileOf(me.archetypeId);
    if (profile === null || me.spaMeter < profile.minGauge) {
      return null;
    }
    const releaseId = profile.releases[0];
    const release = releaseId === undefined ? undefined : getMove(releaseId);
    // A quarter of a world unit of slack: a charge is aimed where the target was when the hold
    // started, and the opponent keeps moving for all 28 frames of it.
    if (release === undefined || !canConnect(target, distance, release, release.reach + 0.25)) {
      return null;
    }
    // Held every so often at most, so it is a read the bot makes rather than a default.
    if (!chance(this.seed, me.slot, tick, 71, 0.4 + 0.4 * this.aggression)) {
      return null;
    }
    return idleInput({ attack: profile.chainEntry, stance: 'neutral' });
  }

  /** While charging: keep holding, or let go. `chargeFrames` is world state, so no timer here. */
  private releaseCharge(me: Fighter): FrameInput {
    const profile = chargeProfileOf(me.archetypeId);
    if (profile === null) {
      return NO_INPUT;
    }
    // Held past the first windup by a hash of the tick: enough to make the release *level* vary
    // without the bot having to remember how long it has been holding.
    const extraLoops = Math.floor(unit(this.seed, me.slot, 0, 91) * 2.2);
    const holdFor = profile.firstWindupFrames + extraLoops * profile.loopFrames;
    return idleInput({ attack: me.chargeFrames < holdFor ? profile.chainEntry : null });
  }

  /**
   * A grab, for the moments a punch cannot reach.
   *
   * Throws ignore guard level and beat a blocking opponent, so the bot only reaches for one when
   * the target is committed — in hitstun, blockstun, or holding a charge — and is close enough for
   * the archetype's declared throw to actually connect.
   */
  private considerGrab(me: Fighter, target: Fighter, distance: number, tick: number): FrameInput | null {
    const archetype = getArchetype(me.archetypeId);
    const throwId = archetype?.throwMoveId;
    if (throwId === undefined) {
      return null;
    }
    const def = getMove(throwId);
    if (def === undefined || !canConnect(target, distance, def)) {
      return null;
    }
    // Airborne or rolling targets cannot be grabbed: the sim refuses those, and pressing anyway
    // just eats recovery frames.
    if (target.state === 'getup') {
      return null;
    }
    const punishable =
      target.state === 'hitstun' ||
      target.state === 'blockstun' ||
      target.state === 'charging';
    if (!punishable && !chance(this.seed, me.slot, tick, 17, 0.15 + 0.35 * this.aggression)) {
      return null;
    }
    return idleInput({ attack: throwId, stance: 'neutral' });
  }

  /**
   * Pick a directional branch and press it, or return null when nothing playable is in range.
   *
   * This is the four-way branching of AGENTS.md §5, chosen by what the target is doing rather than
   * at random: `up` to launch, a sweep `down` at something close and grounded, `side` to cover
   * the middle of the range, `neutral` up close where the archetype's fastest string lives.
   *
   * Every candidate is checked against the move it actually opens, and an intent that cannot
   * connect is abandoned rather than pressed. That check is not defensive padding — it is the
   * single rule that keeps the bot from spending the whole round swinging at a target it has no
   * legal hit on. See {@link canConnect}.
   *
   * Returning `null` means "not from here", and the caller walks closer instead.
   */
  private strike(me: Fighter, target: Fighter, distance: number, tick: number): FrameInput | null {
    // Airborne target, no branch ticket: hold. Nothing in the roster's *opener* line is
    // air-capable, so a fresh press provably cannot touch a launched fighter, and the only way to
    // keep hitting one is to branch — which needs a confirm first. Guarding until the arc lands is
    // the correct play, and mashing here is what makes a bot look like it is fighting something.
    if (isAirborne(target)) {
      return idleInput({ guard: guardLevelFor(target), stance: 'neutral' });
    }

    // Rotating the preference order on a slow hash is what gives the bot more than one string
    // without ever letting it pick a branch whose opener cannot reach — every entry is still
    // validated below, so the rotation can only choose *between* playable options.
    const order = rotate(stanceOrder(distance), Math.floor(unit(this.seed, me.slot, Math.floor(tick / 45), 23) * 4));
    for (const stance of order) {
      const opener = openerOf(me.archetypeId, stance);
      if (opener === undefined || !canConnect(target, distance, opener)) {
        continue;
      }
      // A whiff lockout means the last string missed and the sim will refuse a new chain. Guard
      // instead of pressing into it — the opponent is mid-string, so this is the free block.
      if (me.whiffLockout > 0) {
        return idleInput({ guard: guardLevelFor(target), stance });
      }
      return idleInput({ attack: CHAIN_PRESS, stance });
    }
    return null;
  }

  /** Close the distance, with a strafe so the bot is not a straight line down the middle. */
  private navigate(me: Fighter, target: Fighter, distance: number, tick: number): FrameInput {
    void distance;
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    // Side-step rather than beeline: a straight line into a corner is how a bot walks itself into
    // a wall and stands there. The strafe sign flips on a slow hash so it circles.
    const strafe = chance(this.seed, me.slot, Math.floor(tick / 30), 53, 0.5) ? 1 : -1;
    const forwardX = sign(dx);
    const forwardZ = sign(dz);
    return idleInput({
      moveX: forwardX === 0 ? strafe : forwardX,
      moveZ: forwardZ,
      stance: 'neutral',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------------------------

/**
 * Who the bot should be hitting.
 *
 * The weakest living hostile, then the nearest, then the lowest slot. Every tie-break is on
 * integers the world already holds, so two peers given the same world pick the same opponent — an
 * arbitrary choice here would be a choice the network could not agree on.
 */
function pickTarget(runner: MatchRunner, me: Fighter): Fighter | null {
  let best: Fighter | null = null;
  for (const other of runner.fighters) {
    if (other === me || other.eliminated || areAllies(me, other)) {
      continue;
    }
    if (best === null || outranks(other, me, best)) {
      best = other;
    }
  }
  return best;
}

function outranks(candidate: Fighter, me: Fighter, incumbent: Fighter): boolean {
  // Health fraction, cross-multiplied so archetypes with different maxima compare fairly.
  const maxA = candidate.maxHealth <= 0 ? 1 : candidate.maxHealth;
  const maxB = incumbent.maxHealth <= 0 ? 1 : incumbent.maxHealth;
  const left = candidate.health * maxB;
  const right = incumbent.health * maxA;
  if (left !== right) {
    return left < right;
  }
  const near = distanceBetween(me, candidate);
  const far = distanceBetween(me, incumbent);
  if (near !== far) {
    return near < far;
  }
  return candidate.slot < incumbent.slot;
}

// ---------------------------------------------------------------------------------------------
// Geometry and predicates
// ---------------------------------------------------------------------------------------------

/** Squared distance in subunits — the comparison the code below actually needs. */
function distanceSq(a: Fighter, b: Fighter): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return dx * dx + dz * dz;
}

/**
 * Distance in subunits.
 *
 * `Math.sqrt` is the one transcendental in this file, and it is a *correctly rounded* IEEE-754
 * operation, so it is bit-identical on every engine the way `Math.sin` is not. The runner uses an
 * integer square root instead because it has to stay inside the fixed-point budget; the bot is
 * choosing between options rather than integrating motion, so an exact distance is worth more here
 * than an integer one.
 */
function distanceBetween(a: Fighter, b: Fighter): number {
  return Math.sqrt(distanceSq(a, b));
}

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function stepTowardSign(from: Fighter, to: Fighter): number {
  return sign(to.x - from.x);
}

/** Walk directly away from whoever is about to hit this bot. Null when there is nowhere to go. */
function stepAway(me: Fighter, other: Fighter, tick: number): FrameInput | null {
  void tick;
  const dx = me.x - other.x;
  const dz = me.z - other.z;
  if (dx === 0 && dz === 0) {
    return null; // perfectly overlapped: retreating has no direction
  }
  return idleInput({ moveX: sign(dx), moveZ: sign(dz) });
}

/**
 * Ticks until this fighter's hitbox goes live.
 *
 * `movePhaseFrame` counts the accepting tick as 0, so the first live frame is
 * `movePhaseFrame + 1`. A fighter already `active` is at zero; anything still in recovery is
 * negative, and the caller discards those.
 */
function ticksUntilHitbox(fighter: Fighter, def: MoveDef): number {
  const phase = fighter.movePhaseFrame + 1;
  if (fighter.state === 'active') {
    return 0;
  }
  return def.startup - phase;
}

/** Baseline SPA tiers, cheapest first, so the bot spends the least gauge that can still work. */
const SPA_CANDIDATES: readonly MoveDef[] = Object.freeze(
  ['spa1', 'spa2'].flatMap((id) => {
    const def = getMove(id);
    return def === undefined ? [] : [def];
  }),
);

/**
 * Branch preferences by range, nearest band first.
 *
 * Ordered by intent rather than by reach: the launcher comes early at close range because starting
 * one is how a juggle begins at all (only the second link of the `up` chains is air-capable), and
 * the sweep comes early close in because it is the knockdown that buys a grounded follow-up. Every
 * entry is still checked against its opener before it is pressed.
 */
const CLOSE_ORDER: readonly MoveStance[] = Object.freeze(['neutral', 'up', 'down', 'side']);
const MID_ORDER: readonly MoveStance[] = Object.freeze(['side', 'neutral', 'down']);
const FAR_ORDER: readonly MoveStance[] = Object.freeze(['down', 'side', 'neutral']);

function stanceOrder(distance: number): readonly MoveStance[] {
  if (distance <= CLOSE_RANGE * FP_SCALE) {
    return CLOSE_ORDER;
  }
  return distance <= MID_RANGE * FP_SCALE ? MID_ORDER : FAR_ORDER;
}

function rotate<T>(items: readonly T[], by: number): readonly T[] {
  if (items.length === 0) {
    return items;
  }
  const shift = ((by % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** The move a bare stance press opens, or undefined when this archetype has no such chain. */
function openerOf(archetypeId: string, stance: MoveStance): MoveDef | undefined {
  const id = defaultChainMoveId(archetypeId, stance);
  return id === undefined ? undefined : getMove(id);
}

/** True when the target is off the ground, which is what `MoveDef.airOnly` is tested against. */
function isAirborne(fighter: Fighter): boolean {
  return fighter.state === 'launched' || fighter.y > AIRBORNE_Y;
}

/**
 * Which guard to hold: the level that answers what the opponent is actually throwing.
 *
 * Reads the target's live move rather than guessing, so a sweep is blocked low and everything
 * else high. With nothing pending it is high, which is the safe default — a high guard still
 * stops mid and high strikes, and the only thing it loses to is a sweep.
 */
function guardLevelFor(target: Fighter): 'high' | 'low' {
  const moveId = target.currentMove;
  const def = moveId === null ? undefined : getMove(moveId);
  // Sweeps and anything else explicitly answered by a low guard.
  return def !== undefined && def.guard === 'low' ? 'low' : 'high';
}

/**
 * Whether this move could *possibly* land on this target from this distance.
 *
 * Both tests are lifted straight out of `MatchRunner.resolveHit`, which is the only place that
 * decides whether a strike connects: the aerial split (`def.airOnly !== airborne`) and the reach
 * circle. The rear-facing hitbox test is deliberately not modelled — it depends on the attacker's
 * facing, which the bot does steer, and guessing wrong there only ever costs a whiff.
 *
 * This is the rule that stops the bot from grinding: a press that provably cannot connect is never
 * issued, so its recovery frames are never spent on it, and the caller walks closer instead.
 *
 * A tempting refinement — requiring the target to still be in reach `def.startup` frames later,
 * since that is when the hitbox actually goes live — was measured and dropped. The target's walk
 * during a startup is not a predictable quantity (it steps back, steps in, or is launched), and
 * tuning a margin against it produced swings of 70 to 160 hits over the same run depending on the
 * constant. A rule that cannot be reasoned about is worse than the simple one it replaced.
 */
function canConnect(
  target: Fighter,
  distance: number,
  def: MoveDef,
  reach = def.reach,
): boolean {
  if (def.airOnly !== isAirborne(target)) {
    return false;
  }
  return distance <= reach * FP_SCALE;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------------------------

/**
 * A 32-bit avalanche over four integers — the `lowbias32` finalizer from Chris Wellons' hash
 * proposals, which is well distributed in every input bit and costs four integer operations.
 *
 * Integer-only and `>>> 0`-normalised, so it is bit-identical everywhere. This is the whole of the
 * bot's "randomness": a function, not a stream, which is exactly what makes it rewind-safe.
 */
function hash32(a: number, b: number, c: number, d: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1) ^ Math.imul(c, 0x85ebca6b) ^ Math.imul(d, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h >>> 0;
}

/** A stable value in [0, 1) for this (seed, slot, tick, salt). Pure. */
function unit(seed: number, slot: number, tick: number, salt: number): number {
  return hash32(seed, slot, tick, salt) / 4294967296;
}

/** A stable coin flip with probability `p`. Pure. */
function chance(seed: number, slot: number, tick: number, salt: number, p: number): boolean {
  return unit(seed, slot, tick, salt) < p;
}