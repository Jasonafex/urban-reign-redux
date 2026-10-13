/**
 * Fixed-timestep loop.
 *
 * This is the only place wall-clock time is allowed to exist, and it exists solely to decide
 * *how many* whole 60Hz ticks to run — never *what* a tick does. `FixedStepAccumulator` itself
 * is pure arithmetic over a sequence of frame deltas, which is why `test/determinism.test.mjs`
 * can drive it from Node with synthetic frame rates and prove that a 30Hz, 60Hz, 144Hz or 240Hz
 * host produces identical simulation state.
 *
 * AGENTS.md §3.2: display refresh rate must never change the outcome of a match.
 */

import { MAX_CATCHUP_TICKS, TICK_MS, DT } from '../config';

/** Boundary tolerance for tick comparisons, in milliseconds (1 tick is 16.67ms). */
const TICK_EPSILON_MS = 1e-6;

/** Wall-clock source and frame scheduler, injected so the loop is testable headlessly. */
export interface LoopHost {
  now(): number;
  schedule(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

export interface LoopStats {
  /** Rendered frames observed. */
  frameCount: number;
  /** Simulation ticks executed. */
  tickCount: number;
  /** Ticks executed by the most recent frame. */
  lastTickCount: number;
  /** Ticks discarded because a frame overran MAX_CATCHUP_TICKS (tab restore, GC pause). */
  droppedTicks: number;
}

export interface FixedLoopOptions {
  /** Called once per simulation tick with the fixed dt. */
  fixedUpdate: (dt: number) => void;
  /** Called once per rendered frame, after all ticks for that frame. */
  render?: (frameCount: number) => void;
  /** Override the host (tests, replay tooling). Defaults to the browser host when present. */
  host?: LoopHost;
  /** Ticks per frame ceiling. Defaults to MAX_CATCHUP_TICKS. */
  maxTicksPerFrame?: number;
  /** Fixed dt handed to `fixedUpdate`. Defaults to 1/60. */
  dt?: number;
}

export interface FixedLoopHandle {
  /** Begin self-driving off the host scheduler (rAF in the browser). */
  start(): void;
  stop(): void;
  readonly running: boolean;
  readonly stats: Readonly<LoopStats>;
  /**
   * Pump the loop with one synthetic frame. Returns the tick count executed.
   * Exposed so replay tooling and the determinism suite can drive the loop without a browser.
   */
  pump(frameDeltaMs: number): number;
}

/**
 * Converts a sequence of render-frame deltas into whole simulation ticks.
 *
 * Two properties matter for netcode:
 *   - **Repeatable**: the same delta sequence always yields the same tick count.
 *   - **Bounded**: a delta larger than `maxTicks` ticks is clamped and the surplus is dropped,
 *     so a long stall cannot produce an unbounded catch-up burst.
 */
export class FixedStepAccumulator {
  private accumulatorMs = 0;
  private dropped = 0;

  constructor(private readonly maxTicksPerFrame: number = MAX_CATCHUP_TICKS) {
    if (!Number.isInteger(maxTicksPerFrame) || maxTicksPerFrame < 1) {
      throw new RangeError(`maxTicksPerFrame must be a positive integer, got ${maxTicksPerFrame}`);
    }
  }

  /** Feed one rendered frame's elapsed milliseconds; returns how many ticks to run now. */
  advance(frameDeltaMs: number): number {
    if (!Number.isFinite(frameDeltaMs) || frameDeltaMs < 0) {
      throw new RangeError(`Frame delta must be a finite, non-negative number, got ${frameDeltaMs}`);
    }
    // Clamp the incoming delta before accumulating: a 5 second stall is at most
    // `maxTicksPerFrame` ticks of catch-up. The discarded surplus is *counted*, not banked, so
    // the loop can report how much simulated time was thrown away (tab restore, GC pause).
    const clamped = Math.min(frameDeltaMs, this.maxTicksPerFrame * TICK_MS);
    if (frameDeltaMs > clamped) {
      this.dropped += Math.floor((frameDeltaMs - clamped) / TICK_MS);
    }
    this.accumulatorMs += clamped;

    // The tick boundary is compared with a tolerance because 1/60s is not representable in
    // binary floating point. Without it, a delta of exactly N ticks (or a long run of small
    // deltas) loses the final tick to residue and the frame yields N-1 ticks. The tolerance is
    // ~10 million times smaller than a tick, so it cannot manufacture a tick that is not there.
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS - TICK_EPSILON_MS && ticks < this.maxTicksPerFrame) {
      this.accumulatorMs -= TICK_MS;
      ticks += 1;
    }
    if (this.accumulatorMs >= TICK_MS - TICK_EPSILON_MS) {
      const surplus = Math.max(1, Math.floor(this.accumulatorMs / TICK_MS));
      this.dropped += surplus;
      this.accumulatorMs = 0;
    }
    return ticks;
  }

  /** Sub-tick remainder retained for the next frame, in milliseconds. */
  get pendingMs(): number {
    return this.accumulatorMs;
  }

  get droppedTicks(): number {
    return this.dropped;
  }

  reset(): void {
    this.accumulatorMs = 0;
    this.dropped = 0;
  }
}

/** Browser host using requestAnimationFrame. Only constructed when those globals exist. */
function detectHost(): LoopHost | null {
  if (
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.performance === 'object' &&
    typeof globalThis.performance?.now === 'function'
  ) {
    const raf = globalThis.requestAnimationFrame.bind(globalThis);
    const caf = globalThis.cancelAnimationFrame?.bind(globalThis) ?? (() => {});
    const now = globalThis.performance.now.bind(globalThis.performance);
    return {
      now,
      schedule: (callback) => raf(callback),
      cancel: (handle) => caf(handle),
    };
  }
  if (typeof globalThis.setTimeout === 'function') {
    return {
      // Headless fallback: the caller pumps frames manually, so `now` is only a stub. Timer
      // handles are `number` in the browser but `Timeout` when @types/node is loaded by a
      // dependency's d.ts, so the handle type is reconciled at this one boundary.
      now: () => 0,
      schedule: (callback) =>
        globalThis.setTimeout(() => callback(0), Math.round(TICK_MS)) as unknown as number,
      cancel: (handle) =>
        globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
    };
  }
  return null;
}

/**
 * Start the fixed-timestep loop. In a browser it self-drives off requestAnimationFrame;
 * headless it still returns a working handle whose `pump()` drives ticks deterministically.
 */
export function startFixedLoop(options: FixedLoopOptions): FixedLoopHandle {
  const dt = options.dt ?? DT;
  const maxTicksPerFrame = options.maxTicksPerFrame ?? MAX_CATCHUP_TICKS;
  const accumulator = new FixedStepAccumulator(maxTicksPerFrame);
  const host = options.host ?? detectHost();
  const stats: LoopStats = { frameCount: 0, tickCount: 0, lastTickCount: 0, droppedTicks: 0 };

  let running = false;
  let handle: number | null = null;
  let lastTimestampMs: number | null = null;

  const pump = (frameDeltaMs: number): number => {
    const ticks = accumulator.advance(frameDeltaMs);
    for (let i = 0; i < ticks; i += 1) {
      options.fixedUpdate(dt);
    }
    stats.frameCount += 1;
    stats.tickCount += ticks;
    stats.lastTickCount = ticks;
    stats.droppedTicks = accumulator.droppedTicks;
    options.render?.(stats.frameCount);
    return ticks;
  };

  const scheduleFrame = (): void => {
    if (!running || host === null) {
      return;
    }
    handle = host.schedule((timestampMs: number) => {
      if (lastTimestampMs === null) {
        lastTimestampMs = timestampMs;
      }
      const delta = timestampMs - lastTimestampMs;
      lastTimestampMs = timestampMs;
      pump(delta);
      scheduleFrame();
    });
  };

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      lastTimestampMs = null;
      scheduleFrame();
    },
    stop(): void {
      if (!running) {
        return;
      }
      running = false;
      if (handle !== null && host !== null) {
        host.cancel(handle);
      }
      handle = null;
    },
    get running(): boolean {
      return running;
    },
    get stats(): Readonly<LoopStats> {
      return stats;
    },
    pump,
  };
}