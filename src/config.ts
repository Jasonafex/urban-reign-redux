/**
 * Simulation and presentation tuning constants.
 *
 * AGENTS.md §3.1: `src/config.ts` is shared pure data. Nothing here may read the DOM,
 * `performance.now()`, `Date.now()`, or any other ambient host state — the constants below
 * are the single source of truth for the fixed-timestep contract and are imported by the
 * headless test runner, the replay tools and the feel report exactly as the browser reads them.
 */

/** The simulation advances in whole ticks at a fixed rate; frame rate is decoupled. */
export const TICK_HZ = 60;

/** Nominal wall-clock duration of one simulation tick, in milliseconds. */
export const TICK_MS = 1000 / TICK_HZ;

/** Nominal duration of one simulation tick, in seconds. `fixedUpdate` accepts only this value. */
export const DT = 1 / TICK_HZ;

/**
 * Fixed-point scale. Positions and velocities are integer *subunits*; 1 world unit
 * equals 1024 subunits. Integer-only motion math is what makes the sim bit-identical
 * across platforms — no floats, no `Math.sin`/`Math.cos` in the tick path.
 */
export const FP_SCALE = 1024;

/**
 * Maximum number of simulation ticks a single rendered frame may consume. A stall
 * (tab restore, GC pause, alt-tab) is clamped instead of replayed, which prevents the
 * classic "spiral of death". Clamping is deterministic, so it never breaks replay.
 */
export const MAX_CATCHUP_TICKS = 5;

/** Square arena half-extent in world units (alley walls). Fighters are clamped to it. */
export const ARENA_HALF_EXTENT = 9;

/** Gravity in subunits per tick squared. Integer, so landing frames are reproducible. */
export const GRAVITY_PER_TICK = 26;

/**
 * Air-drag divisor applied to horizontal velocity while a fighter is `launched`. Each airborne
 * tick sheds `vx / AIR_FRICTION_DIVISOR`, so a launch carries the victim a bounded distance and
 * leaves them inside the reach of the juggle tools that are supposed to keep them there. Integer
 * division keeps this bit-identical; at 4 the total drift is about four times the initial push.
 */
export const AIR_FRICTION_DIVISOR = 4;

/** Free-roam walk speed in subunits per tick (~5.6 world units/second). */
export const WALK_SPEED = 90;

/**
 * Peak upward velocity of a launched fighter, in subunits per tick.
 *
 * Tuned for a 60Hz brawler arc rather than the Phase 0 stub: at 700 the apex was 9.2 world units
 * — half the width of the arena — and the victim spent most of the jump beyond the reach of
 * anything that could follow them up. At 420 the apex is about 3.3 units and the arc lasts 32
 * ticks, which is long enough to land three aerial hits inside `JUGGLE_LIMIT` and short enough
 * that a whiffed juggle reads as a mistake rather than a stall.
 */
export const LAUNCH_VELOCITY = 420;

/** Height above which a fighter's position is considered airborne (subunits). */
export const AIRBORNE_Y = FP_SCALE;

/** Recovery frames a grounded fighter spends in `down` before waking up. */
export const KNOCKDOWN_FRAMES = 34;

/**
 * Recovery frames a grounded fighter spends rising from `down` into `idle`.
 * The whole of this window is the get-up roll and is **invulnerable** (AGENTS.md §5: a
 * knockdown is never a setup for a free follow-up), so it is a defensive resource and not
 * dead time — which is why it is long enough to matter.
 */
export const GETUP_FRAMES = 18;

/**
 * Hard cap on aerial hits taken before a fighter stops being juggleable (Phase 1).
 * The counter is the number of aerial strikes taken *since leaving the ground*; a grounded
 * hit or a landing resets it to zero. The fourth aerial hit is refused outright and the
 * victim falls out of the juggle, so no archetype can loop a launch indefinitely.
 */
export const JUGGLE_LIMIT = 3;

/** Total frames a high/low dodge occupies, slip window included. */
export const DODGE_TOTAL_FRAMES = 16;

/**
 * First tick (counted from 1 on the accepting tick) on which the dodge is evasive.
 * Frames 1 are the commitment — the move cannot be cancelled out of them.
 */
export const DODGE_SLIP_START = 2;

/** Length of the evasive window. A high dodge slips high/mid strikes, a low dodge hops sweeps. */
export const DODGE_SLIP_FRAMES = 7;

/**
 * Length of the frame-perfect window at the *front* of the slip window. An attack that
 * impacts here does not merely get evaded: it is countered with the archetype's reversal.
 */
export const DODGE_REVERSAL_FRAMES = 4;

/** Frames after the slip window closes during which the dodge can no longer be cancelled. */
export const DODGE_RECOVERY_FRAMES = 10;

/** Ticks after a dodge ends during which the fighter may not dodge again. */
export const DODGE_COOLDOWN_FRAMES = 18;

/** Frames after a connecting chain link during which the next link may be branched into. */
export const CHAIN_CANCEL_WINDOW = 14;

/** Frames a fighter is locked out of starting a new chain after whiffing one. */
export const WHIFF_LOCKOUT_FRAMES = 16;

/** Base health for every archetype in Phase 0 (1000 = 100%). */
export const DEFAULT_MAX_HEALTH = 1000;

/** Full Special Arts gauge. SPA 1 / SPA 2 / SPA 3 cost the fractions declared per move. */
export const DEFAULT_SPA_MAX = 100;

/** SPA gauge awarded to the defender on taking a hit. */
export const SPA_ON_HIT = 4;

/** SPA gauge awarded to the attacker on landing a hit. */
export const SPA_ON_LAND = 6;

// ---------------------------------------------------------------------------------------------
// Match lifecycle (Phase 5: game modes and the round/knockout clock)
//
// All of these are in whole ticks, because the match clock shares the simulation's clock. A
// countdown driven by `Date.now()` would run a tenth of a second long on a 144Hz host and would
// not agree with a peer's copy of the same match — the whole lifecycle would have to be
// renegotiated over the wire. Ticks are already agreed on, so the lifecycle is free to ride them.
// ---------------------------------------------------------------------------------------------

/**
 * Ticks the pre-round countdown runs before the fighters may act.
 *
 * Split into two announcements: `READY_FRAMES` of `READY`, then `FIGHT_BANNER_FRAMES` of `FIGHT`.
 * The second one exists because a banner that appears on the same tick the fighters may act has
 * already been missed by the time anyone reads it — the fight starts under the tail of the word.
 */
export const COUNTDOWN_FRAMES = 165;

/** Ticks the `READY` announcement is up before `FIGHT` replaces it. */
export const READY_FRAMES = 120;

/** Ticks `FIGHT` stays up after the countdown, overlapping the opening of the fight. */
export const FIGHT_BANNER_FRAMES = COUNTDOWN_FRAMES - READY_FRAMES;

/**
 * Ticks the world holds after the final knockout before the round is scored.
 *
 * Long enough for the camera to settle on the pair that finished each other and for the `KO`
 * banner to be read at all. Input is locked out for the duration, so this cannot be used to steal
 * a free hit.
 */
export const KO_HOLD_FRAMES = 100;

/** Ticks the victory screen is held before a rematch vote is opened. */
export const VICTORY_HOLD_FRAMES = 300;

/** Ticks the rematch announcement is held before the next match loads. */
export const REMATCH_HOLD_FRAMES = 180;

/** Arcade round clock: 99 seconds, the same budget a coin-op brawler gives a round. */
export const ROUND_TIME_LIMIT_FRAMES = 99 * TICK_HZ;

/** Rounds a slot or a team must win to take the match. Best of three. */
export const ROUNDS_TO_WIN = 2;

/** Tuning for the presentation layer only. The sim must never read these. */
export const RENDER = {
  fov: 55,
  near: 0.1,
  far: 400,
  /** Camera boom: pulled back and above the lock-on midpoint. */
  cameraHeight: 6.5,
  cameraDistance: 9,
  cameraLookHeight: 1.4,
  /** Headless-safe guard for the presentation layer. */
  maxPixelRatio: 2,
} as const;