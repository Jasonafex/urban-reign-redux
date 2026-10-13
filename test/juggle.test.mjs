/**
 * Air juggles, the strict `JUGGLE_LIMIT`, and the get-up roll that follows a knockdown.
 *
 * A juggle cap is only meaningful if it is actually reachable, which is the trap here: the Phase 0
 * launch threw the victim nine world units into the air and nine units sideways, so nothing could
 * ever follow them up and the limit was untestable. These tests assert the cap *and* that the
 * geometry lets a juggle reach it — a limit nothing can reach is not a limit.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadSim } from '../tools/load-sim.mjs';

const sim = await loadSim();
const {
  AIRBORNE_Y,
  DT,
  FP_SCALE,
  GETUP_FRAMES,
  JUGGLE_LIMIT,
  KNOCKDOWN_FRAMES,
  LAUNCH_VELOCITY,
  MOVESET,
  MatchRunner,
  getMove,
  idleInput,
} = sim;

after(() => {
  cleanup();
});

const LAUNCHER = 'brad_hawk_rising_knee_1';
const AERIAL = 'brad_hawk_rising_knee_2';

function pairSpawns(gap = 1.1) {
  return [
    { slot: 0, archetypeId: 'brad_hawk', x: -gap / 2, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: gap / 2, z: 0, facing: -1 },
  ];
}

/**
 * Launch, then juggle: press the aerial follow-up whenever the attacker is free and the victim is
 * off the ground. Returns the aerial hits that actually connected.
 */
function juggle(airMoveId = AERIAL, ticks = 400) {
  const runner = new MatchRunner(pairSpawns());
  const idle = sim.idleInput();
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  const aerial = [];

  for (let tick = 0; tick < ticks; tick += 1) {
    const attackerFree = attacker.state === 'idle' || attacker.state === 'walk';
    const airborne = defender.state === 'launched' || defender.y > 0;
    let input = idle;
    if (attackerFree && airborne) {
      input = idleInput({ attack: airMoveId });
    } else if (attackerFree && defender.y === 0 && defender.state !== 'launched') {
      input = idleInput({ attack: LAUNCHER });
    }
    for (const event of runner.fixedUpdate(DT, [input, idle])) {
      if (event.type === 'hit' && event.moveId === airMoveId) {
        aerial.push({ tick: event.tick, damage: event.damage });
      }
    }
    if (defender.state === 'idle' && tick > 20 && aerial.length > 0) {
      break;
    }
  }
  return { runner, attacker, defender, aerial };
}

test('the juggle limit is exactly three and is genuinely reachable', () => {
  assert.equal(JUGGLE_LIMIT, 3);

  const { aerial, defender } = juggle();
  assert.equal(
    aerial.length,
    JUGGLE_LIMIT,
    `expected the cap to be reached and stop at ${JUGGLE_LIMIT} aerial hits, got ${aerial.length}`,
  );

  // Every aerial hit did real damage — the limit is not being hit by empty hitboxes.
  for (const hit of aerial) {
    assert.equal(hit.damage, getMove(AERIAL).damage, 'an aerial hit dealt the wrong damage');
  }

  // And the victim ends up on the floor rather than hanging in the air forever.
  assert.equal(defender.state !== 'launched', true, `victim ended as ${defender.state}`);
});

test('the fourth aerial hit is refused outright, not merely reduced', () => {
  // Keep trying well past the cap, and only count ticks where the aerial hitbox was genuinely live
  // and on target. If no such tick ever occurs, the test proved nothing and has to say so.
  const runner = new MatchRunner(pairSpawns());
  const idle = sim.idleInput();
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  let aerialHits = 0;
  let liveOnTargetTicks = 0;
  let refusedTicks = 0;

  for (let tick = 0; tick < 400; tick += 1) {
    const attackerFree = attacker.state === 'idle' || attacker.state === 'walk';
    const airborne = defender.state === 'launched' || defender.y > 0;
    let input = idle;
    if (attackerFree && airborne) {
      input = idleInput({ attack: AERIAL });
    } else if (attackerFree && defender.y === 0 && defender.state !== 'launched') {
      input = idleInput({ attack: LAUNCHER });
    }
    const before = runner.fighters.map((fighter) => ({ ...fighter }));
    const events = runner.fixedUpdate(DT, [input, idle]);
    const hits = events.filter((event) => event.type === 'hit');
    aerialHits += hits.filter((event) => event.moveId === AERIAL).length;

    // "Live and on target": the attacker's hitbox was up and the victim was within reach before
    // this tick resolved.
    const wasActive = attacker.state === 'active' && attacker.currentMove === AERIAL;
    const distance = Math.abs(before[1].x - before[0].x);
    if (wasActive && distance <= getMove(AERIAL).reach * FP_SCALE) {
      liveOnTargetTicks += 1;
      if (hits.length === 0) {
        refusedTicks += 1;
      }
    }
  }

  assert.equal(aerialHits, JUGGLE_LIMIT, `aerial hits should cap at ${JUGGLE_LIMIT}, got ${aerialHits}`);
  assert.ok(
    refusedTicks > 0,
    `the test never attempted an over-cap hit (${liveOnTargetTicks} live-on-target ticks seen)`,
  );
});

test('the counter resets when the victim lands', () => {
  // `juggleCount` means "aerial hits since leaving the ground", not a life total: a later combo
  // must be able to juggle again.
  const first = juggle();
  assert.equal(first.defender.juggleCount, 0, 'landing should clear the juggle counter');
  assert.equal(first.aerial.length, JUGGLE_LIMIT);

  const second = juggle();
  assert.equal(
    second.aerial.length,
    JUGGLE_LIMIT,
    `a second juggle should also reach ${JUGGLE_LIMIT}, got ${second.aerial.length}`,
  );
});

test('aerial strikes only reach airborne targets, and grounded strikes only reach grounded ones', () => {
  assert.equal(getMove(AERIAL).airOnly, true, 'the juggle tool should be declared aerial');
  assert.equal(getMove(LAUNCHER).airOnly, false, 'the launcher should be declared grounded');
  assert.equal(getMove('brad_hawk_barrage_1').airOnly, false);

  // Grounded target, aerial move: nothing.
  const grounded = new MatchRunner(pairSpawns());
  const groundedHits = [];
  for (let tick = 0; tick < 30; tick += 1) {
    const events = grounded.fixedUpdate(DT, [
      tick === 0 ? idleInput({ attack: AERIAL }) : idleInput(),
      idleInput(),
    ]);
    groundedHits.push(...events.filter((event) => event.type === 'hit'));
  }
  assert.equal(groundedHits.length, 0, 'an aerial strike hit a grounded target');

  // Airborne target, grounded move: nothing either. That split is what keeps juggling a
  // deliberate, capped tool rather than something any fast poke does by accident.
  const runner = new MatchRunner(pairSpawns());
  const defender = runner.fighterAt(1);
  const idle = sim.idleInput();
  let groundedHitWhileAirborne = 0;
  let launchTick = -1;
  for (let tick = 0; tick < 60; tick += 1) {
    const attacker = runner.fighterAt(0);
    const free = attacker.state === 'idle' || attacker.state === 'walk';
    const events = runner.fixedUpdate(DT, [
      free && tick === 0 ? idleInput({ attack: LAUNCHER }) : idle,
      idle,
    ]);
    for (const event of events) {
      if (event.type === 'hit') {
        if (event.moveId === LAUNCHER) {
          launchTick = event.tick;
        } else if (event.tick > launchTick) {
          // The launcher's own contact is not what this is about.
          groundedHitWhileAirborne += 1;
        }
      }
    }
  }
  assert.ok(launchTick >= 0, 'the launch never happened, so this proves nothing');
  assert.equal(groundedHitWhileAirborne, 0, 'a grounded strike hit an airborne target');
});

test('the launch arc is short enough that a juggle reads as a juggle', () => {
  // The Phase 0 stub launched a victim nine world units up in a seventeen unit arena. The arc has
  // to be short enough that a juggle ends while someone is still watching.
  const apex = (LAUNCH_VELOCITY * LAUNCH_VELOCITY) / (2 * sim.GRAVITY_PER_TICK);
  assert.ok(apex < 5 * FP_SCALE, `launch apex is ${(apex / FP_SCALE).toFixed(1)} world units — too high`);
  assert.ok(LAUNCH_VELOCITY < 700, 'LAUNCH_VELOCITY was not retuned for a 60Hz brawler arc');

  const airtime = (2 * LAUNCH_VELOCITY) / sim.GRAVITY_PER_TICK;
  assert.ok(airtime > JUGGLE_LIMIT * 6, 'the arc is too short to fit the juggle limit inside it');
});

test('a knockdown leads into an invulnerable get-up roll', () => {
  const runner = new MatchRunner(pairSpawns());
  const defender = runner.fighterAt(1);
  const idle = sim.idleInput();

  runner.fixedUpdate(DT, [idleInput({ attack: 'brad_hawk_slide_tackle_1' }), idle]);

  // The sweep has startup frames, so the knockdown has not resolved on the accepting tick: first
  // wait for the victim to actually leave `idle`, then run the knockdown out to recovery.
  let guard = 0;
  while (runner.fighterAt(1).state === 'idle' && guard < 200) {
    runner.fixedUpdate(DT, [idle, idle]);
    guard += 1;
  }
  const seen = new Set([runner.fighterAt(1).state]);
  while (runner.fighterAt(1).state !== 'idle' && guard < KNOCKDOWN_FRAMES + GETUP_FRAMES + 200) {
    runner.fixedUpdate(DT, [idle, idle]);
    seen.add(runner.fighterAt(1).state);
    guard += 1;
  }
  assert.ok(seen.has('down'), `expected a knockdown, saw ${[...seen].join(', ')}`);
  assert.ok(seen.has('getup'), `expected a get-up roll, saw ${[...seen].join(', ')}`);
  assert.equal(defender.state, 'idle', 'the roll should hand control back');
});

test('a launched fighter cannot be launched into orbit, and lands deterministically', () => {
  // Air drag is what keeps a juggle reachable. Two identical runs must still agree exactly.
  const runOnce = () => {
    const runner = new MatchRunner(pairSpawns());
    const idle = sim.idleInput();
    for (let tick = 0; tick < 200; tick += 1) {
      runner.fixedUpdate(DT, [
        tick === 0 ? idleInput({ attack: LAUNCHER }) : idle,
        idle,
      ]);
    }
    const defender = runner.fighterAt(1);
    return { x: defender.x, y: defender.y, hash: runner.stateHash() };
  };

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b, 'two identical juggles diverged');
  assert.equal(a.y, 0, `the victim should have landed, but is still at y=${a.y / FP_SCALE}`);

  // Bounded horizontal carry: a launch is a shove, not a launch into orbit.
  const maxCarry = sim.AIR_FRICTION_DIVISOR * getMove(LAUNCHER).knockback;
  const startX = -Math.round(1.1 * 0.5 * FP_SCALE);
  assert.ok(
    Math.abs(a.x - startX) < 2 * FP_SCALE,
    `the launch carried the victim ${((a.x - startX) / FP_SCALE).toFixed(1)} world units`,
  );
  assert.ok(maxCarry > 0, 'the launcher should still displace');
});

test('only aerial moves are juggle tools, and the table declares them that way', () => {
  // JUGGLE_LIMIT is meaningless unless `airOnly` is the single switch that gates it. If a move
  // could juggle without being aerial, the counter would have two entry points and the cap would
  // only bound one of them.
  const aerial = MOVESET.filter((def) => def.airOnly);
  assert.ok(aerial.length > 0, 'no aerial moves exist, so the juggle system is untestable');
  for (const def of aerial) {
    assert.equal(def.kind, 'launcher', `${def.id} is aerial but not a launcher`);
    assert.ok(def.reach > 0, `${def.id} has no reach`);
  }
  assert.ok(AIRBORNE_Y > 0, 'AIRBORNE_Y should be a real height threshold');
});