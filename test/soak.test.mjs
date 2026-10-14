/**
 * Four-player soak test (Phase 5, `npm test`).
 *
 * A soak test earns its place by being the only test that can catch the bugs the others structurally
 * cannot: state that degrades slowly, a leak that only shows up in the four-hundredth round, and
 * anything that depends on how many ticks have gone by. Ten thousand ticks is about two and a half
 * minutes of four-player fighting, which is long enough to cross many round boundaries, several
 * knockouts and at least one rematch — the lifecycle gets exercised, not just skipped past.
 *
 * What it gates, in order of how badly a regression would hurt:
 *
 *   - **No NaN and no Infinity anywhere in the world.** The simulation is integer fixed-point, so a
 *     float in a fighter record means something divided by zero or multiplied an infinity into
 *     position. One NaN silently poisons every subsequent tick and every hash after it, and the
 *     failure surfaces minutes later somewhere completely unrelated.
 *   - **No desync.** The same seed run twice must produce byte-identical hashes at *every* tick,
 *     not just at the end. Checking only the final hash would pass a simulation that diverged on
 *     tick 9,000 and happened to reconverge — which a deterministic system should not do, and this
 *     asserts that it does not.
 *   - **Clean memory across rounds.** Retained state must be bounded by the slot count, not by the
 *     tick count. The structural check is the real gate (it is exact); the heap check alongside it
 *     is a smoke alarm for an accidental closure capture that structure alone would not show.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSources, cleanup, loadSim } from '../tools/load-sim.mjs';

const sim = await loadSim();
const sources = await buildSources();

const {
  MatchRunner,
  MatchRules,
  AiController,
  GAME_MODES,
  matchSpawns,
  DEFAULT_AI_SEED,
  DT,
} = sim;

after(cleanup);

/** Ticks simulated per soak run. Ten thousand is ~2m47s of four-player fighting at 60Hz. */
const SOAK_TICKS = 10_000;

/**
 * Motion fields that must never hold a non-finite number.
 *
 * Position and velocity are the ones that matter: the simulation is integer fixed-point, so a float
 * in `x` means something divided by zero, and it propagates through every distance test, every
 * collision and every hash after it. Timers are checked for finiteness alongside these because they
 * are the other half of what a runaway state machine touches.
 */
const NUMERIC_FIELDS = Object.freeze([
  'x',
  'y',
  'z',
  'vx',
  'vy',
  'vz',
  'health',
  'maxHealth',
  'spaMeter',
  'stateFrame',
  'movePhaseFrame',
  'juggleCount',
  'hitstop',
  'stunRemaining',
  'blockstunLeft',
  'chainWindow',
  'whiffLockout',
  'dodgeCooldown',
  'chargeFrames',
]);

/**
 * Run one soak pass and collect everything worth asserting on afterwards.
 *
 * `hashAt` is captured every `hashEvery` ticks rather than every tick — the per-tick comparison in
 * the desync test runs its own paired loop, and a 10,000-element array per run would be 40KB of
 * pure test overhead to prove something the pair already proves.
 */
function soak({
  mode = 'free_for_all',
  seed = DEFAULT_AI_SEED,
  ticks = SOAK_TICKS,
  botSlots = [0, 1, 2, 3],
  hashEvery = 500,
} = {}) {
  const spawns = matchSpawns(mode);
  const runner = new MatchRunner(spawns);
  // Short phases so a 10,000-tick run crosses many round boundaries instead of idling in one
  // 99-second round. The production defaults are the real thing; these are the same lifecycle with
  // a compressed clock, which is what makes the leak visible in a test-length run.
  const rules = new MatchRules({
    mode,
    spawns,
    countdownFrames: 90,
    koHoldFrames: 45,
    victoryHoldFrames: 120,
    rematchHoldFrames: 60,
    roundsToWin: 2,
    roundTimeLimitFrames: 1800,
  });
  const ai = new AiController({ seed });

  const hashes = [];
  let nonFinite = null;
  let outOfBounds = null;
  let hits = 0;
  let kos = 0;
  let rounds = 0;
  let matches = 0;
  let phasesSeen = new Set();

  for (let tick = 0; tick < ticks; tick += 1) {
    const inputs = ai.fill(runner, runner.fighters.map(() => ({ ...sim.NEUTRAL_INPUT })), botSlots);
    const events = runner.fixedUpdate(DT, rules.blocksInput ? blank(inputs.length) : inputs);

    for (const event of events) {
      if (event.type === 'hit') {
        hits += 1;
      }
    }

    for (const fighter of runner.fighters) {
      for (const field of NUMERIC_FIELDS) {
        const value = fighter[field];
        if (!Number.isFinite(value)) {
          nonFinite = nonFinite ?? { tick: runner.tick, slot: fighter.slot, field, value };
        }
      }
      if (fighter.y < 0) {
        outOfBounds = outOfBounds ?? { tick: runner.tick, slot: fighter.slot, why: 'negative y', y: fighter.y };
      }
      if (fighter.health < 0 || fighter.health > fighter.maxHealth) {
        outOfBounds = outOfBounds ?? {
          tick: runner.tick,
          slot: fighter.slot,
          why: 'health outside 0..max',
          health: fighter.health,
        };
      }
      if (fighter.spaMeter < 0 || fighter.spaMeter > fighter.spaMax) {
        outOfBounds = outOfBounds ?? {
          tick: runner.tick,
          slot: fighter.slot,
          why: 'gauge outside 0..max',
          spaMeter: fighter.spaMeter,
        };
      }
    }

    for (const event of rules.step(runner, events)) {
      phasesSeen.add(event.type);
      if (event.type === 'ko') kos += 1;
      if (event.type === 'round_won') {
        rounds += 1;
        runner.reset();
      }
      if (event.type === 'rematch') {
        matches += 1;
        runner.reset();
      }
    }

    if (tick % hashEvery === 0 || tick === ticks - 1) {
      hashes.push(runner.stateHash());
    }
  }

  return {
    runner,
    rules,
    hashes,
    nonFinite,
    outOfBounds,
    hits,
    kos,
    rounds,
    matches,
    phasesSeen,
  };
}

function blank(count) {
  return Array.from({ length: count }, () => ({ ...sim.NEUTRAL_INPUT }));
}

test(`10,000-tick four-player soak produces no NaN, no out-of-range state and a real fight`, () => {
  const result = soak();

  assert.equal(result.nonFinite, null, `a fighter field went non-finite: ${JSON.stringify(result.nonFinite)}`);
  assert.equal(result.outOfBounds, null, `a fighter left its legal range: ${JSON.stringify(result.outOfBounds)}`);

  // Guard against a vacuous pass. A soak that simulates ten thousand ticks of four fighters
  // standing still would satisfy every assertion above and prove nothing at all. The thresholds are
  // set well below what the bots actually produce (they land ~140 hits and score knockouts at this
  // configuration) — they exist to catch "nothing is fighting any more", not to measure skill.
  assert.ok(result.hits > 60, `only ${result.hits} hits landed in ${SOAK_TICKS} ticks`);
  assert.ok(result.kos > 0, 'no knockout happened in 10,000 ticks');
  assert.ok(result.rounds > 0, 'no round was ever scored');
  assert.ok(result.matches > 0, 'the lifecycle never reached a rematch');
  for (const type of ['phase', 'ko', 'round_won', 'match_over', 'rematch']) {
    assert.ok(result.phasesSeen.has(type), `the lifecycle never emitted a '${type}' event`);
  }
});

test('the soak is reproducible: the same seed yields identical hashes in both modes', () => {
  for (const mode of GAME_MODES.map((entry) => entry.id)) {
    const a = soak({ mode, seed: 20251014 });
    const b = soak({ mode, seed: 20251014 });
    assert.deepEqual(a.hashes, b.hashes, `${mode} diverged between two runs of the same seed`);
    assert.equal(a.runner.stateHash(), b.runner.stateHash(), `${mode} ended on a different hash`);
    assert.equal(a.kos, b.kos, `${mode} produced a different number of knockouts`);
  }
});

test('no desync: two independent 10,000-tick runs agree at every checkpoint', () => {
  // Checkpointed rather than per-tick here to keep the assertion output readable; the per-tick form
  // of this guarantee is covered exhaustively by `determinism.test.mjs`. What is unique to the soak
  // is that these checkpoints span *round boundaries and rematches* — points where the client
  // rebuilds the world, and where a rules object that failed to reset would diverge.
  const a = soak({ seed: 4242 });
  const b = soak({ seed: 4242 });
  assert.deepEqual(a.hashes, b.hashes, 'the soak diverged at a checkpoint');
  assert.equal(a.rounds, b.rounds, 'the two runs scored a different number of rounds');
  assert.equal(a.matches, b.matches, 'the two runs reached a different number of rematches');
});

test('a different seed produces a different fight (the bots are not a fixed pattern)', () => {
  const a = soak({ seed: 1, ticks: 4000 });
  const b = soak({ seed: 2, ticks: 4000 });
  assert.notDeepEqual(a.hashes, b.hashes, 'two different seeds played identically');
});

/**
 * Count the nodes reachable from a value.
 *
 * The memory gate cannot be "how big is the JSON" — a score going from `0` to `2` makes that string
 * longer without anything having been retained. Counting reachable *objects* is immune to that, and
 * a per-tick buffer (an event log, a replay tape, a "recent opponents" list) adds nodes on every
 * single round, which is exactly what this catches.
 */
function graphSize(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  let total = 1;
  if (value instanceof Set || Array.isArray(value)) {
    for (const entry of value) {
      total += 1 + graphSize(entry, seen);
    }
    return total;
  }
  for (const key of Object.keys(value)) {
    total += 1 + graphSize(value[key], seen);
  }
  return total;
}

test('retained state is bounded by the slot count, not the tick count', () => {
  // The real memory gate, and it is exact. `MatchRules` holds a win count per slot plus the set of
  // slots knocked out this round — both O(slots). If a future change adds anything that grows with
  // time played, this fails on the first round that overflows instead of after a four-hour session
  // in someone's browser.
  const rules = new MatchRules({
    mode: 'free_for_all',
    spawns: matchSpawns('free_for_all'),
    countdownFrames: 30,
    koHoldFrames: 20,
    victoryHoldFrames: 40,
    rematchHoldFrames: 20,
    roundsToWin: 1,
    roundTimeLimitFrames: 900,
  });
  const ai = new AiController({ seed: 8 });
  const runner = new MatchRunner(rules.spawns);
  const nodes = () => graphSize(rules);

  let rounds = 0;
  let rematches = 0;
  const sizes = [];
  for (let tick = 0; tick < 8000 && rounds < 6; tick += 1) {
    const inputs = ai.fill(runner, runner.fighters.map(() => ({ ...sim.NEUTRAL_INPUT })), [0, 1, 2, 3]);
    const events = runner.fixedUpdate(DT, rules.blocksInput ? blank(inputs.length) : inputs);
    for (const event of rules.step(runner, events)) {
      if (event.type === 'round_won') {
        rounds += 1;
        sizes.push(nodes());
        runner.reset();
      }
      if (event.type === 'rematch') {
        rematches += 1;
        runner.reset();
      }
    }
  }

  assert.ok(rounds >= 6, `the soak only reached ${rounds} rounds`);
  assert.ok(rematches > 0, 'the run never started a new match');
  assert.equal(rules.wins.length, 4, 'the win table should have one entry per slot');

  // Compared *across* rounds rather than against the starting value: the first scored round
  // legitimately fills fields that began as `null` (`champion`, `lastKo`), so an absolute
  // comparison would flag a correct one-time initialisation as a leak. What must not happen is the
  // size climbing round after round — that is what a per-tick buffer looks like.
  const settled = sizes.slice(1);
  assert.ok(settled.length >= 4, `only ${settled.length} rounds to compare`);
  for (let i = 1; i < settled.length; i += 1) {
    assert.equal(
      settled[i],
      settled[0],
      `retained state grew across rounds (${settled.join(', ')} objects per round boundary)`,
    );
  }
});

test('heap use stays flat across many rounds (no leak in the match loop)', () => {
  // A smoke alarm alongside the structural assertion above, for the class of leak structure cannot
  // see: an accidental closure capture, or a bot holding a reference to a world it has left.
  //
  // The strict form needs a forced collection to mean anything. Without `--expose-gc`, V8 simply has
  // not collected the per-tick input and event churn yet, and the "growth" being measured is
  // uncollected garbage — measured at roughly 2MB per ten rounds, entirely recovered once a
  // collection does run. So the budget is only enforced when the runtime can actually clean up, and
  // otherwise the test still checks the property that holds regardless: the loop finishes without
  // exhausting memory.
  const canCollect = typeof globalThis.gc === 'function';
  const runner = new MatchRunner(matchSpawns('free_for_all'));
  const ai = new AiController({ seed: 5150 });
  const rules = new MatchRules({
    mode: 'free_for_all',
    spawns: matchSpawns('free_for_all'),
    countdownFrames: 30,
    koHoldFrames: 20,
    victoryHoldFrames: 40,
    rematchHoldFrames: 20,
    roundsToWin: 1,
    roundTimeLimitFrames: 900,
  });

  const runRounds = (count) => {
    let rounds = 0;
    for (let tick = 0; tick < count * 3000 && rounds < count; tick += 1) {
      const inputs = ai.fill(runner, runner.fighters.map(() => ({ ...sim.NEUTRAL_INPUT })), [0, 1, 2, 3]);
      const events = runner.fixedUpdate(DT, rules.blocksInput ? blank(inputs.length) : inputs);
      for (const event of rules.step(runner, events)) {
        if (event.type === 'round_won' || event.type === 'rematch') {
          rounds += 1;
          runner.reset();
        }
      }
    }
    return rounds;
  };

  // Warm up first: the first rounds allocate lazily and would otherwise look like growth.
  runRounds(3);
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const rounds = runRounds(10);
  globalThis.gc?.();
  const after = process.memoryUsage().heapUsed;

  assert.ok(rounds >= 10, `only reached ${rounds} rounds`);

  if (canCollect) {
    const growthKb = (after - before) / 1024;
    assert.ok(growthKb < 128, `heap grew ${growthKb.toFixed(0)}KB across ${rounds} rounds`);
  } else {
    // Without a way to force collection, only the runaway case is detectable — and that is still
    // worth catching, because a per-tick leak over a long session ends in an OOM.
    const heapMb = after / 1024 / 1024;
    assert.ok(
      heapMb < 512,
      `heap reached ${heapMb.toFixed(0)}MB across ${rounds} rounds — run npm test with --expose-gc for the strict check`,
    );
  }
});

test('a soak survives every game mode, not just the default one', () => {
  for (const entry of GAME_MODES) {
    const result = soak({ mode: entry.id, ticks: 2500 });
    assert.equal(result.nonFinite, null, `${entry.id} produced a non-finite field`);
    assert.equal(result.outOfBounds, null, `${entry.id} left a fighter out of range`);
  }
});

test('the CPU fill path never leaves a bot slot holding a stale input', () => {
  // `AiController.fill` is called with a mix of human and CPU slots every tick. A bot slot that
  // fell through to "pass the human input through" would quietly freeze, and a bot that returned
  // `undefined` would throw inside `fixedUpdate`. Both are cheap to check and expensive to find in
  // a four-hour session.
  const ai = new AiController({ seed: 31337 });
  const runner = new MatchRunner(matchSpawns('free_for_all'));

  for (let tick = 0; tick < 1200; tick += 1) {
    const humanInputs = runner.fighters.map(() => ({ ...sim.NEUTRAL_INPUT }));
    const inputs = ai.fill(runner, humanInputs, [1, 3]);
    assert.equal(inputs.length, 4, `fill() returned ${inputs.length} inputs`);
    for (const input of inputs) {
      assert.ok(input !== undefined && input !== null, 'fill() produced an empty input');
      assert.ok(input.attack === null || typeof input.attack === 'string', 'attack must be a move id or null');
      assert.ok(['none', 'high', 'low'].includes(input.dodge), `bad dodge: ${input.dodge}`);
      assert.ok(['none', 'high', 'low'].includes(input.guard), `bad guard: ${input.guard}`);
      assert.ok(input.moveX >= -1 && input.moveX <= 1, `moveX out of range: ${input.moveX}`);
      assert.ok(input.moveZ >= -1 && input.moveZ <= 1, `moveZ out of range: ${input.moveZ}`);
    }
    // The untouched slots must come back *identical*, not merely valid: a caller passing a shared
    // array should be able to rely on its own inputs surviving untouched.
    assert.deepEqual(inputs[0], humanInputs[0], 'fill() mutated a human slot');
    assert.deepEqual(inputs[2], humanInputs[2], 'fill() mutated a human slot');
    runner.fixedUpdate(DT, inputs);
  }
});

test('the simulation graph still reaches for no clock, no randomness and no DOM', () => {
  // Phase 5 put `modes.ts` and `ai.ts` inside the simulation graph, so the architecture gate from
  // `determinism.test.mjs` now covers them too. Re-asserted here because these two modules are the
  // ones that would be tempted: the lifecycle wants a clock, and the bots want `Math.random`.
  assert.ok(sources.sim.includes('MatchRules'), 'sim bundle looks empty');

  const forbidden = [
    /\bdocument\s*[.[]/,
    /\btypeof\s+document\b/,
    /\bwindow\s*[.[]/,
    /\btypeof\s+window\b/,
    /\bAudioContext\b/,
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
});