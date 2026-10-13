/**
 * Combat and frame-data balance report — verification gate 4 (`npm run report`).
 *
 * AGENTS.md §4: this gate "must confirm zero discrepancies between theoretical moveset data and
 * measured simulation outcomes". So every number in the MOVESET table that *can* be observed by
 * running the simulation is measured here and compared against what the table declares:
 *
 *   1. Structure     — the table and the chain graph are internally consistent.
 *   2. Provenance    — what each archetype chain was ported from, and how much was authored.
 *   3. Frame data    — startup / active / recovery, measured on a whiff, at four refresh rates.
 *   4. Contact       — damage, hitstop and busy frames for one *button press*, which from Phase 1
 *                      may be a move plus every automatic link it chains into.
 *   5. Defence       — the high/low dodge and the frame-perfect reversal window, measured.
 *   6. Juggles       — the cap is measured as reached, not merely declared.
 *   7. Determinism   — two independent scripted matches must hash identically, and so must the
 *                      same match run at four different display rates.
 *   8. Frame advantage — printed for design review with a ±20 band. A balance opinion, not a
 *                      discrepancy, so it never fails the gate on its own.
 *
 * Exit code 0 = zero discrepancies. Exit code 1 = at least one discrepancy (details printed).
 */

import { cleanup, loadSim } from './load-sim.mjs';
import {
  engagementSpawns,
  measureChainContact,
  measureMoveFrames,
  measureMoveFramesAtRate,
  runScriptedMatchAtRate,
} from './measure-frames.mjs';

const sim = await loadSim();

const REFRESH_RATES = [30, 60, 144, 240];
const ADVANTAGE_BAND = 20;
const SCRIPTED_TICKS = 600;
const STANCES = ['neutral', 'up', 'down', 'side'];

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

/**
 * Deterministic input script, derived only from (slot, tick).
 *
 * Deliberately drives the Phase 1 systems as well as the baseline moves: bare stance presses
 * (four-way branching), high/low dodges, and explicit chain presses. A determinism scenario that
 * only ever throws jabs would never notice a hash field going stale.
 */
function scenarioFor(runner, tick) {
  return runner.fighters.map((fighter) => {
    const phase = (tick + fighter.slot * 13) % 48;
    const stance = STANCES[phase % 4];
    let attack = null;
    if (phase === 0 || phase === 20) attack = sim.CHAIN_PRESS;
    else if (phase === 12) attack = 'straight';
    else if (phase === 30) attack = 'low_sweep';
    else if (phase === 36) attack = 'grab_high';
    return sim.idleInput({
      moveX: phase % 3 === 0 ? 1 : phase % 3 === 1 ? -1 : 0,
      moveZ: phase % 5 === 0 ? 1 : 0,
      attack,
      stance,
      guard: phase % 6 === 4 ? 'high' : phase % 7 === 5 ? 'low' : 'none',
      dodge: phase % 9 === 2 ? 'high' : phase % 9 === 5 ? 'low' : 'none',
    });
  });
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
console.log(
  `Tick rate: ${sim.TICK_HZ}Hz fixed   Moves: ${sim.MOVESET.length}   ` +
    `Archetypes: ${sim.ARCHETYPES.length}   Chains: ${sim.ARCHETYPE_CHAINS.length}   ` +
    `Refresh rates checked: ${REFRESH_RATES.join('/')}Hz`,
);

// ---------------------------------------------------------------------------------------
// 1. Structural checks on the declared table and the chain graph
// ---------------------------------------------------------------------------------------
section('1. Table and chain structure');
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
    if (def.chainNext !== null && def.chainNextMode === 'none') {
      fail(`${def.id}: declares chainNext but chainNextMode 'none'`);
    }
    if (def.chainNextMode !== 'none' && def.chainNext === null) {
      fail(`${def.id}: chainNextMode ${def.chainNextMode} with no chainNext`);
    }
    if (def.chainNext !== null && sim.getMove(def.chainNext) === undefined) {
      fail(`${def.id}: chainNext '${def.chainNext}' is not a move`);
    }
  }

  // Chains: links resolve, and the link order matches chainNext exactly.
  for (const chainDef of sim.ARCHETYPE_CHAINS) {
    for (const [index, link] of chainDef.links.entries()) {
      const def = sim.getMove(link.moveId);
      if (def === undefined) {
        fail(`${chainDef.id}: link ${link.moveId} is not a move`);
        continue;
      }
      const expectedNext = chainDef.links[index + 1]?.moveId ?? null;
      if (def.chainNext !== expectedNext) {
        fail(`${def.id}: chainNext ${def.chainNext} but the chain says ${expectedNext}`);
      }
      const expectedMode = expectedNext === null ? 'none' : link.automatic ? 'automatic' : 'hitConfirm';
      if (def.chainNextMode !== expectedMode) {
        fail(`${def.id}: chainNextMode ${def.chainNextMode} but the chain says ${expectedMode}`);
      }
      if (def.limb !== chainDef.limbs[index]) {
        fail(`${def.id}: limb '${def.limb}' does not match the ported '${chainDef.limbs[index]}'`);
      }
    }
  }

  // Every archetype answers all four directions: a stance with no chain is a dead input.
  for (const archetype of sim.ARCHETYPES) {
    for (const stance of STANCES) {
      const opener = sim.defaultChainMoveId(archetype.id, stance);
      if (opener === undefined) {
        fail(`${archetype.name}: no ${stance} chain, so that direction is a dead input`);
      } else if (sim.getMove(opener) === undefined) {
        fail(`${archetype.name}: ${stance} opener '${opener}' is not a move`);
      }
    }
    if (sim.getMove(archetype.reversalMoveId) === undefined) {
      fail(`${archetype.name}: reversal '${archetype.reversalMoveId}' is not a move`);
    }
    if (sim.getMove(archetype.throwMoveId) === undefined) {
      fail(`${archetype.name}: throw '${archetype.throwMoveId}' is not a move`);
    }
    if (archetype.maxHealth <= 0) fail(`${archetype.name}: maxHealth must be positive`);
    if (!Number.isInteger(archetype.walkSpeed)) {
      fail(`${archetype.name}: walkSpeed must be an integer to stay bit-identical`);
    }
  }

  // Automatic chains have to keep their own range, and only the last hit may displace.
  for (const chainDef of sim.ARCHETYPE_CHAINS) {
    if (!chainDef.links[0]?.automatic) continue;
    const defs = chainDef.links.map((link) => sim.getMove(link.moveId)).filter(Boolean);
    const reaches = new Set(defs.map((def) => def.reach));
    if (reaches.size !== 1) {
      fail(`${chainDef.id}: automatic chain links disagree on reach (${[...reaches].join(', ')})`);
    }
    for (const def of defs.slice(0, -1)) {
      if (def.knockdown && def.knockback !== 0) {
        fail(`${def.id}: mid-chain knockdown displaces the victim out of its own chain`);
      }
    }
  }

  // The Gigaton ladder.
  for (const archetype of sim.ARCHETYPES) {
    const profile = sim.chargeProfileOf(archetype.id);
    if (profile === null) continue;
    const releases = profile.releases.map((id) => sim.getMove(id));
    if (releases.some((def) => def === undefined)) {
      fail(`${archetype.name}: a Gigaton release id is not a move`);
      continue;
    }
    if (releases.length !== profile.maxLevel) {
      fail(`${archetype.name}: ${releases.length} releases for maxLevel ${profile.maxLevel}`);
    }
    releases.forEach((def, index) => {
      if (def.chargeLevel !== index + 1) {
        fail(`${def.id}: chargeLevel ${def.chargeLevel} at index ${index}`);
      }
      if (index === 0 && def.spaCost <= 0) {
        fail(`${def.id}: the first release should carry the gauge cost`);
      }
      if (index > 0 && def.spaCost !== 0) {
        fail(`${def.id}: charged the gauge again; gigaton_charge.py costs it once`);
      }
    });
  }

  console.log(
    `${sim.MOVESET.length} moves checked, ${ids.size} unique ids, ` +
      `${sim.ARCHETYPE_CHAINS.length} chains, ${sim.ARCHETYPES.length} archetypes`,
  );
}

// ---------------------------------------------------------------------------------------
// 2. Provenance
// ---------------------------------------------------------------------------------------
section('2. Archetypes and provenance');
console.log(
  `${pad('archetype', 14)}${pad('health', 8)}${pad('walk', 7)}${pad('chains', 8)}${pad('moves', 7)}note`,
);
for (const archetype of sim.ARCHETYPES) {
  const chains = sim.ARCHETYPE_CHAINS.filter((chainDef) => chainDef.archetypeId === archetype.id);
  const moveIds = new Set(chains.flatMap((chainDef) => chainDef.links.map((link) => link.moveId)));
  const ported = chains.filter((chainDef) => chainDef.origin === 'trial13').length;
  const charge = archetype.charge === null ? '' : `, ${archetype.charge.maxLevel}-level charge`;
  console.log(
    pad(archetype.id, 14) +
      padLeft(archetype.maxHealth, 8) +
      padLeft(archetype.walkSpeed, 7) +
      padLeft(chains.length, 8) +
      padLeft(moveIds.size, 7) +
      `${ported} ported from spec.py, ${chains.length - ported} authored${charge}`,
  );
}

console.log('');
console.log(`${pad('chain', 46)}${pad('stance', 9)}${pad('links', 7)}${pad('auto', 7)}finish`);
for (const chainDef of sim.ARCHETYPE_CHAINS) {
  console.log(
    pad(chainDef.label, 46) +
      pad(chainDef.stance, 9) +
      padLeft(chainDef.links.length, 7) +
      padLeft(chainDef.links[0]?.automatic ? 'yes' : 'no', 7) +
      (chainDef.finish ?? '—'),
  );
}

const originCounts = sim.MOVESET.reduce((counts, def) => {
  counts[def.origin] = (counts[def.origin] ?? 0) + 1;
  return counts;
}, {});
console.log('');
console.log(
  `Moves by origin: ${Object.entries(originCounts).map(([origin, n]) => `${origin} ${n}`).join(', ')}`,
);
console.log(
  'Brad Hawk has no Trial 13 source: his moves are authored against AGENTS.md §5 and marked ' +
    '`origin: authored` rather than claiming a lineage that does not exist.',
);

// ---------------------------------------------------------------------------------------
// 3. Declared vs measured frame data (whiff), plus refresh-rate independence
// ---------------------------------------------------------------------------------------
section('3. Frame data — declared vs measured');
console.log(
  `${pad('move', 34)}${pad('guard', 13)}` +
    `${padLeft('su', 4)}${padLeft('ac', 4)}${padLeft('rc', 5)}${padLeft('tot', 5)}  ` +
    `${pad('measured', 22)}${padLeft('rates', 8)}  verdict`,
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
    pad(def.id, 34) +
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
// 4. Contact: one button press, whole automatic chain
// ---------------------------------------------------------------------------------------
section('4. Contact — one press, full automatic chain');
console.log(
  `${pad('move', 34)}${padLeft('links', 6)}${padLeft('dmg', 6)}${padLeft('dealt', 8)}` +
    `${padLeft('contacts', 10)}${padLeft('busy', 7)}${padLeft('expect', 8)}  verdict`,
);

for (const def of sim.MOVESET) {
  const chain = sim.automaticChain(def);
  const expectedDamage = sim.chainDamageBudget(def);
  const expectedTicks = sim.chainFrameBudget(def) + sim.chainHitstopBudget(def);
  const result = measureChainContact(sim, def);

  if (!result.connected) {
    fail(`${def.id}: never connected at ${(def.reach - 0.3).toFixed(1)} units — reach or hitbox is wrong`);
  } else if (def.airOnly && !result.airborne) {
    fail(`${def.id}: aerial strike measured against a grounded target`);
  }
  // A one-press chain must land every one of its automatic contacts, or the victim was pushed out
  // of the chain's own reach partway through.
  if (result.contacts !== chain.length) {
    fail(
      `${def.id}: landed ${result.contacts} of ${chain.length} contacts — the chain loses its victim partway through`,
    );
  }
  if (result.damageDealt !== expectedDamage) {
    fail(`${def.id}: declared damage ${expectedDamage} but dealt ${result.damageDealt}`);
  }
  if (result.healthLost !== expectedDamage) {
    fail(`${def.id}: defender lost ${result.healthLost} health, expected ${expectedDamage}`);
  }
  if (result.busyTicks !== expectedTicks) {
    fail(
      `${def.id}: attacker busy for ${result.busyTicks} ticks, expected ${expectedTicks} ` +
        `(${sim.chainFrameBudget(def)} chain frames + ${sim.chainHitstopBudget(def)} hitstop)`,
    );
  }

  const ok =
    result.connected &&
    result.contacts === chain.length &&
    result.damageDealt === expectedDamage &&
    result.busyTicks === expectedTicks;
  console.log(
    pad(def.id, 34) +
      padLeft(chain.length, 6) +
      padLeft(expectedDamage, 6) +
      padLeft(result.damageDealt, 8) +
      padLeft(result.contacts, 10) +
      padLeft(result.busyTicks, 7) +
      padLeft(expectedTicks, 8) +
      '  ' +
      (ok ? 'ok' : 'MISMATCH'),
  );
}

// ---------------------------------------------------------------------------------------
// 5. The defensive read
// ---------------------------------------------------------------------------------------
section('5. Defence — dodge and reversal windows');
console.log(
  `slip frames ${sim.DODGE_SLIP_START}..${sim.DODGE_SLIP_START + sim.DODGE_SLIP_FRAMES - 1}   ` +
    `reversal frames ${sim.DODGE_SLIP_START}..${sim.DODGE_SLIP_START + sim.DODGE_REVERSAL_FRAMES - 1}   ` +
    `dodge ${sim.DODGE_TOTAL_FRAMES} frames + ${sim.DODGE_RECOVERY_FRAMES} recovery   ` +
    `cooldown ${sim.DODGE_COOLDOWN_FRAMES}`,
);

/**
 * Resolve a dodge against a live attack, pressing the dodge so that it reaches `frame` at impact.
 * `startup` is frames before the first active frame and the accepting tick is frame 1, so the hit
 * lands on tick `startup - 1` and a dodge pressed on tick D is on frame `impact - D + 1` there.
 */
function probeDodge(attackId, direction, frame) {
  const def = sim.getMove(attackId);
  const runner = new sim.MatchRunner([
    { slot: 0, archetypeId: 'brad_hawk', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: def.reach - 0.3, z: 0, facing: -1 },
  ]);
  const impact = def.startup - 1;
  const dodgeAt = impact + 1 - frame;
  const idle = sim.idleInput();

  for (let tick = 0; tick < 90; tick += 1) {
    const attack = tick === 0 ? sim.idleInput({ attack: attackId }) : idle;
    const dodge = tick === dodgeAt ? sim.idleInput({ dodge: direction }) : idle;
    const events = runner.fixedUpdate(sim.DT, [attack, dodge]);
    const dodged = events.find((event) => event.type === 'dodge');
    if (dodged !== undefined) return dodged.outcome;
    if (events.some((event) => event.type === 'hit')) return 'hit';
  }
  return 'nothing';
}

console.log('');
console.log(
  `${pad('probe', 40)}${pad('guard', 7)}${padLeft('frame', 6)}${padLeft('result', 8)}  verdict`,
);

/** A slow attack, so every declared window frame is reachable before impact. */
const PROBE_ATTACK = 'jack5_rocket_uppercut_1';
{
  const frames = [
    ['commit', sim.DODGE_SLIP_START - 1, 'hit'],
    ['reversal', sim.DODGE_SLIP_START, 'reversal'],
    ['reversal (last)', sim.DODGE_SLIP_START + sim.DODGE_REVERSAL_FRAMES - 1, 'reversal'],
    ['slip', sim.DODGE_SLIP_START + sim.DODGE_REVERSAL_FRAMES, 'slip'],
    ['slip (last)', sim.DODGE_SLIP_START + sim.DODGE_SLIP_FRAMES - 1, 'slip'],
    ['late', sim.DODGE_SLIP_START + sim.DODGE_SLIP_FRAMES, 'hit'],
  ];

  // The Rocket Uppercut is a mid strike, so only the *high* dodge answers it. The wrong read is
  // asserted to be worthless at every frame: a dodge that protects against everything would make
  // the high/low read decorative.
  const probeDef = sim.getMove(PROBE_ATTACK);
  const answersHigh = probeDef.guard === 'high' || probeDef.guard === 'mid';

  for (const direction of ['high', 'low']) {
    for (const [label, frame, expected] of frames) {
      const actual = probeDodge(PROBE_ATTACK, direction, frame);
      const wanted = direction === 'high' ? (answersHigh ? expected : 'hit') : 'hit';
      if (actual !== wanted) {
        fail(`${PROBE_ATTACK} vs ${direction} dodge at frame ${frame}: expected ${wanted}, got ${actual}`);
      }
      const verdict = actual === wanted ? 'ok' : 'MISMATCH';
      console.log(
        pad(`${PROBE_ATTACK} ${direction} (${label})`, 40) +
          pad(probeDef.guard, 7) +
          padLeft(frame, 6) +
          padLeft(actual, 8) +
          '  ' +
          verdict,
      );
    }
  }
}

// The high/low read has to differ by guard level, or the dodge is just "press dodge".
console.log('');
console.log(`${pad('attack', 28)}${pad('guard', 7)}${pad('high dodge', 12)}${pad('low dodge', 11)}  verdict`);
for (const attackId of ['straight', 'uppercut', 'low_sweep', 'brad_hawk_throw']) {
  const def = sim.getMove(attackId);
  const frame = sim.DODGE_SLIP_START + sim.DODGE_REVERSAL_FRAMES + 1;
  const vsHigh = probeDodge(attackId, 'high', frame);
  const vsLow = probeDodge(attackId, 'low', frame);
  const answerable = def.guard !== 'throw' && def.guard !== 'unblockable';
  const expectedHigh = answerable && (def.guard === 'high' || def.guard === 'mid') ? 'slip' : 'hit';
  const expectedLow = answerable && def.guard === 'low' ? 'slip' : 'hit';

  if (vsHigh !== expectedHigh) fail(`${attackId}: high dodge expected ${expectedHigh}, got ${vsHigh}`);
  if (vsLow !== expectedLow) fail(`${attackId}: low dodge expected ${expectedLow}, got ${vsLow}`);

  console.log(
    pad(attackId, 28) +
      pad(def.guard, 7) +
      pad(vsHigh, 12) +
      pad(vsLow, 11) +
      '  ' +
      (vsHigh === expectedHigh && vsLow === expectedLow ? 'ok' : 'MISMATCH'),
  );
}

// ---------------------------------------------------------------------------------------
// 6. Juggles
// ---------------------------------------------------------------------------------------
section('6. Juggles — the cap has to be reachable, not just declared');
{
  const LAUNCHER = 'brad_hawk_rising_knee_1';
  const AERIAL = 'brad_hawk_rising_knee_2';

  function runJuggle() {
    const runner = new sim.MatchRunner([
      { slot: 0, archetypeId: 'brad_hawk', x: -0.55, z: 0, facing: 1 },
      { slot: 1, archetypeId: 'brad_hawk', x: 0.55, z: 0, facing: -1 },
    ]);
    const idle = sim.idleInput();
    const attacker = runner.fighterAt(0);
    const defender = runner.fighterAt(1);
    const aerial = [];
    let peakY = 0;
    let maxDistance = 0;

    for (let tick = 0; tick < 400; tick += 1) {
      const free = attacker.state === 'idle' || attacker.state === 'walk';
      const airborne = defender.state === 'launched' || defender.y > 0;
      let input = idle;
      if (free && airborne) input = sim.idleInput({ attack: AERIAL });
      else if (free && defender.y === 0 && defender.state !== 'launched') {
        input = sim.idleInput({ attack: LAUNCHER });
      }
      for (const event of runner.fixedUpdate(sim.DT, [input, idle])) {
        if (event.type === 'hit' && event.moveId === AERIAL) aerial.push(event);
      }
      peakY = Math.max(peakY, defender.y);
      maxDistance = Math.max(maxDistance, Math.abs(defender.x - attacker.x));
    }
    return { aerial, peakY, maxDistance, defender };
  }

  const { aerial, peakY, maxDistance } = runJuggle();
  if (aerial.length !== sim.JUGGLE_LIMIT) {
    fail(
      `juggle landed ${aerial.length} aerial hits, expected the cap of ${sim.JUGGLE_LIMIT} — ` +
        'a limit nothing can reach is not a limit',
    );
  }
  const aerialDamage = aerial.reduce((sum, event) => sum + event.damage, 0);
  const expectedDamage = sim.JUGGLE_LIMIT * sim.getMove(AERIAL).damage;
  if (aerialDamage !== expectedDamage) {
    fail(`juggle dealt ${aerialDamage} damage, expected ${expectedDamage}`);
  }
  if (maxDistance > sim.getMove(AERIAL).reach * sim.FP_SCALE) {
    fail('the victim drifted outside the juggle tool\u2019s reach, so the cap is unreachable');
  }

  console.log(
    `Aerial hits landed: ${aerial.length} / ${sim.JUGGLE_LIMIT} cap   ` +
      `damage ${aerialDamage}   peak height ${(peakY / sim.FP_SCALE).toFixed(1)}u   ` +
      `max carry ${(maxDistance / sim.FP_SCALE).toFixed(2)}u`,
  );
  console.log(
    `Get-up roll: ${sim.GETUP_FRAMES} frames and invulnerable   ` +
      `knockdown ${sim.KNOCKDOWN_FRAMES} frames`,
  );
  console.log('');
  console.log(
    `${aerial.length === sim.JUGGLE_LIMIT && aerialDamage === expectedDamage ? 'ok' : 'MISMATCH'}`,
  );
}

// ---------------------------------------------------------------------------------------
// 7. Determinism across runs and refresh rates
// ---------------------------------------------------------------------------------------
section('7. Determinism');
{
  const hashes = [];
  for (let run = 0; run < 2; run += 1) {
    const runner = new sim.MatchRunner(engagementSpawns());
    for (let tick = 0; tick < SCRIPTED_TICKS; tick += 1) {
      runner.fixedUpdate(sim.DT, scenarioFor(runner, tick));
    }
    hashes.push(runner.stateHash());
  }
  if (hashes[0] !== hashes[1]) {
    fail(`two identical scripted matches hashed differently (${hashes[0]} vs ${hashes[1]})`);
  }
  console.log(
    `Two independent ${SCRIPTED_TICKS}-tick matches -> ${hashes[0]} ${hashes[0] === hashes[1] ? '(identical)' : '(DIVERGED)'}`,
  );

  // Same scripted match, four simulated display rates, identical tick counts.
  const rateHashes = [];
  for (const frameHz of REFRESH_RATES) {
    const result = await runScriptedMatchAtRate(sim, frameHz, SCRIPTED_TICKS, scenarioFor, engagementSpawns());
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
// 8. Frame advantage (design review, not a hard gate)
// ---------------------------------------------------------------------------------------
section('8. Frame advantage (review band ±' + ADVANTAGE_BAND + ')');
console.log(
  `${pad('move', 34)}${padLeft('on hit', 9)}${padLeft('on block', 11)}${padLeft('hitstun', 10)}` +
    `${padLeft('blockstun', 12)}${pad('guard', 13)}note`,
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
    pad(def.id, 34) +
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
  console.log(`Design notes (non-blocking), ${notes.length}:`);
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

console.log(
  `PASSED — 0 discrepancies across ${sim.MOVESET.length} moves ` +
    `(structure, provenance, frames, contact, defence, juggles, refresh rates, determinism).`,
);
cleanup();