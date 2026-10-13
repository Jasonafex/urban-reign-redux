/**
 * Frame measurement harness — shared by the determinism suite and the feel report.
 *
 * Both gates need the same number, so there is exactly one implementation here. A move's
 * frames are *measured*, never read back out of `MOVESET`: the harness puts a fighter through
 * the real state machine and counts how many ticks it spends in each phase.
 *
 * Three variants:
 *   - `measureMoveFrames` drives `fixedUpdate` directly (one tick at a time).
 *   - `measureMoveFramesAtRate` drives the sim through `startFixedLoop` at a synthetic display
 *     rate (30/60/144/240Hz), proving declared frame data is identical at every refresh rate.
 *   - `measureChainContact` runs one *button press* — a move plus every automatic link it
 *     throws — into a live opponent, because from Phase 1 a single press can be several
 *     contacts and "how long was the attacker busy" is only meaningful over the whole chain.
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

/**
 * Four fighters close enough to actually touch, one per archetype.
 *
 * `defaultSpawns()` stands in the four corners of the arena, which is right for the wall test and
 * useless for anything that needs fighters to meet: they never do, so a determinism scenario
 * driven by it proves very little. Both gates that run a scripted match use this instead.
 */
export function engagementSpawns() {
  const a = 0.7;
  return [
    { slot: 0, archetypeId: 'brad_hawk', x: -a, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'jack5', x: a, z: 0, facing: -1 },
    { slot: 2, archetypeId: 'jin_kazama', x: 0, z: -a, facing: 1 },
    { slot: 3, archetypeId: 'bryan_fury', x: 0, z: a, facing: -1 },
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
 * `spawns` is optional and defaults to the corner roster. Both gates pass an engagement roster
 * instead, because a determinism scenario that never touches another fighter deterministically
 * proves very little — see `engagementSpawns` in the suites.
 *
 * Both gates use this one driver — the determinism suite and the feel report must not each roll
 * their own version of "same elapsed time at 30/60/144/240Hz", or they will eventually disagree.
 */
export async function runScriptedMatchAtRate(sim, frameHz, targetTicks, inputsFor, spawns) {
  const { startFixedLoop, FixedStepAccumulator } = await loopApi();
  const runner = spawns === undefined ? new sim.MatchRunner() : new sim.MatchRunner(spawns);

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

// ---------------------------------------------------------------------------------------------
// Contact measurement
// ---------------------------------------------------------------------------------------------

/** Two fighters, the defender placed just inside the move's reach. */
export function contactSpawns(sim, def) {
  const distance = Math.max(0.4, def.reach - 0.3);
  return [
    { slot: 0, archetypeId: 'probe', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'opponent', x: distance, z: 0, facing: -1 },
  ];
}

/**
 * Throw one button press — the move plus every automatic link it chains into — at a live
 * opponent, and report what the simulation actually did.
 *
 * Returns `busyTicks`: how long the attacker was committed, which from Phase 1 covers the whole
 * automatic chain and every hitstop it earned along the way. The report compares that against
 * `chainFrameBudget(def) + chainHitstopBudget(def)`.
 */
export function measureChainContact(sim, def) {
  const runner = new sim.MatchRunner(contactSpawns(sim, def));
  const idle = sim.idleInput();
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  attacker.spaMeter = attacker.spaMax;
  const healthBefore = defender.health;

  let contacts = 0;
  let damageDealt = 0;
  let blocked = 0;
  let launched = 0;
  let busyTicks = 0;
  let defenderState = 'unknown';
  let measuredAirborne = false;

  const collect = (events) => {
    for (const event of events) {
      if (event.type !== 'hit') {
        continue;
      }
      contacts += 1;
      damageDealt += event.damage;
      if (event.guarded) blocked += 1;
      if (event.launcher) launched += 1;
    }
  };

  if (def.airOnly) {
    // Rig setup: place the victim mid-arc rather than launching them with another move.
    //
    // The obvious approach — have the attacker land a launcher and then juggle — does not work,
    // because any launch also costs the attacker their own recovery: by the time they are
    // actionable again the victim has already landed. Staging the state directly measures the move
    // that is actually under test instead of a second move's frame data, and it keeps the harness
    // from silently measuring a whiff.
    defender.state = 'launched';
    defender.stateFrame = 0;
    defender.juggleCount = 0;
    defender.y = Math.trunc(sim.FP_SCALE * 1.5);
    defender.vy = Math.trunc(sim.LAUNCH_VELOCITY * 0.6);
    defender.vx = 0;
    defender.vz = 0;
    defender.x = Math.trunc(attacker.x + def.reach * sim.FP_SCALE * 0.6);
    defender.z = attacker.z;
    measuredAirborne = defender.y > sim.AIRBORNE_Y;
  }

  const limit = sim.chainFrameBudget(def) + sim.chainHitstopBudget(def) + 60;

  // Phase 1: press until the move is actually accepted. It cannot simply be pressed on the first
  // tick, because after a launch the attacker is still in the launcher's hitstop and recovery and
  // the press would be swallowed — which would look like a move that whiffed.
  let pressTicks = 0;
  let accepted = false;
  while (pressTicks < 240 && !accepted) {
    const events = runner.fixedUpdate(sim.DT, [sim.idleInput({ attack: def.id }), idle]);
    pressTicks += 1;
    if (attacker.currentMove === def.id) {
      accepted = true;
      busyTicks = 1; // the accepting tick is frame 1 of the move
      collect(events);
      defenderState = defender.state;
    }
  }
  if (!accepted) {
    return { contacts, connected: false, damageDealt, healthLost: 0, blocked, launched, busyTicks, defenderState, airborne: measuredAirborne };
  }

  // Phase 2: run the press out. For an automatic chain `currentMove` never returns to null until
  // the last link finishes, so this is exactly the whole button press.
  while (busyTicks < limit) {
    const events = runner.fixedUpdate(sim.DT, [idle, idle]);
    busyTicks += 1;
    collect(events);
    defenderState = defender.state;
    if (busyTicks > 1 && attacker.currentMove === null && attacker.hitstop === 0) {
      break;
    }
  }

  return {
    contacts,
    connected: contacts > 0,
    damageDealt,
    healthLost: healthBefore - defender.health,
    blocked,
    launched,
    busyTicks,
    defenderState,
    airborne: measuredAirborne,
  };
}

/**
 * The same press, but with the defender guarding. Used to prove high/low reads actually block:
 * the report checks that a high guard stops a mid strike and a low guard stops a sweep, which is
 * the same rule the dodge windows answer.
 */
export function measureBlockedContact(sim, def, guard) {
  const runner = new sim.MatchRunner(contactSpawns(sim, def));
  const idle = sim.idleInput();
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  attacker.spaMeter = attacker.spaMax;
  const healthBefore = defender.health;

  let guarded = null;
  for (let ticks = 0; ticks < 60; ticks += 1) {
    const events = runner.fixedUpdate(sim.DT, [
      ticks === 0 ? sim.idleInput({ attack: def.id }) : idle,
      sim.idleInput({ guard }),
    ]);
    const hit = events.find((event) => event.type === 'hit');
    if (hit !== undefined) {
      guarded = hit.guarded;
      break;
    }
  }

  return { guarded, healthLost: healthBefore - defender.health };
}