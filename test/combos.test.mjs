/**
 * Directional combo branching, automatic chains, whiff lockout and the Gigaton charge.
 *
 * The first test in this file is the important one: it parses `runtime/combat-trial13/spec.py`
 * and checks the TypeScript chains against it. "I ported the chains" is a claim that rots silently
 * — nobody notices when a limb or an `automatic=True` flag drifts — so it is checked against the
 * upstream source rather than against a copy of itself.
 *
 * The rest covers the Phase 1 mechanics: four-way directional branching, one button producing
 * several contacts, hit-confirm branching that dies on a whiff, the charge tiers, and the
 * single-target / crowd-clear split on the special arts.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, cleanup, loadSim } from '../tools/load-sim.mjs';

const sim = await loadSim();
const {
  ARCHETYPE_CHAINS,
  ARCHETYPES,
  CHAIN_PRESS,
  DT,
  FP_SCALE,
  MatchRunner,
  automaticChain,
  chargeProfileOf,
  chainDamageBudget,
  defaultChainMoveId,
  getMove,
  idleInput,
} = sim;

after(() => {
  cleanup();
});

/** Two archetypes in range of each other's light strings. Coordinates are world units. */
function pairSpawns(left = 'brad_hawk', right = 'brad_hawk', gap = 1.1) {
  return [
    { slot: 0, archetypeId: left, x: -gap / 2, z: 0, facing: 1 },
    { slot: 1, archetypeId: right, x: gap / 2, z: 0, facing: -1 },
  ];
}

function hitEvents(events) {
  return events.filter((event) => event.type === 'hit');
}

/** Play `count` ticks of `inputsFor(tick, runner)` and return everything that happened. */
function play(runner, count, inputsFor) {
  const events = [];
  for (let tick = 0; tick < count; tick += 1) {
    events.push(...runner.fixedUpdate(DT, inputsFor(tick, runner)));
  }
  return events;
}

// -------------------------------------------------------------------------------------------
// The port itself
// -------------------------------------------------------------------------------------------

/**
 * Parse the `CHAINS` table out of spec.py.
 *
 * spec.py is a Python literal, so this reads it structurally rather than trying to eval anything:
 * each `('Name','stance'):` key, and inside it each `move(label, source, [ids], [limbs], …)`
 * record. Labels are quoted with either quote character and one of them contains an apostrophe
 * (`"Death's Door"`), which is why the string matcher is backreference-based rather than
 * `[^'"]*`.
 */
function parseSpecChains() {
  const source = readFileSync(join(ROOT, 'runtime', 'combat-trial13', 'spec.py'), 'utf8');
  const start = source.indexOf('CHAINS={');
  assert.ok(start !== -1, 'spec.py no longer has a CHAINS table');
  const end = source.indexOf('\nTWEAKS=', start);
  assert.ok(end !== -1, 'spec.py no longer ends CHAINS with a TWEAKS block');
  const body = source.slice(start, end);

  const results = [];
  const keyPattern = /\('(\w+)',\s*'(\w+)'\)\s*:\s*\[/g;
  let keyMatch;
  const keys = [];
  while ((keyMatch = keyPattern.exec(body)) !== null) {
    keys.push({ character: keyMatch[1], stance: keyMatch[2], from: keyMatch.index, bodyFrom: keyPattern.lastIndex });
  }

  const movePattern = /\bmove\(/g;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const until = i + 1 < keys.length ? keys[i + 1].from : body.length;
    const slice = body.slice(key.bodyFrom, until);
    let moveMatch;
    movePattern.lastIndex = 0;
    while ((moveMatch = movePattern.exec(slice)) !== null) {
      let cursor = moveMatch.index + moveMatch[0].length;

      // Every read goes through `slice`, and the cursor is an index into `slice`, so the two must
      // never be confused: an earlier version closed over `body` here and silently mis-parsed.
      const skipSpace = () => {
        while (cursor < slice.length && /\s/.test(slice[cursor])) cursor += 1;
      };
      const readString = () => {
        skipSpace();
        const quote = slice[cursor];
        assert.ok(quote === "'" || quote === '"', `expected a quoted string at ${cursor} in ${key.character}`);
        const close = slice.indexOf(quote, cursor + 1);
        assert.ok(close !== -1, `unterminated string at ${cursor} in ${key.character}`);
        const value = slice.slice(cursor + 1, close);
        cursor = close + 1;
        return value;
      };
      const expectComma = (what) => {
        skipSpace();
        assert.equal(slice[cursor], ',', `expected ',' after ${what} in ${key.character}/${key.stance}`);
        cursor += 1;
      };
      const readList = () => {
        skipSpace();
        assert.equal(slice[cursor], '[', `expected a list for ${key.character}/${key.stance}`);
        const close = slice.indexOf(']', cursor);
        const raw = slice.slice(cursor + 1, close);
        cursor = close + 1;

        // spec.py writes Bryan's Vulcan Cannon as `['LH']*4` — Python list repetition, not a
        // literal four-element list. Reading only up to `]` would silently compare one limb
        // against four, so the repetition is expanded here rather than special-cased.
        const repeat = /^\s*\*\s*(\d+)/.exec(slice.slice(cursor));
        let times = 1;
        if (repeat !== null) {
          times = Number(repeat[1]);
          cursor += repeat[0].length;
        }

        const entries = raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => {
            const numeric = Number(part);
            if (Number.isFinite(numeric)) {
              return numeric;
            }
            assert.ok(/^['"].*['"]$/.test(part), `unexpected list entry ${part}`);
            return part.slice(1, -1);
          });

        const expanded = [];
        for (let n = 0; n < times; n += 1) {
          expanded.push(...entries);
        }
        return expanded;
      };

      const label = readString();
      expectComma('the label');
      const source = readString();
      expectComma('the source');
      const sourceIds = readList();
      expectComma('the ids');
      const limbs = readList();

      // Only this record's trailing keyword arguments matter. The window stops at the closing
      // paren of *this* `move()` call: a wider window would let the next record's
      // `automatic=True` be attributed to this chain.
      const closeParen = slice.indexOf(')', cursor);
      const tail = slice.slice(cursor, closeParen === -1 ? cursor + 80 : closeParen);
      results.push({
        character: key.character,
        stance: key.stance,
        label,
        source,
        sourceIds,
        limbs,
        automatic: /\bautomatic=True\b/.test(tail),
        finish: (tail.match(/finish='(\w+)'/) ?? [])[1] ?? null,
      });
    }
  }
  return results;
}

test('every ported chain still matches spec.py', () => {
  const spec = parseSpecChains();

  /**
   * Find the spec.py record a declared chain came from.
   *
   * Matched on (stance, label, source) and deliberately *not* on which button it hangs off:
   * spec.py keys a chain by the character whose input plays it, but Bryan's "Gatling Combination"
   * is filed under `('Kiryu','neutral')` because that is the input it was imported onto, while
   * `move(..., 'Bryan', ...)` names where the animation came from. Keying on the character would
   * miss the single most distinctive chain in this port.
   */
  const findEntry = (chainDef) =>
    spec.find(
      (entry) =>
        entry.stance === chainDef.stance &&
        entry.label === chainDef.label &&
        entry.source === chainDef.source,
    );

  const declared = ARCHETYPE_CHAINS.filter((chainDef) => chainDef.origin === 'trial13');
  const matchedIds = new Set();

  for (const chainDef of declared) {
    const entry = findEntry(chainDef);
    assert.ok(entry !== undefined, `${chainDef.id} (${chainDef.label}) is not in spec.py`);

    assert.deepEqual(
      [...chainDef.sourceIds],
      entry.sourceIds,
      `${chainDef.id}: source action ids drifted from spec.py`,
    );
    assert.deepEqual(
      [...chainDef.limbs],
      entry.limbs,
      `${chainDef.id}: limbs drifted from spec.py`,
    );
    assert.equal(chainDef.source, entry.source, `${chainDef.id}: source character drifted`);
    assert.equal(chainDef.finish, entry.finish, `${chainDef.id}: finish drifted from spec.py`);

    // `spec.py` groups: `automatic=True` collapses the records into one button. That is exactly
    // `chainNextMode: 'automatic'` across the links.
    const automaticFlags = new Set(chainDef.links.map((link) => link.automatic));
    assert.ok(
      automaticFlags.size === 1 && [...automaticFlags][0] === entry.automatic,
      `${chainDef.id}: automatic grouping disagrees with spec.py (automatic=${entry.automatic})`,
    );
    matchedIds.add(chainDef.id);
  }

  // The other direction: spec.py hangs chains off Jack-5's, Jin's and Bryan's own inputs, and
  // every one of them should be here. A chain that is silently absent is a chain someone asked
  // for in Trial 13 and this port quietly dropped.
  const rosterCharacters = new Set(['Jack5', 'Jin', 'Bryan']);
  const ours = spec.filter((entry) => rosterCharacters.has(entry.character));
  const unported = ours.filter((entry) => !matchedIds.has(`${entry.character}/${entry.stance}/${entry.label}`)
    && !ARCHETYPE_CHAINS.some(
      (chainDef) => chainDef.stance === entry.stance && chainDef.label === entry.label && chainDef.source === entry.source,
    ));
  assert.deepEqual(
    unported.map((entry) => `${entry.character}/${entry.stance}/${entry.label}`),
    [],
    'spec.py has chains for Jack-5/Jin/Bryan that this port does not implement',
  );

  // Vacuity guard: if the parser stopped early, `declared` would be empty and the loop above would
  // prove nothing. 17 is the count of Jin/Jack-5/Bryan chains in spec.py plus Bryan's Gatling.
  assert.ok(matchedIds.size >= 17, `only matched ${matchedIds.size} chains from spec.py`);
});

test('chain links, chainNext and chainNextMode agree with each other', () => {
  for (const chainDef of ARCHETYPE_CHAINS) {
    const links = chainDef.links;
    assert.ok(links.length === chainDef.sourceIds.length, `${chainDef.id}: link/sourceId count`);

    for (const [index, link] of links.entries()) {
      const def = getMove(link.moveId);
      assert.ok(def !== undefined, `${chainDef.id}: link ${link.moveId} is not in MOVESET`);
      assert.equal(def.limb, chainDef.limbs[index], `${def.id}: limb differs from the chain`);
      assert.equal(
        def.sourceActionId,
        chainDef.sourceIds[index],
        `${def.id}: sourceActionId differs from the chain`,
      );

      const expectedNext = links[index + 1]?.moveId ?? null;
      assert.equal(def.chainNext, expectedNext, `${def.id}: chainNext is not the next link`);
      const expectedMode = expectedNext === null ? 'none' : link.automatic ? 'automatic' : 'hitConfirm';
      assert.equal(def.chainNextMode, expectedMode, `${def.id}: chainNextMode is not ${expectedMode}`);
    }
  }
});

test('every automatic chain keeps its range, and only its last hit displaces', () => {
  // A chain that drifts out of its own reach by hit three is a broken combo, and the reason one
  // drifts is knockback accumulating across links the attacker never walks back.
  for (const chainDef of ARCHETYPE_CHAINS) {
    if (!chainDef.links[0]?.automatic) {
      continue;
    }
    const defs = chainDef.links.map((link) => getMove(link.moveId));
    const reaches = new Set(defs.map((def) => def.reach));
    assert.equal(reaches.size, 1, `${chainDef.id}: automatic chain links disagree on reach (${[...reaches]})`);

    for (const [index, def] of defs.entries()) {
      const isLast = index === defs.length - 1;
      if (!isLast && def.knockdown === true) {
        assert.equal(def.knockback, 0, `${def.id}: mid-chain link displaces the victim out of the chain`);
      }
    }
  }
});

// -------------------------------------------------------------------------------------------
// Four-way directional branching
// -------------------------------------------------------------------------------------------

test('a stance press starts that stance\u2019s chain, for every archetype', () => {
  for (const archetype of ARCHETYPES) {
    for (const stance of ['neutral', 'up', 'down', 'side']) {
      const opener = defaultChainMoveId(archetype.id, stance);
      assert.ok(opener !== undefined, `${archetype.id} has no ${stance} chain`);

      const runner = new MatchRunner(pairSpawns(archetype.id, 'brad_hawk', 1.2));
      runner.fixedUpdate(DT, [idleInput({ attack: stance }), idleInput()]);
      assert.equal(
        runner.fighterAt(0).currentMove,
        opener,
        `${archetype.id}: '${stance}' did not start ${opener}`,
      );

      // CHAIN_PRESS + the same stance must resolve identically: that is the input mapping a
      // controller or touch pad produces.
      const viaSentinel = new MatchRunner(pairSpawns(archetype.id, 'brad_hawk', 1.2));
      viaSentinel.fixedUpdate(DT, [idleInput({ attack: CHAIN_PRESS, stance }), idleInput()]);
      assert.equal(
        viaSentinel.fighterAt(0).currentMove,
        opener,
        `${archetype.id}: CHAIN_PRESS with stance ${stance} did not start ${opener}`,
      );
    }
  }
});

test('the four stances select four different chains', () => {
  const runner = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.2));
  const openers = ['neutral', 'up', 'down', 'side'].map((stance) => {
    const fresh = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.2));
    fresh.fixedUpdate(DT, [idleInput({ attack: stance }), idleInput()]);
    void runner;
    return fresh.fighterAt(0).currentMove;
  });
  assert.equal(new Set(openers).size, 4, `stances collided: ${openers.join(', ')}`);
});

// -------------------------------------------------------------------------------------------
// Automatic chains: one button, several contacts
// -------------------------------------------------------------------------------------------

test('an automatic chain runs every link from a single input', () => {
  // spec.py's automatic groups: Piston Gun (5), Double Chamber Punch (2), Jin's SPA 2 (4),
  // Bryan's SPA 1 (4).
  const cases = [
    ['jack5_piston_gun_1', 5],
    ['jin_double_chamber_punch_1', 2],
    ['jin_flurry_1', 4],
    ['bryan_spa1_1', 4],
  ];

  for (const [moveId, expectedContacts] of cases) {
    const def = getMove(moveId);
    const runner = new MatchRunner(pairSpawns('brad_hawk', 'brad_hawk', def.reach - 0.3));
    runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;

    const events = play(runner, 240, (tick) => [
      tick === 0 ? idleInput({ attack: moveId }) : idleInput(),
      idleInput(),
    ]);

    const hits = hitEvents(events);
    assert.equal(
      hits.length,
      expectedContacts,
      `${moveId}: one button should land ${expectedContacts} contacts, landed ${hits.length}`,
    );
    assert.deepEqual(
      hits.map((hit) => hit.moveId),
      automaticChain(def).map((link) => link.id),
      `${moveId}: contacts did not follow the chain in order`,
    );
    const damage = hits.reduce((sum, hit) => sum + hit.damage, 0);
    assert.equal(damage, chainDamageBudget(def), `${moveId}: chain damage is wrong`);
  }
});

test('automatic chains still run when the first link whiffs', () => {
  // A whiffed Piston Gun is still one animation: the barrels keep firing. This is the spec.py
  // rule "one button input, multiple source records in one group".
  const def = getMove('jack5_piston_gun_1');
  const runner = new MatchRunner([
    { slot: 0, archetypeId: 'brad_hawk', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: 40, z: 0, facing: -1 },
  ]);
  const events = play(runner, 200, (tick) => [
    tick === 0 ? idleInput({ attack: def.id }) : idleInput(),
    idleInput(),
  ]);
  assert.equal(hitEvents(events).length, 0, 'nothing was in range, so nothing should connect');
  const seen = new Set();
  for (let tick = 0; tick < 200; tick += 1) {
    runner.fighterAt(0).currentMove;
  }
  // Walk the chain the hard way: every automatic link must have been executed at some point.
  const replay = new MatchRunner([
    { slot: 0, archetypeId: 'brad_hawk', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: 40, z: 0, facing: -1 },
  ]);
  let events2 = replay.fixedUpdate(DT, [idleInput({ attack: def.id }), idleInput()]);
  for (let tick = 1; tick < 200; tick += 1) {
    events2 = replay.fixedUpdate(DT, [idleInput(), idleInput()]);
    if (replay.fighterAt(0).currentMove !== null) {
      seen.add(replay.fighterAt(0).currentMove);
    }
  }
  assert.deepEqual(
    [...seen],
    automaticChain(def).map((link) => link.id),
    `${def.id}: a whiffed automatic chain did not run to the end`,
  );
});

// -------------------------------------------------------------------------------------------
// Hit-confirm branching and whiff lockout
// -------------------------------------------------------------------------------------------

test('Jin\u2019s Kazama Style 5 Hit Combo confirms five times into five contacts', () => {
  const runner = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));
  const prefix = 'jin_kazama_style_5_hit_combo_';
  let next = 2;

  const events = play(runner, 300, (tick, current) => {
    const attacker = current.fighterAt(0);
    if (tick === 0) {
      return [idleInput({ attack: `${prefix}1` }), idleInput()];
    }
    if (attacker.chainWindow > 0 && next <= 5) {
      next += 1;
      return [idleInput({ attack: `${prefix}${next - 1}` }), idleInput()];
    }
    return [idleInput(), idleInput()];
  });

  const hits = hitEvents(events);
  assert.equal(hits.length, 5, `expected 5 confirmed hits, got ${hits.length}`);
  assert.deepEqual(
    hits.map((hit) => hit.moveId),
    [1, 2, 3, 4, 5].map((n) => `${prefix}${n}`),
  );
});

test('whiffing a branchable link ends the string and locks out further chain starts', () => {
  const runner = new MatchRunner([
    { slot: 0, archetypeId: 'jin_kazama', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: 40, z: 0, facing: -1 },
  ]);

  // Burn the opener against empty air. Stop as soon as the move is over: the lockout is a short
  // timer, and idling past its expiry would make this test pass for the wrong reason.
  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }), idleInput()]);
  let ticks = 1;
  while (runner.fighterAt(0).currentMove !== null && ticks < 60) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    ticks += 1;
  }
  runner.fixedUpdate(DT, [idleInput(), idleInput()]);

  const attacker = runner.fighterAt(0);
  assert.equal(attacker.currentMove, null, 'the whiffed move should have finished');
  assert.equal(attacker.chainId, '', 'a whiff must not leave a branch ticket');
  assert.ok(attacker.whiffLockout > 0, 'a whiff should have started the lockout');

  // While locked out, the same chain opener is refused...
  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }), idleInput()]);
  assert.equal(
    runner.fighterAt(0).currentMove,
    null,
    'the chain opener started during the whiff lockout',
  );

  // ...but an unrelated move is not locked out: the lockout punishes the string, not the fighter.
  runner.fixedUpdate(DT, [idleInput({ attack: 'brad_hawk_barrage_1' }), idleInput()]);
  assert.equal(runner.fighterAt(0).currentMove, null, 'jab has no chain, so nothing should start');

  // Once the lockout expires the chain is available again.
  let guard = 0;
  while (runner.fighterAt(0).whiffLockout > 0 && guard < 200) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    guard += 1;
  }
  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }), idleInput()]);
  assert.equal(
    runner.fighterAt(0).currentMove,
    'jin_kazama_style_5_hit_combo_1',
    'the chain never became available again',
  );
});

test('a branch only links to the declared next link', () => {
  // What the guard actually buys: only the *next* link continues a confirmed string. Any other
  // move can still be started — a brawler should let a player choose their string — but doing so
  // spends the cancel window and starts fresh rather than continuing the confirm.
  const runner = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));

  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }), idleInput()]);
  let ticks = 1;
  while (runner.fighterAt(0).chainWindow === 0 && ticks < 60) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    ticks += 1;
  }
  assert.ok(runner.fighterAt(0).chainWindow > 0, 'link 1 should have opened a branch window');
  assert.equal(
    runner.fighterAt(0).branchTarget,
    'jin_kazama_style_5_hit_combo_2',
    'the window should name the next link, not the whole chain',
  );

  // Link 5 belongs to the same chain but is not the *next* link, so it does not continue the
  // confirm — and choosing it spends the window.
  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_5' }), idleInput()]);
  assert.equal(runner.fighterAt(0).chainWindow, 0, 'the cancel window should have been spent');
  assert.equal(runner.fighterAt(0).branchTarget, '', 'the branch ticket should be gone');

  // The declared next link is accepted as a branch, which is what makes the guard a restriction on
  // *which* link rather than a blanket refusal that would break combos entirely.
  const second = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));
  second.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }), idleInput()]);
  ticks = 1;
  while (second.fighterAt(0).chainWindow === 0 && ticks < 60) {
    second.fixedUpdate(DT, [idleInput(), idleInput()]);
    ticks += 1;
  }
  second.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_2' }), idleInput()]);
  assert.equal(
    second.fighterAt(0).currentMove,
    'jin_kazama_style_5_hit_combo_2',
    'the real next link should branch in',
  );
});

test('an interrupted charge does not leave a stale release pending', () => {
  // Regression guard. `chargeRelease` used to survive a hit that knocked the fighter out of the
  // charge, so the next hold fired the instant it reached the first windup: a 124-frame hold that
  // should reach Gigaton level 5 silently became level 1 after one interruption.
  //
  // The interruption has to come from the *opponent*: a fighter in `charging` owns its own input,
  // so it cannot jab itself out of the charge.
  const profile = chargeProfileOf('jack5');
  const runner = new MatchRunner(pairSpawns('jack5', 'brad_hawk', 1.1));
  const charger = runner.fighterAt(0);
  charger.spaMeter = charger.spaMax;
  const hold = idleInput({ attack: profile.chainEntry });

  // Start charging and release early, so the release is buffered rather than immediate.
  runner.fixedUpdate(DT, [hold, idleInput()]);
  runner.fixedUpdate(DT, [idleInput(), idleInput()]);
  assert.equal(charger.state, 'charging', 'the charge should still be winding up');
  assert.equal(charger.chargeRelease, true, 'the early release should be buffered');

  // The opponent lands a jab on the charger.
  runner.fixedUpdate(DT, [idleInput(), idleInput({ attack: 'brad_hawk_barrage_1' })]);
  let ticks = 0;
  while (charger.state === 'charging' && ticks < 30) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    ticks += 1;
  }
  assert.notEqual(charger.state, 'charging', 'the charge should have been interrupted by the hit');
  assert.ok(charger.stunRemaining > 0 || charger.state === 'hitstun', 'the charger should be in hitstun');

  // Recover, then hold the button through a full level-5 window. The contract under test is
  // observable behaviour, not the internal flag: after an interruption a full hold must still
  // reach level 5.
  let guard = 0;
  while (charger.state !== 'idle' && guard < 200) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    guard += 1;
  }

  runner.fixedUpdate(DT, [hold, idleInput()]);
  for (let tick = 1; tick < 28 + 4 * 24; tick += 1) {
    runner.fixedUpdate(DT, [hold, idleInput()]);
  }
  runner.fixedUpdate(DT, [idleInput(), idleInput()]);
  runner.fixedUpdate(DT, [idleInput(), idleInput()]);

  assert.equal(charger.chargeLevel, 5, `a full hold after an interruption reached level ${charger.chargeLevel}`);
  assert.equal(charger.currentMove, 'jack5_gigaton_5');
});

test('the cancel window lapses if the next link is not pressed', () => {
  const runner = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));
  let ticks = 0;
  while (runner.fighterAt(0).chainWindow === 0 && ticks < 60) {
    runner.fixedUpdate(DT, [
      ticks === 0 ? idleInput({ attack: 'jin_kazama_style_5_hit_combo_1' }) : idleInput(),
      idleInput(),
    ]);
    ticks += 1;
  }
  assert.ok(runner.fighterAt(0).chainWindow > 0, 'a connected link should open a window');

  let guard = 0;
  while (runner.fighterAt(0).chainWindow > 0 && guard < 100) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    guard += 1;
  }
  assert.equal(runner.fighterAt(0).chainId, '', 'the branch ticket should expire with the window');

  runner.fixedUpdate(DT, [idleInput({ attack: 'jin_kazama_style_5_hit_combo_2' }), idleInput()]);
  assert.equal(
    runner.fighterAt(0).currentMove,
    'jin_kazama_style_5_hit_combo_2',
    'after the window lapsed the chain can only be restarted from the front',
  );
  // A fresh start is the opener, never link 5: this is the front of the string.
  const fresh = new MatchRunner(pairSpawns('jin_kazama', 'brad_hawk', 1.1));
  fresh.fixedUpdate(DT, [idleInput({ attack: 'side' }), idleInput()]);
  assert.equal(fresh.fighterAt(0).currentMove, 'jin_kazama_style_5_hit_combo_1');
});

// -------------------------------------------------------------------------------------------
// The five-level Gigaton
// -------------------------------------------------------------------------------------------

test('the Gigaton charges through five tiers on the ISO\u2019s own 28/24 frame cadence', () => {
  const profile = chargeProfileOf('jack5');
  assert.ok(profile !== null, 'Jack-5 should have a charge profile');
  assert.equal(profile.firstWindupFrames, 28, 'gigaton_charge.py: first windup is 28 frames');
  assert.equal(profile.loopFrames, 24, 'gigaton_charge.py: the repeat loop is 24 frames');
  assert.equal(profile.maxLevel, 5, 'gigaton_charge.py builds five releases');

  /** Hold the button for `held` ticks, let go, and report which release came out. */
  function releaseAfter(held) {
    const runner = new MatchRunner(pairSpawns('jack5', 'brad_hawk', 2.4));
    runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;
    const hold = idleInput({ attack: profile.chainEntry });

    runner.fixedUpdate(DT, [hold, idleInput()]);
    for (let tick = 1; tick < held; tick += 1) {
      runner.fixedUpdate(DT, [hold, idleInput()]);
    }
    // Release, then give the buffered release a tick to land.
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    return runner.fighterAt(0);
  }

  const expected = [
    [28, 1], [40, 1],
    [28 + 24, 2], [28 + 48, 3], [28 + 72, 4], [28 + 96, 5],
    [28 + 5 * 24, 5], [400, 5],
  ];
  for (const [held, level] of expected) {
    const fighter = releaseAfter(held);
    assert.equal(fighter.chargeLevel, level, `held ${held} should reach level ${level}`);
    assert.equal(fighter.currentMove, `jack5_gigaton_${level}`, `held ${held} fired the wrong release`);
  }
});

test('the Gigaton is paid for once, at level 1', () => {
  // gigaton_charge.py writes the cost as `cost if i==0 else 0`: one charge for the whole hold,
  // not one per tier.
  const defs = [1, 2, 3, 4, 5].map((level) => getMove(`jack5_gigaton_${level}`));
  assert.equal(defs[0].spaCost, 50, 'level 1 carries the cost');
  for (const def of defs.slice(1)) {
    assert.equal(def.spaCost, 0, `${def.id} charged the gauge again`);
    assert.equal(def.spaTier, defs[0].spaTier, `${def.id} tier drifted from level 1`);
  }

  // Damage follows gigaton_charge.py: `round(base * (1 + 0.4 * i))`.
  assert.deepEqual(
    defs.map((def) => def.damage),
    [90, 126, 162, 198, 234],
    'the damage ladder is not base * (1 + 0.4 * i)',
  );
  for (const def of defs) {
    assert.equal(def.chargeLevel, defs.indexOf(def) + 1, `${def.id} chargeLevel is wrong`);
    assert.equal(def.knockdown, true, `${def.id} should knock down`);
  }
});

test('the charge cannot be entered without the gauge', () => {
  const runner = new MatchRunner(pairSpawns('jack5', 'brad_hawk', 2.4));
  runner.fighterAt(0).spaMeter = 10;
  runner.fixedUpdate(DT, [idleInput({ attack: 'jack5_gigaton' }), idleInput()]);
  assert.equal(runner.fighterAt(0).state, 'idle', 'a charge with no gauge must not start');
});

test('a release below the first windup is buffered, not skipped', () => {
  const runner = new MatchRunner(pairSpawns('jack5', 'brad_hawk', 2.4));
  runner.fighterAt(0).spaMeter = runner.fighterAt(0).spaMax;
  runner.fixedUpdate(DT, [idleInput({ attack: 'jack5_gigaton' }), idleInput()]);
  runner.fixedUpdate(DT, [idleInput(), idleInput()]); // released after two ticks

  let guard = 0;
  while (runner.fighterAt(0).state === 'charging' && guard < 100) {
    runner.fixedUpdate(DT, [idleInput(), idleInput()]);
    guard += 1;
  }
  assert.equal(runner.fighterAt(0).state !== 'charging', true, 'the charge never resolved');
  assert.equal(
    runner.fighterAt(0).chargeLevel,
    1,
    'an early release must still pay the full first windup, at level 1',
  );
});

// -------------------------------------------------------------------------------------------
// Special arts
// -------------------------------------------------------------------------------------------

test('SPA 1 hits a single target and SPA 2 clears the crowd', () => {
  // One victim in front and one behind, both within SPA 2's 360 reach. The rear one is what
  // proves the difference: SPA 1's forward-only hitbox cannot see it, SPA 2's can.
  const crowd = [
    { slot: 0, archetypeId: 'brad_hawk', x: 0, z: 0, facing: 1 },
    { slot: 1, archetypeId: 'brad_hawk', x: 1.8, z: 0, facing: -1 },
    { slot: 2, archetypeId: 'brad_hawk', x: -1.8, z: 0, facing: 1 },
  ];

  const single = new MatchRunner(crowd);
  single.fighterAt(0).spaMeter = 100;
  let spa1Hits = 0;
  for (let tick = 0; tick < 90; tick += 1) {
    const events = single.fixedUpdate(DT, [
      tick === 0 ? idleInput({ attack: 'brad_hawk_spa1' }) : idleInput(),
      idleInput(),
      idleInput(),
    ]);
    spa1Hits += hitEvents(events).length;
  }
  assert.equal(spa1Hits, 1, `SPA 1 is single-target, but it hit ${spa1Hits} times`);

  const clear = new MatchRunner(crowd);
  clear.fighterAt(0).spaMeter = 100;
  let spa2Hits = 0;
  const victims = new Set();
  for (let tick = 0; tick < 120; tick += 1) {
    const events = clear.fixedUpdate(DT, [
      tick === 0 ? idleInput({ attack: 'brad_hawk_spa2' }) : idleInput(),
      idleInput(),
      idleInput(),
    ]);
    for (const hit of hitEvents(events)) {
      spa2Hits += 1;
      victims.add(hit.defenderSlot);
    }
  }
  assert.equal(spa2Hits, 2, `SPA 2 should clear the crowd, hit ${spa2Hits} times`);
  assert.deepEqual([...victims].sort(), [1, 2], 'SPA 2 must reach the opponent behind it too');
});

test('the gauge charges the attacker for dealing a hit and the defender for taking one', () => {
  const runner = new MatchRunner(pairSpawns('brad_hawk', 'brad_hawk', 1.1));
  const attacker = runner.fighterAt(0);
  const defender = runner.fighterAt(1);
  assert.equal(attacker.spaMeter, 0);
  assert.equal(defender.spaMeter, 0);

  play(runner, 40, (tick) => [
    tick === 0 ? idleInput({ attack: 'brad_hawk_barrage_1' }) : idleInput(),
    idleInput(),
  ]);

  assert.ok(attacker.spaMeter > 0, 'landing a hit must charge the attacker');
  assert.ok(defender.spaMeter > 0, 'taking a hit must charge the defender');
});