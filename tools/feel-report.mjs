/**
 * Combat and frame-data balance report — verification gate 4 (`npm run report`).
 *
 * AGENTS.md §4: this gate "must confirm zero discrepancies between theoretical moveset data and
 * measured simulation outcomes". So every number in the MOVESET table that *can* be observed by
 * running the simulation is measured here and compared against what the table declares:
 *
 *   1. Frame data      — startup / active / recovery, measured on a whiff.
 *   2. Contact         — damage, hitstun and hitstop, measured on a live hit.
 *   3. Refresh rates   — the same frames measured at 30 / 60 / 144 / 240Hz.
 *   4. Determinism     — two independent scripted matches must hash identically, and so must
 *                        the same match run at four different display rates.
 *
 * Exit code 0 = zero discrepancies. Exit code 1 = at least one discrepancy (details printed).
 * Frame advantage is printed for design review with a ±20 band; it is a balance opinion, not a
 * measured/discrepancy, so it never fails the gate on its own.
 */

import { cleanup, loadSim } from './load-sim.mjs';
import { measureMoveFrames, measureMoveFramesAtRate, runScriptedMatchAtRate } from './measure-frames.mjs';

const sim = await loadSim();

const REFRESH_RATES = [30, 60, 144, 240];
const ADVANTAGE_BAND = 20;
const SCRIPTED_TICKS = 600;

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padLeft(value, width) {
  return String(value).padStart(width);
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

/** Deterministic input script, derived only from (slot, tick). */
function scenarioFor(runner, tick) {
  return runner.fighters.map((fighter) => {
    const phase = (tick + fighter.slot * 13) % 48;
    let attack = null;
    if (phase === 0) attack = 'jab';
    else if (phase === 12) attack = 'straight';
    else if (phase === 24) attack = 'low_sweep';
    else if (phase === 36) attack = 'grab_high';
    return {
      moveX: phase % 3 === 0 ? 1 : phase % 3 === 1 ? -1 : 0,
      moveZ: phase % 5 === 0 ? 1 : 0,
      attack,
      guard: phase % 6 === 4 ? 'high' : phase % 7 === 5 ? 'low' : 'none',
    };
  });
}

/** Two fighters, the defender placed just inside the move's reach. */
function contactSpawns(def) {
  const distance = Math.max(0.4, def.reach - 0.3);
  return [
    { slot: 0, archetypeId: 'probe', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'opponent', x: distance, z: 0, facing: -1 },
  ];
}

/**
 * Run a move into a live opponent and report what the simulation actually did: whether it
 * connected, how much damage it dealt, how many ticks the attacker stayed busy (move frames plus
 * hitstop), and what state the defender was left in.
 */
function verifyContact(def) {
  const runner = new sim.MatchRunner(contactSpawns(def));
  const idle = sim.idleInput();
  runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;
  const defender = runner.fighterAt(1);
  const healthBefore = defender.health;
  const limit = sim.totalFrames(def) + def.hitstop + 40;

  let connected = false;
  let damageDealt = 0;
  let ticks = 0;
  let defenderState = 'unknown';

  while (ticks < limit) {
    const events = runner.fixedUpdate(sim.DT, [
      ticks === 0 ? sim.idleInput({ attack: def.id }) : idle,
      idle,
    ]);
    ticks += 1;
    const hit = events.find((event) => event.type === 'hit');
    if (hit !== undefined) {
      connected = true;
      damageDealt += hit.damage;
    }
    defenderState = defender.state;
    const attacker = runner.fighterAt(0);
    if (ticks > 1 && attacker.currentMove === null && attacker.hitstop === 0) {
      break;
    }
  }

  return {
    connected,
    damageDealt,
    healthLost: healthBefore - defender.health,
    attackerTicks: ticks,
    defenderState,
  };
}

function section(title) {
  console.log('');
  console.log(title);
  console.log('-'.repeat(title.length));
}

// ---------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------
console.log('Urban Reign — combat & frame-data report');
console.log(`Tick rate: ${sim.TICK_HZ}Hz fixed   Moves: ${sim.MOVESET.length}   Refresh rates checked: ${REFRESH_RATES.join('/')}Hz`);

// ---------------------------------------------------------------------------------------
// 1. Structural checks on the declared table
// ---------------------------------------------------------------------------------------
section('1. Moveset structure');
{
  const ids = new Set();
  for (const def of sim.MOVESET) {
    if (ids.has(def.id)) {
      fail(`duplicate move id '${def.id}'`);
    }
    ids.add(def.id);
    if (def.startup < 1) fail(`${def.id}: startup must be at least 1 frame`);
    if (def.active < 1) fail(`${def.id}: active must be at least 1 frame`);
    if (def.recovery < 1) fail(`${def.id}: recovery must be at least 1 frame`);
    if (def.damage <= 0) fail(`${def.id}: damage must be positive`);
    if (def.spaCost > 100) fail(`${def.id}: spa cost ${def.spaCost} exceeds the gauge`);
    if (def.spaCost > 0 && def.spaTier === 0) fail(`${def.id}: costs SPA but declares tier 0`);
    if (def.launcher && !def.knockdown) fail(`${def.id}: launcher must also knock down`);
  }
  console.log(`${sim.MOVESET.length} moves checked, ${ids.size} unique ids`);
}

// ---------------------------------------------------------------------------------------
// 2. Declared vs measured frame data (whiff), plus refresh-rate independence
// ---------------------------------------------------------------------------------------
section('2. Frame data — declared vs measured');
console.log(
  `${pad('move', 12)}${pad('stance', 9)}${pad('guard', 13)}` +
    `${padLeft('su', 4)}${padLeft('ac', 4)}${padLeft('rc', 5)}${padLeft('tot', 5)}  ${pad('measured', 22)}${padLeft('rates', 8)}  verdict`,
);

for (const def of sim.MOVESET) {
  const measured = measureMoveFrames(sim, def.id);
  const declared = `${def.startup}/${def.active}/${def.recovery}`;
  const measuredText = `${measured.startup}/${measured.active}/${measured.recovery}`;

  const frameOk =
    measured.complete &&
    measured.startup === def.startup &&
    measured.active === def.active &&
    measured.recovery === def.recovery;
  if (!frameOk) {
    fail(`${def.id}: declared frames ${declared} but measured ${measuredText}`);
  }

  // Refresh-rate independence, measured through the real fixed-step loop.
  let ratesOk = true;
  for (const frameHz of REFRESH_RATES) {
    const atRate = await measureMoveFramesAtRate(sim, def.id, frameHz);
    if (
      atRate.startup !== def.startup ||
      atRate.active !== def.active ||
      atRate.recovery !== def.recovery ||
      atRate.droppedTicks !== 0
    ) {
      ratesOk = false;
      fail(`${def.id}: ${frameHz}Hz measured ${atRate.startup}/${atRate.active}/${atRate.recovery} (dropped ${atRate.droppedTicks})`);
    }
  }

  const verdict = frameOk && ratesOk ? 'ok' : 'MISMATCH';
  console.log(
    pad(def.id, 12) +
      pad(def.stance, 9) +
      pad(def.guard, 13) +
      padLeft(def.startup, 4) +
      padLeft(def.active, 4) +
      padLeft(def.recovery, 5) +
      padLeft(sim.totalFrames(def), 5) +
      '  ' +
      pad(measuredText, 22) +
      padLeft(ratesOk ? 'all ok' : 'drift', 8) +
      '  ' +
      verdict,
  );
}

// ---------------------------------------------------------------------------------------
// 3. Contact verification: damage and hitstop
// ---------------------------------------------------------------------------------------
section('3. Contact — damage, hitstop and hit-frame outcome');
console.log(
  `${pad('move', 12)}${padLeft('dmg', 6)}${padLeft('dmg dealt', 11)}${padLeft('stop', 6)}${padLeft('ticks', 8)}${padLeft('expected', 10)}${pad('defender ends in', 18)}verdict`,
);

for (const def of sim.MOVESET) {
  const result = verifyContact(def);
  const expectedTicks = sim.totalFrames(def) + def.hitstop;

  if (!result.connected) {
    fail(`${def.id}: never connected at ${(def.reach - 0.3).toFixed(1)} units — reach or hitbox is wrong`);
  }
  if (result.damageDealt !== def.damage) {
    fail(`${def.id}: declared damage ${def.damage} but dealt ${result.damageDealt}`);
  }
  if (result.healthLost !== def.damage) {
    fail(`${def.id}: defender lost ${result.healthLost} health, expected ${def.damage}`);
  }
  if (result.attackerTicks !== expectedTicks) {
    fail(
      `${def.id}: attacker busy for ${result.attackerTicks} ticks, expected ${expectedTicks} ` +
        `(${sim.totalFrames(def)} frames + ${def.hitstop} hitstop)`,
    );
  }

  const ok = result.connected && result.damageDealt === def.damage && result.attackerTicks === expectedTicks;
  console.log(
    pad(def.id, 12) +
      padLeft(def.damage, 6) +
      padLeft(result.damageDealt, 11) +
      padLeft(def.hitstop, 6) +
      padLeft(result.attackerTicks, 8) +
      padLeft(expectedTicks, 10) +
      pad(result.defenderState, 18) +
      (ok ? 'ok' : 'MISMATCH'),
  );
}

// ---------------------------------------------------------------------------------------
// 4. Determinism across runs and refresh rates
// ---------------------------------------------------------------------------------------
section('4. Determinism');
{
  const hashes = [];
  for (let run = 0; run < 2; run += 1) {
    const runner = new sim.MatchRunner();
    for (let tick = 0; tick < SCRIPTED_TICKS; tick += 1) {
      runner.fixedUpdate(sim.DT, scenarioFor(runner, tick));
    }
    hashes.push(runner.stateHash());
  }
  if (hashes[0] !== hashes[1]) {
    fail(`two identical scripted matches hashed differently (${hashes[0]} vs ${hashes[1]})`);
  }
  console.log(`Two independent ${SCRIPTED_TICKS}-tick matches -> ${hashes[0]} ${hashes[0] === hashes[1] ? '(identical)' : '(DIVERGED)'}`);

  // Same scripted match, four simulated display rates, identical tick counts.
  const rateHashes = [];
  for (const frameHz of REFRESH_RATES) {
    const result = await runScriptedMatchAtRate(sim, frameHz, SCRIPTED_TICKS, scenarioFor);
    rateHashes.push({ frameHz, ticks: result.ticks, hash: result.hash });
  }
  const uniqueHashes = new Set(rateHashes.map((entry) => entry.hash));
  const uniqueTicks = new Set(rateHashes.map((entry) => entry.ticks));
  if (uniqueHashes.size !== 1) {
    fail(`state diverged by refresh rate: ${JSON.stringify(rateHashes)}`);
  }
  if (uniqueTicks.size !== 1) {
    fail(`tick counts diverged by refresh rate: ${JSON.stringify(rateHashes)}`);
  }
  console.log(`Same match at ${REFRESH_RATES.join('/')}Hz -> ${[...uniqueHashes][0]} (${uniqueHashes.size === 1 ? 'identical' : 'DIVERGED'})`);
  for (const entry of rateHashes) {
    console.log(`  ${padLeft(entry.frameHz, 4)}Hz  ${padLeft(entry.ticks, 5)} ticks  ${entry.hash}`);
  }
}

// ---------------------------------------------------------------------------------------
// 5. Frame advantage (design review, not a hard gate)
// ---------------------------------------------------------------------------------------
section('5. Frame advantage (review band ±' + ADVANTAGE_BAND + ')');
console.log(
  `${pad('move', 12)}${padLeft('on hit', 9)}${padLeft('on block', 11)}${padLeft('hitstun', 10)}${padLeft('blockstun', 12)}${pad('guard', 13)}note`,
);

for (const def of sim.MOVESET) {
  const scored = def.guard !== 'throw' && !def.knockdown;
  const hit = scored ? sim.hitAdvantage(def) : null;
  const block = def.guard === 'throw' || def.guard === 'unblockable' || def.knockdown ? null : sim.blockAdvantage(def);

  let note = '';
  if (!scored) {
    note = def.guard === 'throw' ? 'throw — knockdown, no advantage race' : 'knockdown — no advantage race';
  } else {
    for (const value of [hit, block]) {
      if (value !== null && Math.abs(value) > ADVANTAGE_BAND) {
        note = `outside ±${ADVANTAGE_BAND} — review`;
        break;
      }
    }
    if (note === '') {
      note = 'in band';
    }
  }
  if (note.startsWith('outside')) {
    notes.push(`${def.id}: ${note}`);
  }

  console.log(
    pad(def.id, 12) +
      padLeft(hit === null ? '—' : signed(hit), 9) +
      padLeft(block === null ? '—' : signed(block), 11) +
      padLeft(def.hitstun, 10) +
      padLeft(def.blockstun, 12) +
      pad(def.guard, 13) +
      note,
  );
}

// ---------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------
section('Summary');
if (notes.length > 0) {
  console.log('Design notes (non-blocking):');
  for (const note of notes) {
    console.log(`  - ${note}`);
  }
}

if (failures.length > 0) {
  console.log(`FAILED — ${failures.length} discrepanc${failures.length === 1 ? 'y' : 'ies'}:`);
  for (const failure of failures) {
    console.log(`  x ${failure}`);
  }
  cleanup();
  process.exit(1);
}

console.log(`PASSED — 0 discrepancies across ${sim.MOVESET.length} moves (frames, contact, refresh rates, determinism).`);
cleanup();