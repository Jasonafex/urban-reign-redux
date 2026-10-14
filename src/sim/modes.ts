/**
 * Game modes and the match lifecycle (Phase 5).
 *
 * AGENTS.md §5 asks for "4 simultaneous combatants in Free-For-All or 2v2 Tag teams" and for a
 * match that has a shape: countdown, fight, knockouts, a winner, a rematch. `MatchRunner` models
 * one *fight* — it has no opinion about rounds, clocks or who is winning, because none of those
 * are properties of a simulation tick. This module owns all of it, and it owns it as pure state
 * advanced one tick at a time.
 *
 * ## Why the lifecycle is measured in ticks
 *
 * Everything here counts `runner.tick` and its own tick-derived counters. Nothing reads a clock.
 * That is not stylistic: the match lifecycle has to agree tick-for-tick across the peers on the
 * house LAN, and a countdown driven by `Date.now()` would drift on a 144Hz host and would need
 * renegotiating over the wire every second. Ticks are already agreed on by the rollback engine
 * (`src/net/rollback.ts`), so the entire round clock rides along for free — and a LAN match cannot
 * show one peer a `FIGHT` banner the others have not seen yet.
 *
 * ## Why teams live on the fighter, not here
 *
 * {@link MatchRunner} resolves hits, and it needs to know who is hostile to whom. Rather than pass
 * a team table into the simulation (which would put match rules inside the world state), a
 * fighter's team *is* a fighter field and is covered by `stateHash()` — see the `team` comment in
 * `src/sim/fighter.ts`. This module is the authority that assigns it, and nothing else assigns it.
 *
 * ## Determinism
 *
 * No wall clock, no randomness, no DOM. Every collection here is bounded by the slot count (at
 * most four), which is what lets `test/soak.test.mjs` assert that a thousand rounds leave the
 * match object exactly the size it started.
 */

import {
  COUNTDOWN_FRAMES,
  KO_HOLD_FRAMES,
  READY_FRAMES,
  REMATCH_HOLD_FRAMES,
  ROUNDS_TO_WIN,
  ROUND_TIME_LIMIT_FRAMES,
  VICTORY_HOLD_FRAMES,
} from '../config';
import type { Fighter } from './fighter';
import type { SimEvent } from './events';
import { defaultSpawns, type FighterSpawn, type MatchRunner } from './runner';

// ---------------------------------------------------------------------------------------------
// Modes and teams
// ---------------------------------------------------------------------------------------------

export type GameModeId = 'free_for_all' | 'team_battle';

/** The two sides of a 2v2. `null`-team fighters are Free-For-All and belong to neither side. */
export type TeamId = 'A' | 'B';

/**
 * Team A takes the even slots and Team B the odd ones.
 *
 * Alternating rather than fronting each team on one side, because the default roster stands in
 * the four corners of the arena: with 0/2 and 1/3 the two teams start diagonally opposed, so a
 * round opens with everybody in reach of somebody rather than with one team already adjacent.
 */
export const TEAM_A_SLOTS: readonly number[] = Object.freeze([0, 2]);
export const TEAM_B_SLOTS: readonly number[] = Object.freeze([1, 3]);

/** Team index (0 == A, 1 == B) a slot fights for in a 2v2, or null in a Free-For-All. */
export function teamIndexOfSlot(slot: number): 0 | 1 | null {
  if (TEAM_A_SLOTS.includes(slot)) {
    return 0;
  }
  if (TEAM_B_SLOTS.includes(slot)) {
    return 1;
  }
  return null;
}

/** 'A' or 'B' for a team slot; null for a slot that belongs to no team. */
export function teamOfSlot(slot: number): TeamId | null {
  const index = teamIndexOfSlot(slot);
  return index === null ? null : index === 0 ? 'A' : 'B';
}

/** True when two fighters share a team, so a strike must pass through them. */
export function areAllies(a: Fighter, b: Fighter): boolean {
  return a.team !== null && a.team === b.team;
}

/** True when two fighters are allowed to hit each other in this pairing. */
export function areHostile(a: Fighter, b: Fighter): boolean {
  return !areAllies(a, b);
}

/** Slots on one side of a 2v2. */
export function slotsOfTeam(team: TeamId): readonly number[] {
  return team === 'A' ? TEAM_A_SLOTS : TEAM_B_SLOTS;
}

export interface GameModeDef {
  readonly id: GameModeId;
  readonly label: string;
  readonly blurb: string;
  /** Whether this mode fields two teams. Drives scoring, hostility and the HUD's layout. */
  readonly teamBased: boolean;
}

export const GAME_MODES: readonly GameModeDef[] = Object.freeze([
  Object.freeze({
    id: 'free_for_all',
    label: '4-Player Free-For-All',
    blurb: 'Everyone for themselves. Last one standing takes the round.',
    teamBased: false,
  }),
  Object.freeze({
    id: 'team_battle',
    label: '2v2 Team Battle',
    blurb: 'Slots 0 + 2 against slots 1 + 3. No friendly fire.',
    teamBased: true,
  }),
]);

export function modeDef(id: GameModeId): GameModeDef {
  const found = GAME_MODES.find((mode) => mode.id === id);
  if (found === undefined) {
    throw new RangeError(`Unknown game mode: ${id}`);
  }
  return found;
}

/**
 * The starting roster for a mode.
 *
 * The four Trial 13 archetypes in their arena corners, with teams stamped on for a 2v2. Taking a
 * base list rather than hard-coding positions means a caller can pass a different roster — the
 * LAN path hands this the roster the relay assigned — and still get the right teams.
 */
export function matchSpawns(
  mode: GameModeId,
  base: readonly FighterSpawn[] = defaultSpawns(),
): FighterSpawn[] {
  const teamBased = modeDef(mode).teamBased;
  // The Free-For-All branch omits `team` outright rather than setting it to `undefined`: the project
  // builds with `exactOptionalPropertyTypes`, and an explicit `undefined` is not the same thing as
  // an absent key. It reads better anyway — the field simply does not exist on a Free-For-All.
  if (!teamBased) {
    return base.map((spawn) => ({ ...spawn }));
  }
  return base.map((spawn) => ({ ...spawn, team: teamIndexOfSlot(spawn.slot) ?? 0 }));
}

// ---------------------------------------------------------------------------------------------
// Match phases
// ---------------------------------------------------------------------------------------------

/**
 * The lifecycle, in the order it runs.
 *
 *   countdown → fighting → ko → fighting → … → victory → rematch → countdown …
 *
 * `ko` is a *phase* rather than a flag on `fighting` because a knockout freezes the world for a
 * beat: input is locked out, the camera settles, and only then is the round scored. Scoring
 * immediately would bank the win while the loser is still on the floor.
 */
export type MatchPhase = 'countdown' | 'fighting' | 'ko' | 'victory' | 'rematch';

/** Which announcement the HUD should be showing. */
export type BannerTone = 'ready' | 'fight' | 'ko' | 'victory' | 'rematch';

export interface MatchBanner {
  readonly text: string;
  readonly tone: BannerTone;
  /** Ticks until this announcement is replaced. Drives the HUD's drain bar. */
  readonly framesLeft: number;
  /** Ticks this announcement runs for in total, so a view can draw it as a proportion. */
  readonly framesTotal: number;
  /** Optional second line — the winner's name, the KO attribution. */
  readonly sub?: string;
}

/** Who took the round. `kind` is what the HUD renders, not what the simulation stores. */
export interface WinnerInfo {
  readonly kind: 'slot' | 'team' | 'draw';
  readonly slots: readonly number[];
  readonly label: string;
}

export type ModeEvent =
  | { readonly type: 'phase'; readonly tick: number; readonly from: MatchPhase; readonly to: MatchPhase; readonly banner: MatchBanner | null }
  | { readonly type: 'ko'; readonly tick: number; readonly slot: number; readonly team: TeamId | null; readonly by: number | null }
  | { readonly type: 'timeout'; readonly tick: number; readonly winner: WinnerInfo }
  /** A round was scored. `final` means it also decided the match. */
  | { readonly type: 'round_won'; readonly tick: number; readonly round: number; readonly winner: WinnerInfo; readonly wins: readonly number[]; readonly final: boolean }
  | { readonly type: 'match_over'; readonly tick: number; readonly winner: WinnerInfo; readonly wins: readonly number[] }
  | { readonly type: 'rematch'; readonly tick: number; readonly round: number };

// ---------------------------------------------------------------------------------------------
// MatchRules
// ---------------------------------------------------------------------------------------------

export interface MatchRulesOptions {
  readonly mode?: GameModeId;
  /** Starting roster. Defaults to the four archetypes in the arena corners. */
  readonly spawns?: readonly FighterSpawn[];
  readonly roundsToWin?: number;
  readonly roundTimeLimitFrames?: number;
  readonly countdownFrames?: number;
  readonly koHoldFrames?: number;
  readonly victoryHoldFrames?: number;
  readonly rematchHoldFrames?: number;
}

/**
 * The match, as state advanced one tick at a time.
 *
 * One instance per match, owned by whoever owns the `MatchRunner` (the offline client, or the LAN
 * host). It holds no reference to the world: `step` is handed the runner and reads it, so the
 * same rules object can be pointed at a freshly reset world between rounds.
 *
 * Retained state is O(slots) — a win count per slot plus the set of slots knocked out this round —
 * and never grows with ticks played. `test/soak.test.mjs` gates exactly that.
 */
export class MatchRules {
  readonly mode: GameModeId;
  readonly spawns: readonly FighterSpawn[];
  readonly roundsToWin: number;
  readonly roundTimeLimitFrames: number;
  readonly countdownFrames: number;
  readonly koHoldFrames: number;
  readonly victoryHoldFrames: number;
  readonly rematchHoldFrames: number;

  phase: MatchPhase = 'countdown';
  /** Ticks spent in the current phase. */
  phaseFrame = 0;
  /** 1-based round index within this match. */
  round = 1;
  /** Ticks of the round clock consumed. Only advances while the fight is live. */
  roundTime = 0;

  /** Rounds won, indexed by slot. In a 2v2 both slots of a winning team are credited together. */
  readonly wins: number[];

  champion: WinnerInfo | null = null;
  /** Winner of the round in progress, held while the `ko` phase plays out. */
  private pending: WinnerInfo | null = null;
  /** Slots knocked out this round, so each knockout is announced once. Bounded by the slot count. */
  private readonly downed = new Set<number>();
  /** Last knockout attribution, for the banner's second line. */
  private lastKo: { slot: number; by: number | null } | null = null;
  private readonly rematchVotes = new Set<number>();
  /** True on the tick the round clock ran out; distinguishes a timeout from a knockout. */
  private timedOut = false;
  /**
   * The round number that has already been scored, or -1.
   *
   * Scoring a round and starting the next one are two separate acts — the first belongs to the
   * rules, the second to whoever owns the `MatchRunner` — so for a tick or two the rules are looking
   * at a world where the winning team is *still* eliminated. Without this guard the rules would
   * happily re-decide the round it had just scored, and a team would collect two points for one
   * knockout. Keyed on the round number, which is the only thing that distinguishes "the same
   * finished fight" from "the next one".
   */
  private scoredRound = -1;
  /** The world tick this rules object last saw, or -1 before its first `step`. */
  private lastTick = -1;

  constructor(options: MatchRulesOptions = {}) {
    this.mode = options.mode ?? 'free_for_all';
    this.spawns = matchSpawns(this.mode, options.spawns ?? defaultSpawns());
    this.roundsToWin = Math.max(1, options.roundsToWin ?? ROUNDS_TO_WIN);
    this.roundTimeLimitFrames = options.roundTimeLimitFrames ?? ROUND_TIME_LIMIT_FRAMES;
    this.countdownFrames = options.countdownFrames ?? COUNTDOWN_FRAMES;
    this.koHoldFrames = options.koHoldFrames ?? KO_HOLD_FRAMES;
    this.victoryHoldFrames = options.victoryHoldFrames ?? VICTORY_HOLD_FRAMES;
    this.rematchHoldFrames = options.rematchHoldFrames ?? REMATCH_HOLD_FRAMES;
    this.wins = this.slots.map(() => 0);
  }

  /** Slot indices, ascending. Every score, roster and hash in the game is indexed by these. */
  get slots(): readonly number[] {
    return this.spawns.map((spawn) => spawn.slot);
  }

  get teamBased(): boolean {
    return modeDef(this.mode).teamBased;
  }

  /** Ticks left on the round clock, or null once it has stopped. */
  get roundTimeLeft(): number | null {
    return this.phase === 'fighting' || this.phase === 'ko'
      ? Math.max(0, this.roundTimeLimitFrames - this.roundTime)
      : null;
  }

  /**
   * Whether the world is frozen and every fighter's input should be discarded this tick.
   *
   * True for the whole of the countdown and the knockout hold, and for the victory and rematch
   * screens. A fighter cannot act, so accepting their input would let someone buffer a press
   * through the `FIGHT` banner and have it land on tick one.
   */
  get blocksInput(): boolean {
    return this.phase !== 'fighting';
  }

  /** Rounds a slot has won. */
  winsFor(slot: number): number {
    return this.wins[slot] ?? 0;
  }

  /**
 * Rounds a team has won, or 0 in a mode that has no teams.
 *
 * Taken as the maximum across the team's slots rather than their sum. Both members are credited
 * when a team takes a round — that is the record of *who* was standing at the end — but the team's
 * score is the number of rounds it has won, and adding its two members together would count every
 * round twice.
 *
 * A Free-For-All answers 0 rather than a number borrowed from slot 0: there are no teams in it, and
 * reporting slot 0's round count as "Team A" would invent a side that does not exist.
 */
winsForTeam(team: TeamId): number {
  if (!this.teamBased) {
    return 0;
  }
  let best = 0;
  for (const slot of slotsOfTeam(team)) {
    best = Math.max(best, this.wins[slot] ?? 0);
  }
  return best;
}

  /** Slots still standing. */
  aliveSlots(runner: MatchRunner): readonly number[] {
    return runner.fighters.filter((fighter) => !fighter.eliminated).map((fighter) => fighter.slot);
  }

  /** The announcement the HUD should be showing, or null while the fight is simply running. */
  banner(): MatchBanner | null {
    switch (this.phase) {
      case 'countdown': {
        const left = Math.max(0, this.countdownFrames - this.phaseFrame);
        // `FIGHT` replaces `READY` before the fight actually starts, so the word is on screen for
        // the opening exchange instead of appearing on the same tick the first hit can land.
        return this.phaseFrame <= READY_FRAMES
          ? {
              text: 'READY',
              tone: 'ready',
              framesLeft: Math.max(0, READY_FRAMES - this.phaseFrame),
              framesTotal: READY_FRAMES,
            }
          : { text: 'FIGHT', tone: 'fight', framesLeft: left, framesTotal: this.countdownFrames };
      }
      case 'ko': {
        const sub = this.lastKo === null ? undefined : `P${this.lastKo.slot + 1} K.O.'d`;
        return {
          text: 'K.O.',
          tone: 'ko',
          framesLeft: Math.max(0, this.koHoldFrames - this.phaseFrame),
          framesTotal: this.koHoldFrames,
          ...(sub === undefined ? {} : { sub }),
        };
      }
      case 'victory': {
        const sub = this.champion?.label;
        return {
          text: 'VICTORY',
          tone: 'victory',
          framesLeft: Math.max(0, this.victoryHoldFrames - this.phaseFrame),
          framesTotal: this.victoryHoldFrames,
          ...(sub === undefined ? {} : { sub }),
        };
      }
      case 'rematch':
        return {
          text: 'REMATCH',
          tone: 'rematch',
          framesLeft: Math.max(0, this.rematchHoldFrames - this.phaseFrame),
          framesTotal: this.rematchHoldFrames,
        };
      case 'fighting':
      default:
        return null;
    }
  }

  /**
   * Advance the match by one tick.
   *
   * `events` is the simulation's output for the same tick and is optional, but it is what lets the
   * KO banner name who landed the finishing blow: the rules watch for the hit whose defender is a
   * slot that has just gone down. Without it the banner still shows `K.O.`, just without a `by`.
   */
  step(runner: MatchRunner, events: readonly SimEvent[] = []): readonly ModeEvent[] {
    const out: ModeEvent[] = [];

    // The host rebuilds the world between rounds, and `MatchRunner.reset()` zeroes its tick counter
    // while doing it. Watching for the tick to step *backwards* is how the rules learn that a
    // genuinely new fight has started, rather than continuing to look at the board the previous
    // round finished on. It also fires when a LAN session swaps in a different `MatchRunner`
    // wholesale, which is the same thing from here.
    //
    // This matters because scoring a round and starting the next one are two separate acts: the
    // first belongs to the rules, the second to whoever owns the world. Between them the rules are
    // looking at a world where the winning team is *still* eliminated, and without this guard they
    // would re-decide the round they had just scored and hand out a second point for one knockout.
    if (this.lastTick >= 0 && runner.tick <= this.lastTick) {
      this.round += 1;
      this.roundTime = 0;
      this.downed.clear();
      this.lastKo = null;
      this.scoredRound = -1;
    }
    this.lastTick = runner.tick;

    this.phaseFrame += 1;

    switch (this.phase) {
      case 'countdown': {
        if (this.phaseFrame >= this.countdownFrames) {
          this.transition('fighting', runner, out);
        }
        return out;
      }

      case 'fighting': {
        // A round that has already been scored is not re-decided while the host rebuilds the world.
        if (this.scoredRound === this.round) {
          return out;
        }
        this.roundTime += 1;
        this.announceKnockouts(runner, events, out);

        const outcome = this.phaseFrame >= this.roundTimeLimitFrames
          ? (this.timedOut = true, this.standingOf(runner))
          : this.evaluate(runner);
        if (outcome !== null) {
          if (this.timedOut) {
            out.push({ type: 'timeout', tick: runner.tick, winner: outcome });
          }
          this.pending = outcome;
          this.transition('ko', runner, out);
        }
        return out;
      }

      case 'ko': {
        if (this.phaseFrame < this.koHoldFrames) {
          return out;
        }
        const winner = this.pending;
        this.pending = null;
        this.timedOut = false;
        this.scoredRound = this.round;
        if (winner !== null && winner.kind !== 'draw') {
          for (const slot of winner.slots) {
            this.wins[slot] = (this.wins[slot] ?? 0) + 1;
          }
        }
        const final = this.championLocked();
        out.push({
          type: 'round_won',
          tick: runner.tick,
          round: this.round,
          winner: winner ?? draw(),
          wins: [...this.wins],
          final,
        });
        if (final) {
          this.champion = winner ?? draw();
          out.push({
            type: 'match_over',
            tick: runner.tick,
            winner: this.champion,
            wins: [...this.wins],
          });
          this.transition('victory', runner, out);
        } else {
          // The round stays on the same number until the host rebuilds the world (detected by the
          // tick stepping backwards at the top of `step`). Until then `scoredRound` blocks any
          // further evaluation, so this completed round is never scored twice.
          this.phaseFrame = 0;
          this.transition('fighting', runner, out);
        }
        return out;
      }

      case 'victory': {
        if (this.phaseFrame >= this.victoryHoldFrames) {
          this.rematchVotes.clear();
          this.transition('rematch', runner, out);
        }
        return out;
      }

      case 'rematch': {
        if (this.phaseFrame >= this.rematchHoldFrames || this.everyoneWantsRematch(runner)) {
          this.startNewMatch(runner, out);
        }
        return out;
      }

      default:
        return out;
    }
  }

  /**
   * A slot's vote for an early rematch.
   *
   * Votes are only counted on the victory screen, which is the only screen a player can see a
   * countdown on. Dead slots keep their vote — a player who was knocked out still wants another
   * go — but the *skip* only happens once every living slot has voted, so nobody is dragged into
   * a rematch they did not agree to.
   */
  requestRematch(slot: number): boolean {
    if (this.phase !== 'victory' && this.phase !== 'rematch') {
      return false;
    }
    this.rematchVotes.add(slot);
    return true;
  }

  get rematchVotesCast(): number {
    return this.rematchVotes.size;
  }

  /** One line for the developer readout and the HUD's footer. */
  describe(): string {
    const score = this.teamBased
      ? `Team A ${this.winsForTeam('A')} — ${this.winsForTeam('B')} Team B`
      : this.slots.map((slot) => `P${slot + 1} ${this.winsForSlotText(slot)}`).join('  ');
    return `${modeDef(this.mode).label} · round ${this.round} · ${this.phase} · ${score}`;
  }

  private winsForSlotText(slot: number): string {
    return String(this.winsFor(slot));
  }

  /** Reset to the opening countdown with the score cleared. A rematch is a whole new match. */
  private startNewMatch(runner: MatchRunner, out: ModeEvent[]): void {
    this.round = 1;
    this.roundTime = 0;
    this.champion = null;
    this.pending = null;
    this.lastKo = null;
    this.downed.clear();
    this.rematchVotes.clear();
    this.scoredRound = -1;
    // The world is about to be rebuilt and its tick counter zeroed, so the backwards-tick detector
    // at the top of `step` must not read the next `reset()` as a *round* boundary on top of this.
    this.lastTick = -1;
    for (let slot = 0; slot < this.wins.length; slot += 1) {
      this.wins[slot] = 0;
    }
    out.push({ type: 'rematch', tick: runner.tick, round: this.round });
    this.transition('countdown', runner, out);
  }

  private transition(to: MatchPhase, runner: MatchRunner, out: ModeEvent[]): void {
    const from = this.phase;
    this.phase = to;
    this.phaseFrame = 0;
    out.push({ type: 'phase', tick: runner.tick, from, to, banner: this.banner() });
  }

  /** Announce each slot's knockout exactly once per round. */
  private announceKnockouts(runner: MatchRunner, events: readonly SimEvent[], out: ModeEvent[]): void {
    for (const fighter of runner.fighters) {
      if (!fighter.eliminated || this.downed.has(fighter.slot)) {
        continue;
      }
      this.downed.add(fighter.slot);
      // The finishing blow, if this tick produced one. Read out of the stream rather than tracked
      // across ticks, so an attacker landing two knockouts on one tick cannot be misattributed.
      const by = events.find(
        (event) => event.type === 'hit' && !event.guarded && event.defenderSlot === fighter.slot,
      );
      const bySlot = by !== undefined && by.type === 'hit' ? by.attackerSlot : null;
      this.lastKo = { slot: fighter.slot, by: bySlot };
      out.push({
        type: 'ko',
        tick: runner.tick,
        slot: fighter.slot,
        team: teamOfSlot(fighter.slot),
        by: bySlot,
      });
    }
  }

  /** Who has taken the round right now, or null while it is still being fought. */
  private evaluate(runner: MatchRunner): WinnerInfo | null {
    if (this.teamBased) {
      const teamAUp = this.teamStanding(runner, 0);
      const teamBUp = this.teamStanding(runner, 1);
      // Both teams can go down on the same tick — two trades. It is a draw, not a coin flip.
      if (teamAUp <= 0 && teamBUp <= 0) {
        return draw();
      }
      if (teamBUp <= 0) {
        return teamWinner('A');
      }
      if (teamAUp <= 0) {
        return teamWinner('B');
      }
      return null;
    }

    const standing = runner.fighters.filter((fighter) => !fighter.eliminated);
    if (standing.length > 1) {
      return null;
    }
    if (standing.length === 0) {
      return draw();
    }
    const survivor = standing[0] as Fighter;
    return {
      kind: 'slot',
      slots: [survivor.slot],
      label: `P${survivor.slot + 1} ${nameOf(survivor)}`,
    };
  }

  /**
   * Who leads on health when the round clock expires.
   *
   * Health is compared as a *ratio*, cross-multiplied rather than divided, so Jack-5's 1150 and
   * Jin's 950 are ranked on the same footing and the comparison stays exact integer arithmetic
   * inside the tick path. An exact tie is a draw: inventing a winner from a tie-break would be a
   * rule nobody was told about.
   */
  private standingOf(runner: MatchRunner): WinnerInfo {
    if (this.teamBased) {
      const a = this.teamHealthRatio(runner, 0);
      const b = this.teamHealthRatio(runner, 1);
      if (a === b) {
        return draw();
      }
      return teamWinner(a > b ? 'A' : 'B');
    }

    let best: Fighter | null = null;
    for (const fighter of runner.fighters) {
      if (fighter.eliminated) {
        continue;
      }
      if (best === null || beats(fighter, best)) {
        best = fighter;
      }
    }
    if (best === null) {
      return draw();
    }
    return { kind: 'slot', slots: [best.slot], label: `P${best.slot + 1} ${nameOf(best)}` };
  }

  /** Living members of a team. */
  private teamStanding(runner: MatchRunner, team: 0 | 1): number {
    let count = 0;
    for (const fighter of runner.fighters) {
      if (fighter.team === team && !fighter.eliminated) {
        count += 1;
      }
    }
    return count;
  }

  /** Combined health of a team, as an exact fraction of its combined maximum. */
  private teamHealthRatio(runner: MatchRunner, team: 0 | 1): { num: number; den: number } {
    let num = 0;
    let den = 0;
    for (const fighter of runner.fighters) {
      if (fighter.team !== team) {
        continue;
      }
      num += fighter.health;
      den += fighter.maxHealth;
    }
    return { num, den };
  }

  /** True once a slot (Free-For-All) or a team (2v2) has taken enough rounds to win the match. */
  private championLocked(): boolean {
    if (this.teamBased) {
      return this.winsForTeam('A') >= this.roundsToWin || this.winsForTeam('B') >= this.roundsToWin;
    }
    return this.slots.some((slot) => (this.wins[slot] ?? 0) >= this.roundsToWin);
  }

  private everyoneWantsRematch(runner: MatchRunner): boolean {
    const alive = this.aliveSlots(runner);
    return alive.length > 0 && alive.every((slot) => this.rematchVotes.has(slot));
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function draw(): WinnerInfo {
  return { kind: 'draw', slots: [], label: 'DRAW' };
}

function teamWinner(team: TeamId): WinnerInfo {
  return {
    kind: 'team',
    slots: [...slotsOfTeam(team)],
    label: `TEAM ${team}`,
  };
}

function nameOf(fighter: Fighter): string {
  return fighter.archetypeId.replace(/_/g, ' ');
}

/** Strict "health fraction" comparison: `a` is ahead of `b` if their ratios differ. */
function beats(a: Fighter, b: Fighter): boolean {
  const maxA = a.maxHealth <= 0 ? 1 : a.maxHealth;
  const maxB = b.maxHealth <= 0 ? 1 : b.maxHealth;
  const left = a.health * maxB;
  const right = b.health * maxA;
  if (left !== right) {
    return left > right;
  }
  // Equal health: the lower slot is the one the HUD already calls P1, so the tie-break is at least
  // consistent with what the player can see.
  return a.slot < b.slot;
}