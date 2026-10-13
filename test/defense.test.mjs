/**
 * High/low dodge, frame-perfect reversals, guarding, and the get-up invincibility roll.
 *
 * AGENTS.md §5 makes the defensive read the centre of Urban Reign: a high dodge slips high and
 * mid strikes, a low dodge hops sweeps, and a reversal that lands inside the frame-perfect window
 * at the *front* of the slip window answers with an immediate counter-throw. Getting that ordering
 * wrong is invisible in a screenshot and very obvious in play, so the window boundaries are
 * asserted as exact tick ranges rather than as "a dodge happened".
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadSim } from '../tools/load-sim.mjs';
import { measureBlockedContact } from '../tools/measure-frames.mjs';

const sim = await loadSim();
const {
  ARCHETYPES,
  DODGE_RECOVERY_FRAMES,
  DODGE_REVERSAL_FRAMES,
  DODGE_SLIP_FRAMES,
  DODGE_SLIP_START,
  DODGE_TOTAL_FRAMES,
  DT,
  GETUP_FRAMES,
  JUGGLE_LIMIT,
  KNOCKDOWN_FRAMES,
  MatchRunner,
  getMove,
  idleInput,
} = sim;

after(() => {
  cleanup();
});

function pairSpawns(left = 'brad_hawk', right = 'brad_hawk', gap = 1.1) {
  return [
    { slot: 0, archetypeId: left, x: -gap / 2, z: 0, facing: 1 },
    { slot: 1, archetypeId: right, x: gap / 2, z: 0, facing: -1 },
  ];
}

/**
 * Attack on tick 0, dodge on tick `dodgeAt`, and report what resolved first.
 * Returns `{ outcome, evadedMoveId, counterMoveId, hit }`.
 */
function resolveDodge(attackId, dodgeDirection, dodgeAt, defenderId = 'brad_hawk') {
  const def = getMove(attackId);
  const runner = new MatchRunner([
    { slot: 0, archetypeId: 'brad_hawk', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: defenderId, x: def.reach - 0.3, z: 0, facing: -1 },
  ]);
  const idle = sim.idleInput();

  for (let tick = 0; tick < 60; tick += 1) {
    const attack = tick === 0 ? idleInput({ attack: attackId }) : idle;
    const dodge = tick === dodgeAt ? idleInput({ dodge: dodgeDirection }) : idle;
    const events = runner.fixedUpdate(DT, [attack, dodge]);
    const dodged = events.find((event) => event.type === 'dodge');
    if (dodged !== undefined) {
      return {
        outcome: dodged.outcome,
        evadedMoveId: dodged.evadedMoveId,
        counterMoveId: dodged.counterMoveId,
        hit: null,
      };
    }
    const hit = events.find((event) => event.type === 'hit');
    if (hit !== undefined) {
      return { outcome: 'hit', evadedMoveId: null, counterMoveId: null, hit };
    }
  }
  return { outcome: 'nothing', evadedMoveId: null, counterMoveId: null, hit: null };
}

/**
 * The tick on which an attack's hitbox goes live.
 *
 * `startup` is the number of frames before the first active frame, and the accepting tick is
 * frame 1 — so the hit lands on tick `startup - 1`, not `startup`. Getting this off by one shifts
 * every window assertion in this file by a frame, which is exactly the size of the mistake.
 */
function impactTick(moveId) {
  return getMove(moveId).startup - 1;
}

/**
 * The tick on which a dodge must be pressed to reach its own `stateFrame` at the impact.
 *
 * `stateFrame` is 1 on the accepting tick, so a dodge pressed on tick D is on frame
 * `impactTick - D + 1` when the hit lands. Inverting that lets these tests be written in terms of
 * the window boundaries the config declares, instead of raw tick arithmetic.
 */
function dodgeTickForFrame(impact, frame) {
  return impact + 1 - frame;
}

// -------------------------------------------------------------------------------------------
// The windows themselves
// -------------------------------------------------------------------------------------------

test('the dodge window boundaries are exactly what they claim to be', () => {
  // `DODGE_SLIP_START` counts from 1 on the accepting tick, so the commitment occupies frame 1 and
  // the slip window opens on frame 2. The reversal window is the front of the slip window, which
  // is the whole meaning of "frame-perfect": react early and you punish, react late and you live.
  assert.equal(DODGE_SLIP_START, 2, 'the commitment is expected to occupy exactly the first frame');
  assert.equal(DODGE_REVERSAL_FRAMES < DODGE_SLIP_FRAMES, true, 'the reversal window must be shorter');
  assert.ok(DODGE_RECOVERY_FRAMES > 0, 'a dodge must have frames after its slip window closes');

  // Probed with a long-startup attack on purpose: a dodge is pressed *before* the impact, so the
  // latest dodge frame reachable is `impact + 1`. A 7-frame jab can only ever reach frame 8, which
  // would leave most of the declared slip window untested.
  const attackId = 'jack5_rocket_uppercut_1';
  const impact = impactTick(attackId);
  const slipStart = DODGE_SLIP_START;
  const slipEnd = DODGE_SLIP_START + DODGE_SLIP_FRAMES; // exclusive
  const reversalEnd = DODGE_SLIP_START + DODGE_REVERSAL_FRAMES; // exclusive
  assert.ok(impact + 1 >= slipEnd, 'this test needs an attack slow enough to reach the last slip frame');

  // Frame 1 is the commitment: too late to react, so the hit lands.
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, slipStart - 1)).outcome,
    'hit',
    'the dodge commitment frame should not be evasive',
  );
  // The first reversal frame, and the last one.
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, slipStart)).outcome,
    'reversal',
    'the first slip frame is the first reversal frame',
  );
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, reversalEnd - 1)).outcome,
    'reversal',
    'the last reversal frame should still counter',
  );
  // Just past the reversal window but still inside the slip window: survived, not punished.
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, reversalEnd)).outcome,
    'slip',
    'a late-but-inside-the-window dodge should survive without countering',
  );
  // The last slip frame still slips.
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, slipEnd - 1)).outcome,
    'slip',
    'the last slip frame should still evade',
  );
  // One frame after the slip window closes: too slow, the hit lands.
  assert.equal(
    resolveDodge(attackId, 'high', dodgeTickForFrame(impact, slipEnd)).outcome,
    'hit',
    'the frame after the slip window should be a clean hit',
  );
});

test('a high dodge slips high and mid strikes, a low dodge hops sweeps', () => {
  /** Resolve inside the slip window but past the reversal frames, so a slip is a slip. */
  const insideSlipOnly = (attackId, direction) => {
    const frame = DODGE_SLIP_START + DODGE_REVERSAL_FRAMES + 1;
    return resolveDodge(attackId, direction, dodgeTickForFrame(impactTick(attackId), frame)).outcome;
  };

  assert.equal(insideSlipOnly('straight', 'high'), 'slip', 'a high dodge should slip a high strike');
  assert.equal(insideSlipOnly('uppercut', 'high'), 'slip', 'a high dodge should slip a mid strike');
  assert.equal(insideSlipOnly('low_sweep', 'low'), 'slip', 'a low dodge should hop a sweep');

  // And the wrong read is not a defence: dodging low does not save you from a mid strike.
  assert.equal(insideSlipOnly('uppercut', 'low'), 'hit', 'a low dodge must not answer a mid strike');
  assert.equal(insideSlipOnly('straight', 'low'), 'hit', 'a low dodge must not answer a high strike');
  assert.equal(insideSlipOnly('low_sweep', 'high'), 'hit', 'a high dodge must not answer a sweep');

  // Pin the guard levels the table actually declares, so the assertions above cannot quietly
  // change meaning if a move is re-typed.
  assert.equal(getMove('straight').guard, 'high');
  assert.equal(getMove('uppercut').guard, 'mid');
  assert.equal(getMove('low_sweep').guard, 'low');
});

test('a frame-perfect dodge counters with that archetype\u2019s reversal', () => {
  const attackId = 'jack5_rocket_uppercut_1';
  const impact = impactTick(attackId);
  for (const archetype of ARCHETYPES) {
    const result = resolveDodge(attackId, 'high', dodgeTickForFrame(impact, DODGE_SLIP_START), archetype.id);
    assert.equal(result.outcome, 'reversal', `${archetype.name}: should have countered`);
    assert.equal(
      result.counterMoveId,
      archetype.reversalMoveId,
      `${archetype.name}: countered with the wrong reversal`,
    );
  }
});

test('the reversal actually punishes the attacker', () => {
  const reversal = getMove('brad_hawk_reversal');
  assert.equal(reversal.kind, 'reversal');

  const runner = new MatchRunner(pairSpawns());
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  const healthBefore = attacker.health;
  const idle = sim.idleInput();
  const attackId = 'jack5_rocket_uppercut_1';
  const dodgeAt = dodgeTickForFrame(impactTick(attackId), DODGE_SLIP_START);

  let resolved = null;
  for (let tick = 0; tick < 60 && resolved === null; tick += 1) {
    const attack = tick === 0 ? idleInput({ attack: attackId }) : idle;
    const dodge = tick === dodgeAt ? idleInput({ dodge: 'high' }) : idle;
    const events = runner.fixedUpdate(DT, [attack, dodge]);
    resolved = events.find((event) => event.type === 'dodge') ?? resolved;
  }

  assert.ok(resolved !== null, 'the dodge never resolved');
  assert.equal(resolved.outcome, 'reversal');
  assert.equal(resolved.evadedMoveId, attackId, 'the DodgeEvent should name what it answered');

  // The counter started, so the defender is out of the dodge and into the reversal.
  assert.equal(defender.currentMove, reversal.id, 'the counter should have started');
  assert.equal(defender.state, 'startup');
  // And the attack that got countered was discarded, not frozen: the reversal is what happens
  // instead of it, so the attacker is in the reversal's hitstun rather than his own move.
  assert.equal(attacker.state, 'hitstun', 'the attacker should be in the reversal\u2019s hitstun');
  assert.equal(attacker.currentMove, null, 'the countered move should be gone');
  assert.ok(attacker.health < healthBefore, 'the reversal should have dealt damage');
  assert.equal(healthBefore - attacker.health, reversal.damage);
});

test('throws and unblockables are read by neither dodge', () => {
  const throwDef = getMove('brad_hawk_throw');
  assert.equal(throwDef.guard, 'throw');
  // Perfect timing is no defence against a throw: a reversal cannot stop being picked up.
  const result = resolveDodge(
    'brad_hawk_throw',
    'high',
    dodgeTickForFrame(impactTick('brad_hawk_throw'), DODGE_SLIP_START),
  );
  assert.equal(result.outcome, 'hit', 'a throw beat a frame-perfect dodge');
});

// -------------------------------------------------------------------------------------------
// Guarding
// -------------------------------------------------------------------------------------------

test('guarding answers the same high/low read the dodge answers', () => {
  for (const [moveId, highGuardBlocks, lowGuardBlocks] of [
    ['straight', true, false],
    ['uppercut', true, false],
    ['low_sweep', false, true],
    ['grab_high', false, false],
  ]) {
    const def = getMove(moveId);
    const high = measureBlockedContact(sim, def, 'high');
    const low = measureBlockedContact(sim, def, 'low');
    assert.equal(high.guarded, highGuardBlocks, `${moveId}: high guard result`);
    assert.equal(low.guarded, lowGuardBlocks, `${moveId}: low guard result`);
    if (highGuardBlocks) {
      assert.equal(high.healthLost, 0, `${moveId}: a blocked strike dealt damage`);
    }
  }
});

test('a blocked hit still pushes the defender back', () => {
  // Block pushback is the defender's reward, and it is separate from clean-hit displacement:
  // a high guard must not be a free way to stop a combo dead.
  const def = getMove('straight');
  const runner = new MatchRunner(pairSpawns('brad_hawk', 'brad_hawk', 1.1));
  const defender = runner.fighterAt(1);
  const startX = defender.x;
  const idle = sim.idleInput();

  for (let tick = 0; tick < 20; tick += 1) {
    runner.fixedUpdate(DT, [
      tick === 0 ? idleInput({ attack: 'straight' }) : idle,
      idleInput({ guard: 'high' }),
    ]);
  }
  assert.ok(defender.x > startX, 'a blocked strike should push the defender away');
});

// -------------------------------------------------------------------------------------------
// The get-up roll
// -------------------------------------------------------------------------------------------

test('the get-up roll is invulnerable, and a knockdown is not a free setup', () => {
  const runner = new MatchRunner(pairSpawns());
  const defender = runner.fighterAt(1);
  const idle = sim.idleInput();

  // Knock the defender down with a sweep, and wait for the arc to actually finish.
  let guard = 0;
  runner.fixedUpdate(DT, [idleInput({ attack: 'brad_hawk_slide_tackle_1' }), idle]);
  guard += 1;
  while (defender.state !== 'down' && guard < 120) {
    runner.fixedUpdate(DT, [idle, idle]);
    guard += 1;
  }
  assert.equal(defender.state, 'down', `expected a knockdown, got ${defender.state}`);

  let sawGetup = false;
  let hitsDuringGetup = 0;
  let attackAttempts = 0;
  let healthDuringGetup = null;

  // The attacker only swings while the defender is actually rolling. Leaving it swinging the
  // whole time would be a different test: a grounded strike *does* connect against a fighter in
  // `down`, which would knock them out of the knockdown and skip the roll entirely.
  for (let tick = 0; tick < KNOCKDOWN_FRAMES + GETUP_FRAMES + 60; tick += 1) {
    const rolling = defender.state === 'getup';
    if (rolling && !sawGetup) {
      sawGetup = true;
      healthDuringGetup = defender.health;
    }
    const attackerFree = runner.fighterAt(0).state === 'idle' || runner.fighterAt(0).state === 'walk';
    const swinging = rolling && attackerFree;
    if (swinging) {
      attackAttempts += 1;
    }
    const events = runner.fixedUpdate(DT, [swinging ? idleInput({ attack: 'straight' }) : idle, idle]);
    if (rolling) {
      hitsDuringGetup += events.filter((event) => event.type === 'hit').length;
    }
  }

  assert.equal(sawGetup, true, 'the defender never entered the get-up roll');
  assert.ok(attackAttempts > 0, 'the attacker never got a chance to swing at the roll');
  assert.equal(hitsDuringGetup, 0, 'the get-up roll must be invulnerable');
  assert.equal(defender.health, healthDuringGetup, 'health moved during an invulnerable window');
  assert.equal(defender.state, 'idle', 'the roll should end back in control');
});

test('the get-up roll is long enough to be a real reset', () => {
  // Not a hard number, but a one-frame roll would be a rounding error rather than a defence.
  assert.ok(GETUP_FRAMES >= 12, `get-up roll is only ${GETUP_FRAMES} frames`);
  assert.equal(JUGGLE_LIMIT, 3);
  assert.equal(DODGE_TOTAL_FRAMES > DODGE_SLIP_START, true);
});

// -------------------------------------------------------------------------------------------
// Dodge commitment and cooldown
// -------------------------------------------------------------------------------------------

test('a dodge cannot be cancelled out of its commitment, and has a cooldown', () => {
  const runner = new MatchRunner(pairSpawns());
  const idle = sim.idleInput();

  runner.fixedUpdate(DT, [idleInput({ dodge: 'high' }), idle]);
  assert.equal(runner.fighterAt(0).state, 'dodge_high');
  assert.ok(runner.fighterAt(0).dodgeCooldown > 0, 'a dodge should start a cooldown');

  // Mid-dodge, an attack press must be swallowed: the dodge owns the fighter.
  runner.fixedUpdate(DT, [idleInput({ attack: 'straight' }), idle]);
  assert.equal(runner.fighterAt(0).currentMove, null, 'a dodge was cancelled out of its frames');
  assert.equal(runner.fighterAt(0).state, 'dodge_high');

  // Wait out the dodge plus its cooldown, then try again.
  let guard = 0;
  while (runner.fighterAt(0).dodgeCooldown > 0 && guard < 200) {
    runner.fixedUpdate(DT, [idle, idle]);
    guard += 1;
  }
  assert.ok(guard < 200, 'the dodge cooldown never expired');
  runner.fixedUpdate(DT, [idleInput({ dodge: 'high' }), idle]);
  assert.equal(runner.fighterAt(0).state, 'dodge_high', 'the dodge never became available again');
});

test('dodging drops any branch ticket the fighter was holding', () => {
  const runner = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));
  const idle = sim.idleInput();

  let ticks = 0;
  while (runner.fighterAt(0).chainWindow === 0 && ticks < 60) {
    runner.fixedUpdate(DT, [
      ticks === 0 ? idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }) : idle,
      idle,
    ]);
    ticks += 1;
  }
  assert.ok(runner.fighterAt(0).chainWindow > 0, 'no branch window was open to abandon');

  runner.fixedUpdate(DT, [idleInput({ dodge: 'high' }), idle]);
  assert.equal(runner.fighterAt(0).chainId, '', 'dodging should abandon the string');
  assert.equal(runner.fighterAt(0).chainWindow, 0);
});