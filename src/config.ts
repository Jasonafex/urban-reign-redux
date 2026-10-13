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

/** Free-roam walk speed in subunits per tick (~5.6 world units/second). */
export const WALK_SPEED = 90;

/** Peak upward velocity of a launched fighter, in subunits per tick. */
export const LAUNCH_VELOCITY = 700;

/** Height above which a fighter's position is considered airborne (subunits). */
export const AIRBORNE_Y = FP_SCALE;

/** Recovery frames a grounded fighter spends in `down` before waking up. */
export const KNOCKDOWN_FRAMES = 34;

/** Recovery frames a grounded fighter spends rising from `down` into `idle`. */
export const GETUP_FRAMES = 12;

/** Base health for every archetype in Phase 0 (1000 = 100%). */
export const DEFAULT_MAX_HEALTH = 1000;

/** Full Special Arts gauge. SPA 1 / SPA 2 / SPA 3 cost the fractions declared per move. */
export const DEFAULT_SPA_MAX = 100;

/** SPA gauge awarded to the defender on taking a hit. */
export const SPA_ON_HIT = 4;

/** SPA gauge awarded to the attacker on landing a hit. */
export const SPA_ON_LAND = 6;

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