/**
 * Determinism, replay-fidelity and architecture gate (`npm test`).
 *
 * These are the properties AGENTS.md §3.1/§3.2/§3.3 make non-negotiable, and they are the
 * properties that quietly rot if nobody checks them. The suite runs the *real* TypeScript
 * sources through esbuild (see `tools/load-sim.mjs`), headless, with no browser globals.
 *
 * Covered:
 *   - identical inputs produce identical state hashes and identical event streams
 *   - `fixedUpdate` refuses a variable timestep
 *   - 30 / 60 / 144 / 240Hz hosts produce identical simulation state
 *   - long stalls are clamped, never replayed in a burst
 *   - `stateHash()` covers every field that can influence a future tick
 *   - snapshot save/restore round-trips, and a restored snapshot replays to the same hash
 *   - declared MOVESET frame data matches measured frame data, at every refresh rate
 *   - the simulation bundle contains no DOM, WebGL, wall-clock or randomness dependency
 *   - hitstop, guarding, SPA gating and elimination behave as declared
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSources, cleanup, loadSim, loadLoop } from '../tools/load-sim.mjs';
import {
  measureMoveFrames,
  measureMoveFramesAtRate,
  runScriptedMatchAtRate,
} from '../tools/measure-frames.mjs';

const sim = await loadSim();
const loopModule = await loadLoop();
const sources = await buildSources();

const {
  MatchRunner,
  MOVESET,
  STANCES,
  STATE_HASH_FIELDS,
  CHAIN_PRESS,
  DT,
  TICK_MS,
  MAX_CATCHUP_TICKS,
  FP_SCALE,
  getMove,
  idleInput,
} = sim;
const { FixedStepAccumulator, startFixedLoop } = loopModule;

const REFRESH_RATES = [30, 60, 144, 240];
const SIM_SECONDS = 3;

/**
 * Four fighters close enough to actually touch. The default roster stands in the four corners of
 * the arena, which is right for the wall test and useless for a determinism scenario — nothing
 * ever meets, so the check would pass on a simulation that never resolved a single hit. Shared
 * with the feel report so the two can never drift apart.
 */
const { engagementSpawns } = await import('../tools/measure-frames.mjs');

/**
 * Deterministic input script. Derived only from (slot, tick) so any two runs asking for the
 * same tick get the same inputs — the scenario itself carries no hidden state.
 */
function scenarioFor(runner, tick) {
  return runner.fighters.map((fighter) => {
    const phase = (tick + fighter.slot * 13) % 48;
    // Chain presses resolve against a stance, so rotating the stance walks a fighter through all
    // four directional branches of its archetype over the run.
    const stance = STANCES[phase % 4];
    let attack = null;
    if (phase === 0 || phase === 20) attack = CHAIN_PRESS;
    else if (phase === 12) attack = 'straight';
    else if (phase === 30) attack = 'low_sweep';
    else if (phase === 36) attack = 'grab_high';
    const moveX = phase % 3 === 0 ? 1 : phase % 3 === 1 ? -1 : 0;
    const moveZ = phase % 5 === 0 ? 1 : 0;
    const guard = phase % 6 === 4 ? 'high' : phase % 7 === 5 ? 'low' : 'none';
    const dodge = phase % 9 === 2 ? 'high' : phase % 9 === 5 ? 'low' : 'none';
    void fighter;
    return idleInput({ moveX, moveZ, attack, guard, stance, dodge });
  });
}

/** Two fighters in jab range, facing each other. */
function closeRangeSpawns() {
  return [
    { slot: 0, archetypeId: 'probe', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'opponent', x: 1, z: 0, facing: -1 },
  ];
}

/**
 * Tick until a hit lands (or the move runs out). Attacks only become live on their startup
 * frames, so a single tick after the input never produces contact.
 */
function tickUntilHit(runner, inputs, maxTicks = 60) {
  const events = [];
  for (let i = 0; i < maxTicks; i += 1) {
    const tickEvents = runner.fixedUpdate(DT, inputs);
    events.push(...tickEvents);
    const hit = tickEvents.find((event) => event.type === 'hit');
    if (hit !== undefined) {
      return { hit, events, ticks: i + 1 };
    }
  }
  throw new Error(`no hit within ${maxTicks} ticks`);
}

test('headless: no browser globals are present while the sim runs', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const runner = new MatchRunner(engagementSpawns());
  runner.fixedUpdate(DT, scenarioFor(runner, 0));
  assert.equal(runner.tick, 1);
});

test('identical inputs produce identical state hashes and event streams over 600 ticks', () => {
  const a = new MatchRunner(engagementSpawns());
  const b = new MatchRunner(engagementSpawns());
  const eventsA = [];
  const eventsB = [];

  for (let tick = 0; tick < 600; tick += 1) {
    eventsA.push(...a.fixedUpdate(DT, scenarioFor(a, tick)));
    eventsB.push(...b.fixedUpdate(DT, scenarioFor(b, tick)));
    assert.equal(a.stateHash(), b.stateHash(), `hash diverged at tick ${tick + 1}`);
  }

  assert.deepEqual(eventsA, eventsB, 'event streams must be identical');
  // Guard against a vacuous pass: the scenario has to actually fight.
  assert.ok(eventsA.some((event) => event.type === 'hit'), 'scenario produced no hits');
  assert.ok(eventsA.some((event) => event.type === 'wallImpact'), 'scenario never reached a wall');
  assert.ok(
    a.fighters.some((fighter) => fighter.health < fighter.maxHealth),
    'scenario dealt no damage',
  );
});

test('fixedUpdate rejects any timestep that is not 1/60', () => {
  const runner = new MatchRunner(engagementSpawns());
  assert.throws(() => runner.fixedUpdate(1 / 30), RangeError);
  assert.throws(() => runner.fixedUpdate(1 / 120), RangeError);
  assert.throws(() => runner.fixedUpdate(Number.NaN), RangeError);
  assert.doesNotThrow(() => runner.fixedUpdate(DT));
  assert.equal(runner.tick, 1);
});

test(`display refresh rate (${REFRESH_RATES.join('/')}Hz) does not change simulation state`, async () => {
  // The accumulator's own accounting: the same elapsed time must never differ by more than a
  // tick of floating-point residue between refresh rates.
  const totals = REFRESH_RATES.map((frameHz) => {
    const accumulator = new FixedStepAccumulator();
    let total = 0;
    for (let frame = 0; frame < Math.round(frameHz * SIM_SECONDS); frame += 1) {
      total += accumulator.advance(1000 / frameHz);
    }
    assert.equal(accumulator.droppedTicks, 0, `${frameHz}Hz dropped ticks on a clean cadence`);
    return total;
  });
  assert.ok(
    Math.max(...totals) - Math.min(...totals) <= 1,
    `tick totals diverged by more than one: ${totals.join(', ')}`,
  );
  assert.ok(
    Math.abs(totals[1] - SIM_SECONDS * 60) <= 1,
    `60Hz session should yield ~${SIM_SECONDS * 60} ticks, got ${totals[1]}`,
  );

  // And the simulation itself: an identical scripted match run at each rate must hash the same.
  const commonTicks = Math.min(...totals);
  const hashes = [];
  for (const frameHz of REFRESH_RATES) {
    const result = await runScriptedMatchAtRate(sim, frameHz, commonTicks, scenarioFor, engagementSpawns());
    assert.equal(result.ticks, commonTicks, `${frameHz}Hz did not land on ${commonTicks} ticks`);
    hashes.push({ frameHz, hash: result.hash });
  }
  const unique = new Set(hashes.map((entry) => entry.hash));
  assert.equal(unique.size, 1, `state diverged by refresh rate: ${JSON.stringify(hashes)}`);
});

test('a long stall is clamped instead of replayed in a burst', () => {
  const accumulator = new FixedStepAccumulator();
  assert.equal(accumulator.advance(5000), MAX_CATCHUP_TICKS);
  assert.ok(accumulator.droppedTicks > 0, 'surplus ticks must be reported as dropped');

  // Repeated stalls must not bank time: each one yields exactly the ceiling, never more.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(accumulator.advance(5000), MAX_CATCHUP_TICKS);
  }
  assert.equal(accumulator.pendingMs < TICK_MS, true, 'accumulator banked a backlog');

  // And a clamped loop still advances the sim by exactly that many ticks.
  const runner = new MatchRunner(engagementSpawns());
  const loop = loopModule.startFixedLoop({
    fixedUpdate: () => runner.fixedUpdate(DT, scenarioFor(runner, runner.tick)),
    host: { now: () => 0, schedule: () => 0, cancel: () => {} },
  });
  const executed = loop.pump(5000);
  assert.equal(executed, MAX_CATCHUP_TICKS);
  assert.equal(runner.tick, MAX_CATCHUP_TICKS);
  assert.equal(loop.stats.droppedTicks > 0, true);
  loop.stop();
});

test('stateHash covers every field that can influence a future tick', () => {
  // Every mutation must be guaranteed to change the value it targets, otherwise the test would
  // pass by hashing a field it never actually altered.
  const mutations = {
    slot: (f) => f.slot + 7,
    archetypeId: (f) => `${f.archetypeId}_mut`,
    x: (f) => f.x + 1,
    y: (f) => f.y + 999,
    z: (f) => f.z - 1,
    vx: (f) => f.vx + 3,
    vy: (f) => f.vy - 4,
    vz: (f) => f.vz + 7,
    facing: (f) => (f.facing === 1 ? -1 : 1),
    state: () => 'down',
    stateFrame: (f) => f.stateFrame + 5,
    currentMove: (f) => (f.currentMove === null ? 'heavy' : null),
    movePhaseFrame: (f) => f.movePhaseFrame + 3,
    health: (f) => f.health - 1,
    maxHealth: (f) => f.maxHealth + 1000,
    spaMeter: (f) => (f.spaMeter + 7) % (f.spaMax + 1),
    spaMax: (f) => f.spaMax + 5,
    eliminated: (f) => !f.eliminated,
    juggleCount: (f) => f.juggleCount + 1,
    hitstop: (f) => f.hitstop + 3,
    hitConnect: (f) => !f.hitConnect,
    hitConsumed: (f) => !f.hitConsumed,
    stunRemaining: (f) => f.stunRemaining + 8,
    blockstunLeft: (f) => f.blockstunLeft + 6,
    targetLockedSlot: (f) => (f.targetLockedSlot + 2) % 4,
    chainId: (f) => (f.chainId === '' ? 'jab' : ''),
    branchTarget: (f) => (f.branchTarget === '' ? 'jab' : ''),
    chainWindow: (f) => f.chainWindow + 4,
    whiffLockout: (f) => f.whiffLockout + 3,
    dodgeCooldown: (f) => f.dodgeCooldown + 6,
    chargeFrames: (f) => f.chargeFrames + 5,
    chargeRelease: (f) => !f.chargeRelease,
    chargeLevel: (f) => (f.chargeLevel + 1) % 6,
  };

  assert.deepEqual(
    [...STATE_HASH_FIELDS].sort(),
    Object.keys(mutations).sort(),
    'STATE_HASH_FIELDS and the mutation coverage list have drifted apart',
  );

  const baseline = new MatchRunner(engagementSpawns());
  for (let tick = 0; tick < 120; tick += 1) {
    baseline.fixedUpdate(DT, scenarioFor(baseline, tick));
  }
  const baselineHash = baseline.stateHash();

  for (const field of STATE_HASH_FIELDS) {
    const mutated = new MatchRunner(engagementSpawns());
    for (let tick = 0; tick < 120; tick += 1) {
      mutated.fixedUpdate(DT, scenarioFor(mutated, tick));
    }
    const fighter = mutated.fighterAt(0);
    const before = fighter[field];
    fighter[field] = mutations[field](fighter);
    assert.notEqual(fighter[field], before, `mutation for '${field}' was a no-op`);
    assert.notEqual(
      mutated.stateHash(),
      baselineHash,
      `mutating '${field}' left stateHash unchanged — it is not covered`,
    );
  }
});

test('save/restore round-trips exactly (AGENTS.md §3.3)', () => {
  const runner = new MatchRunner(engagementSpawns());
  for (let tick = 0; tick < 240; tick += 1) {
    runner.fixedUpdate(DT, scenarioFor(runner, tick));
  }
  const snapshot = runner.saveSnapshot();
  const hashAtSnapshot = runner.stateHash();

  for (let tick = 0; tick < 120; tick += 1) {
    runner.fixedUpdate(DT, scenarioFor(runner, tick));
  }
  assert.notEqual(runner.stateHash(), hashAtSnapshot, 'sim did not advance past the snapshot');

  runner.restoreSnapshot(snapshot);
  assert.equal(runner.stateHash(), hashAtSnapshot, 'restore(snapshot) did not reproduce the hash');
  assert.deepEqual(
    runner.fighters.map((fighter) => ({ ...fighter })),
    snapshot.fighters.map((fighter) => ({ ...fighter })),
  );
});

test('a restored snapshot replays forward to the same hash', () => {
  const original = new MatchRunner(engagementSpawns());
  for (let tick = 0; tick < 90; tick += 1) {
    original.fixedUpdate(DT, scenarioFor(original, tick));
  }
  const snapshot = original.saveSnapshot();
  for (let tick = 90; tick < 300; tick += 1) {
    original.fixedUpdate(DT, scenarioFor(original, tick));
  }
  const expected = original.stateHash();

  original.restoreSnapshot(snapshot);
  for (let tick = 90; tick < 300; tick += 1) {
    original.fixedUpdate(DT, scenarioFor(original, tick));
  }
  assert.equal(original.stateHash(), expected, 'replay from snapshot diverged');
});

test('declared MOVESET frame data matches measured frame data for every move', () => {
  for (const def of MOVESET) {
    const measured = measureMoveFrames(sim, def.id);
    assert.equal(measured.complete, true, `${def.id} never reached an active frame`);
    assert.equal(measured.startup, def.startup, `${def.id} startup mismatch`);
    assert.equal(measured.active, def.active, `${def.id} active mismatch`);
    assert.equal(measured.recovery, def.recovery, `${def.id} recovery mismatch`);
  }
});

test('measured frame data is identical at 30/60/144/240Hz', async () => {
  for (const def of MOVESET) {
    const measurements = [];
    for (const frameHz of REFRESH_RATES) {
      measurements.push({ frameHz, ...(await measureMoveFramesAtRate(sim, def.id, frameHz)) });
    }
    for (const measurement of measurements) {
      assert.equal(measurement.droppedTicks, 0, `${def.id} dropped ticks at ${measurement.frameHz}Hz`);
      assert.equal(measurement.startup, def.startup, `${def.id} startup at ${measurement.frameHz}Hz`);
      assert.equal(measurement.active, def.active, `${def.id} active at ${measurement.frameHz}Hz`);
      assert.equal(measurement.recovery, def.recovery, `${def.id} recovery at ${measurement.frameHz}Hz`);
    }
  }
});

test('the simulation bundle has no DOM, WebGL, wall-clock or randomness dependency', () => {
  // Sanity: the scan is looking at the real bundle, not an empty string.
  assert.ok(sources.sim.includes('MatchRunner'), 'sim bundle looks empty');

  // `window` and `document` are matched only as *used*, i.e. member access or a `typeof` probe.
  // A bare word-boundary match would also fire on an ordinary comment that happens to say
  // "dodge window", which makes the gate fail on prose instead of on code — and a gate that cries
  // wolf gets deleted. Everything that actually touches a DOM global still matches.
  const forbidden = [
    /\bdocument\s*[.[]/,
    /\btypeof\s+document\b/,
    /\bwindow\s*[.[]/,
    /\btypeof\s+window\b/,
    /\bAudioContext\b/,
    /\bWebGL\w*\b/,
    /\bTHREE\b/,
    /from\s*["']three["']/,
    /Math\.random/,
    /Date\.now/,
    /performance\.now/,
    /requestAnimationFrame/,
    /\bsetTimeout\b/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(sources.sim), false, `simulation bundle matches ${pattern}`);
  }

  // The loop is allowed to touch requestAnimationFrame (that is its job) but never the wall clock
  // inside a tick, and never randomness.
  assert.equal(/Math\.random/.test(sources.loop), false, 'loop uses Math.random');
  assert.equal(/Date\.now/.test(sources.loop), false, 'loop uses Date.now');
});

test('hitstop freezes the attacker for exactly the declared hitstop frames', () => {
  const jab = getMove('jab');

  // Whiff reference: total declared frames, no contact.
  const whiff = measureMoveFrames(sim, 'jab');
  assert.equal(whiff.total, jab.startup + jab.active + jab.recovery);

  // On contact the attacker is frozen for `hitstop` ticks before it can act again.
  const runner = new MatchRunner(closeRangeSpawns());
  const attacking = idleInput({ attack: 'jab' });
  const { hit, ticks: ticksToHit } = tickUntilHit(runner, [attacking, idleInput()]);
  assert.equal(hit.guarded, false);
  assert.equal(hit.hitstop, jab.hitstop);

  // The hit lands mid-move, so the attacker owes `hitstop` frozen ticks on top of the frames
  // it had already burned through.
  let ticks = ticksToHit;
  while (runner.fighterAt(0).currentMove !== null || runner.fighterAt(0).hitstop > 0) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    ticks += 1;
    assert.ok(ticks < 200, 'attacker never recovered');
  }
  assert.equal(ticks, whiff.total + jab.hitstop);
  assert.equal(runner.fighterAt(1).health, runner.fighterAt(1).maxHealth - jab.damage);
});

test('guarding converts a clean hit into a blocked hit', () => {
  const jab = getMove('jab');

  const clean = new MatchRunner(closeRangeSpawns());
  tickUntilHit(clean, [idleInput({ attack: 'jab' }), idleInput()]);
  assert.equal(clean.fighterAt(1).health, clean.fighterAt(1).maxHealth - jab.damage);

  const guarded = new MatchRunner(closeRangeSpawns());
  const { hit: blocked } = tickUntilHit(guarded, [
    idleInput({ attack: 'jab' }),
    idleInput({ guard: 'high' }),
  ]);
  assert.equal(blocked.guarded, true, 'high guard should block a high strike');
  assert.equal(blocked.damage, 0);
  assert.equal(blocked.blockstun, jab.blockstun);
  assert.equal(guarded.fighterAt(1).health, guarded.fighterAt(1).maxHealth);
  assert.equal(guarded.fighterAt(1).state, 'blockstun');

  // A sweep must beat a high guard and vice versa — that is the high/low read the table encodes.
  const sweepRunner = new MatchRunner(closeRangeSpawns());
  const { hit: sweep } = tickUntilHit(sweepRunner, [
    idleInput({ attack: 'low_sweep' }),
    idleInput({ guard: 'high' }),
  ]);
  assert.equal(sweep.guarded, false);

  const sweepGuarded = new MatchRunner(closeRangeSpawns());
  const { hit: sweepBlocked } = tickUntilHit(sweepGuarded, [
    idleInput({ attack: 'low_sweep' }),
    idleInput({ guard: 'low' }),
  ]);
  assert.equal(sweepBlocked.guarded, true, 'low guard should stop a sweep');
});

test('SPA moves are gated on gauge and emit an SpaEvent', () => {
  const empty = new MatchRunner(closeRangeSpawns());
  const refused = empty.fixedUpdate(DT, [idleInput({ attack: 'spa2' }), idleInput()]);
  assert.equal(refused.filter((event) => event.type === 'spa').length, 0);
  assert.equal(empty.fighterAt(0).state, 'idle', 'a move with no gauge must not start');
  assert.equal(empty.fighterAt(0).currentMove, null);

  const charged = new MatchRunner(closeRangeSpawns());
  charged.fighterAt(0).spaMeter = 100;
  const events = charged.fixedUpdate(DT, [idleInput({ attack: 'spa2' }), idleInput()]);
  const spa = events.find((event) => event.type === 'spa');
  assert.ok(spa, 'SPA 2 should emit an SpaEvent');
  assert.equal(spa.tier, 2);
  assert.equal(spa.gaugeSpent, 100);
  assert.equal(spa.gaugeRemaining, 0);
  assert.equal(charged.fighterAt(0).currentMove, 'spa2');
});

test('a fighter at zero health is eliminated and the match can end', () => {
  const runner = new MatchRunner(closeRangeSpawns());
  const jab = getMove('jab');
  const defender = runner.fighterAt(1);
  defender.health = jab.damage;

  tickUntilHit(runner, [idleInput({ attack: 'jab' }), idleInput()]);
  assert.equal(defender.health, 0);
  assert.equal(defender.eliminated, true);
  assert.equal(runner.aliveCount, 1);
  assert.equal(runner.isMatchOver(), true);
});

test('one hitbox connects at most once per move', () => {
  // Regression guard for the freeze/contact cycle: a hitstop-frozen attacker used to re-resolve
  // the same active frame every time the freeze lifted, locking both fighters in permanent
  // hitstop and never advancing either state machine.
  const runner = new MatchRunner(closeRangeSpawns());
  const attacking = idleInput({ attack: 'jab' });
  let hits = 0;
  let ticks = 0;
  for (; ticks < 200; ticks += 1) {
    const events = runner.fixedUpdate(DT, [ticks === 0 ? attacking : idleInput(), idleInput()]);
    hits += events.filter((event) => event.type === 'hit').length;
    const attacker = runner.fighterAt(0);
    if (ticks > 0 && attacker.currentMove === null && attacker.hitstop === 0) {
      break;
    }
  }
  assert.equal(hits, 1, 'a two-frame jab must connect once, not once per active frame');
  assert.ok(ticks < 60, 'the attacker never finished its jab');
  assert.equal(runner.fighterAt(0).hitstop, 0);
});

test('arena walls clamp position and emit wall impacts', () => {
  const runner = new MatchRunner(engagementSpawns());
  const events = runner.step(600, idleInput({ moveX: 1, moveZ: 1 }));
  assert.ok(events.some((event) => event.type === 'wallImpact'), 'walking into the wall must report it');
  for (const fighter of runner.fighters) {
    assert.ok(Math.abs(fighter.x / FP_SCALE) <= 9, `slot ${fighter.slot} escaped on x`);
    assert.ok(Math.abs(fighter.z / FP_SCALE) <= 9, `slot ${fighter.slot} escaped on z`);
  }
});

after(() => {
  cleanup();
});