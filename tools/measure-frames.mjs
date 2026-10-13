/**
 * Frame measurement harness — shared by the determinism suite and the feel report.
 *
 * Both gates need the same number, so there is exactly one implementation here. A move's
 * frames are *measured*, never read back out of `MOVESET`: the harness puts a fighter through
 * the real state machine and counts how many ticks it spends in each phase.
 *
 * Two variants:
 *   - `measureMoveFrames` drives `fixedUpdate` directly (one tick at a time).
 *   - `measureMoveFramesAtRate` drives the sim through `startFixedLoop` at a synthetic display
 *     rate (30/60/144/240Hz), proving declared frame data is identical at every refresh rate.
 *
 * Measurement rules:
 *   - The accepting tick is the first sample. `startup` counts ticks up to and including it.
 *   - The dummy is spawned far outside every move's reach, so frames are measured on a *whiff*
 *     and are not stretched by hitstop.
 */

const DUMMY_SPAWN = { slot: 1, archetypeId: 'frame_probe_dummy', x: 40, z: 40, facing: -1 };
const PROBE_SPAWN = { slot: 0, archetypeId: 'frame_probe', x: 0, z: 0, facing: 1 };

/**
 * `src/core/loop` is a separate bundle from the sim graph (it is the clock boundary, not part of
 * the simulation), so it is loaded here rather than being re-exported through the sim entry.
 */
let loopApiPromise = null;
function loopApi() {
  if (loopApiPromise === null) {
    loopApiPromise = import('./load-sim.mjs').then((module) => module.loadLoop());
  }
  return loopApiPromise;
}

function probeSpawns() {
  return [
    { ...PROBE_SPAWN, facing: 1 },
    { ...DUMMY_SPAWN, facing: -1 },
  ];
}

/** Reduce a per-tick state log to measured frame counts. */
export function classifyFrames(samples) {
  const firstActive = samples.findIndex((sample) => sample.state === 'active');
  if (firstActive === -1) {
    return { startup: -1, active: 0, recovery: 0, total: 0, complete: false };
  }
  const startup = firstActive + 1;
  let active = 0;
  while (samples[firstActive + active]?.state === 'active') {
    active += 1;
  }
  let recovery = 0;
  while (samples[firstActive + active + recovery]?.state === 'recovery') {
    recovery += 1;
  }
  return { startup, active, recovery, total: startup + active + recovery, complete: true };
}

function trimSamples(samples) {
  const firstActive = samples.findIndex((sample) => sample.state === 'active');
  if (firstActive === -1) {
    return samples;
  }
  // Everything from the move's completion back to `idle` is not part of the frame window.
  const end = samples.findIndex((sample, index) => index > firstActive && sample.currentMove === null);
  return end === -1 ? samples : samples.slice(0, end);
}

/** Measure one move by ticking the simulation directly, one tick per call. */
export function measureMoveFrames(sim, moveId) {
  const runner = new sim.MatchRunner(probeSpawns());
  const idle = sim.idleInput();
  const attack = sim.idleInput({ attack: moveId });
  const pair = (input) => [input, idle];

  // Measurement rig, not gameplay: SPA moves are gated on gauge, so the probe is charged before
  // the move is requested. Without this the special arts would never leave `idle` and their
  // frames would read as zero.
  runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;

  const samples = [];
  runner.fixedUpdate(sim.DT, pair(attack)); // accepting tick is sample 0
  samples.push({ state: runner.fighterAt(0).state, currentMove: runner.fighterAt(0).currentMove });

  for (let i = 0; i < 240 && samples.length < 240; i += 1) {
    runner.fixedUpdate(sim.DT, pair(idle));
    const fighter = runner.fighterAt(0);
    samples.push({ state: fighter.state, currentMove: fighter.currentMove });
    if (fighter.currentMove === null && fighter.state === 'idle' && samples.length > 1) {
      break;
    }
  }
  return classifyFrames(trimSamples(samples));
}

/**
 * Run a scripted match at a synthetic display rate and return its final state.
 *
 * `targetTicks` is exact: frames are pumped only while the whole frame fits inside the remaining
 * budget, and any leftover ticks are stepped directly. A frame cannot be pumped partially, so
 * without that top-up two rates can land one tick apart and the hashes would not be comparable.
 *
 * Both gates use this one driver — the determinism suite and the feel report must not each roll
 * their own version of "same elapsed time at 30/60/144/240Hz", or they will eventually disagree.
 */
export async function runScriptedMatchAtRate(sim, frameHz, targetTicks, inputsFor) {
  const { startFixedLoop, FixedStepAccumulator } = await loopApi();
  const runner = new sim.MatchRunner();

  // Plan the frame cadence with an accumulator so the loop can be pumped frame by frame without
  // ever being asked for a partial batch.
  const planner = new FixedStepAccumulator();
  const frameBudget = Math.ceil(frameHz * (targetTicks / sim.TICK_HZ)) + 8;
  const plan = [];
  for (let frame = 0; frame < frameBudget; frame += 1) {
    plan.push(planner.advance(1000 / frameHz));
  }

  let executed = 0;
  const loop = startFixedLoop({
    fixedUpdate: () => runner.fixedUpdate(sim.DT, inputsFor(runner, runner.tick)),
    host: { now: () => 0, schedule: () => 0, cancel: () => {} },
  });

  for (const ticks of plan) {
    if (executed + ticks > targetTicks) {
      break;
    }
    loop.pump(1000 / frameHz);
    executed += ticks;
  }
  loop.stop();

  while (executed < targetTicks) {
    runner.fixedUpdate(sim.DT, inputsFor(runner, runner.tick));
    executed += 1;
  }

  return {
    ticks: runner.tick,
    hash: runner.stateHash(),
    frames: loop.stats.frameCount,
    droppedTicks: loop.stats.droppedTicks,
  };
}

/**
 * Measure one move by driving the simulation through the fixed-step loop at `frameHz`.
 * The loop host never self-schedules: frames are pumped explicitly so the harness controls time.
 */
export async function measureMoveFramesAtRate(sim, moveId, frameHz, maxFrames = 600) {
  const runner = new sim.MatchRunner(probeSpawns());
  const idle = sim.idleInput();
  const samples = [];
  let tick = 0;

  // Same rig charge as `measureMoveFrames` so both variants measure the same move identically.
  runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;

  const loop = (await loopApi()).startFixedLoop({
    fixedUpdate: (dt) => {
      const input = tick === 0 ? sim.idleInput({ attack: moveId }) : idle;
      runner.fixedUpdate(dt, [input, idle]);
      const fighter = runner.fighterAt(0);
      samples.push({ state: fighter.state, currentMove: fighter.currentMove });
      tick += 1;
    },
    host: { now: () => 0, schedule: () => 0, cancel: () => {} },
  });

  for (let frame = 0; frame < maxFrames && tick < 240; frame += 1) {
    loop.pump(1000 / frameHz);
  }
  loop.stop();

  return {
    ...classifyFrames(trimSamples(samples)),
    ticks: tick,
    frames: loop.stats.frameCount,
    droppedTicks: loop.stats.droppedTicks,
  };
}