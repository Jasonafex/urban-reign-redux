/**
 * Device layer and input-buffer contract (`npm test`).
 *
 * The Phase 2 stack is only as trustworthy as its weakest device, so this suite pins the three
 * things every device must do identically, plus the two that are genuinely device-specific:
 *
 *   - the radial deadzone rejects resting noise without flattening diagonals
 *   - one physical press produces exactly one edge and exactly one `attack`
 *   - a press the sim rejected is re-offered for `INPUT_BUFFER_TICKS` ticks, then dropped
 *   - a pad, a keyboard and a thumb all reach the simulation as the same `FrameInput`
 *   - the layer imports cleanly in Node and never touches the DOM or a wall clock
 *
 * The suite runs the *real* TypeScript sources through esbuild (see `tools/load-sim.mjs`),
 * headless, with no browser globals present.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import {
  INPUT_ENTRY,
  buildSources,
  cleanup,
  loadInput,
  loadSim,
  sourceFor,
} from '../tools/load-sim.mjs';

const input = await loadInput();
const sim = await loadSim();

const {
  INPUT_ACTIONS,
  INPUT_DEADZONE,
  KEYBOARD_LAYOUTS,
  P1_KEYBOARD,
  P2_KEYBOARD,
  applyRadialDeadzone,
  clampAxis,
  controlWith,
  layoutKeyCodes,
  layoutKeyOverlap,
  snapToOctant,
  GamepadSource,
  GAMEPAD_DEADZONE,
  MAX_GAMEPADS,
  KeyboardSource,
  InputHistory,
  INPUT_BUFFER_TICKS,
  attackTokenFor,
  stanceFor,
  GRAB_HIGH_MOVE,
  GRAB_LOW_MOVE,
  SPA_CROWD_MOVE,
  SPA_LETHAL_MOVE,
} = input;

const { MatchRunner, CHAIN_PRESS, NEUTRAL_INPUT } = sim;
const { engagementSpawns } = await import('../tools/measure-frames.mjs');

after(cleanup);

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

/** A Standard Gamepad of the shape `navigator.getGamepads()` returns. */
function makePad(index = 0, overrides = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  return {
    index,
    id: `Fake Pad ${index}`,
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons,
    ...overrides,
  };
}

function setButton(pad, buttonIndex, down) {
  pad.buttons[buttonIndex] = { pressed: down, touched: down, value: down ? 1 : 0 };
  return pad;
}

function navigatorFor(pads) {
  return { getGamepads: () => pads };
}

const NEUTRAL = controlWith();

/** Record one control sample on a history and return the `FrameInput` it produced. */
function tick(history, control, tickNumber) {
  history.record(control, tickNumber);
  return history.frameInput(tickNumber);
}

// -------------------------------------------------------------------------------------------
// Deadzone
// -------------------------------------------------------------------------------------------

test('radial deadzone rejects resting noise and keeps diagonals usable', () => {
  assert.equal(INPUT_DEADZONE, 0.18);
  assert.equal(GAMEPAD_DEADZONE, 0.18);

  // Inside the gate — the noise floor of a cheap pad, and a thumb resting on glass.
  assert.deepEqual(applyRadialDeadzone(0.1, 0), { x: 0, z: 0 });
  assert.deepEqual(applyRadialDeadzone(0, -0.18), { x: 0, z: 0 });
  assert.deepEqual(applyRadialDeadzone(0.18, 0), { x: 0, z: 0 });

  // A *per-axis* gate would zero both components here, which is precisely the bug the radial form
  // exists to prevent: a stick resting at (0.18, 0.18) is 0.25 from centre and is being held.
  const diagonal = applyRadialDeadzone(0.18, 0.18);
  assert.ok(diagonal.x > 0, 'diagonal x survives the gate');
  assert.equal(diagonal.x, diagonal.z, 'diagonal stays diagonal');

  // Full deflection survives: the gate eats 18% of the *range*, not 18% of every push.
  assert.equal(applyRadialDeadzone(1, 0).x, 1);
  assert.equal(applyRadialDeadzone(-1, 0).x, -1);

  // Past the gate the remaining travel is rescaled, so a small push past the gate is still a small
  // push rather than a full-speed walk.
  const barely = applyRadialDeadzone(0.2, 0);
  assert.ok(barely.x > 0 && barely.x < 0.05, `expected a small value past the gate, got ${barely.x}`);

  // Direction is preserved for every angle.
  for (const [x, z] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [0.7, -0.7],
  ]) {
    const out = applyRadialDeadzone(x, z, 0.1);
    assert.ok(Math.sign(out.x) === Math.sign(x) || out.x === 0);
    assert.ok(Math.sign(out.z) === Math.sign(z) || out.z === 0);
  }

  // Garbage in, neutral out: a browser that reports NaN for an axis must not teleport a fighter.
  assert.deepEqual(applyRadialDeadzone(Number.NaN, 1), { x: 0, z: 0 });

  // A stick shoved past its own range clamps to the unit circle instead of exceeding it, and the
  // direction survives.
  const shoved = applyRadialDeadzone(2, 2);
  assert.ok(Math.hypot(shoved.x, shoved.z) <= 1, 'clamped to the unit circle');
  assert.ok(shoved.x > 0 && shoved.z > 0 && shoved.x === shoved.z, 'direction preserved');
});

test('octant snap and axis clamp are total functions', () => {
  assert.deepEqual(snapToOctant(0.3, -0.9), { x: 1, z: -1 });
  assert.deepEqual(snapToOctant(-0.0001, 0.0001), { x: -1, z: 1 });
  assert.deepEqual(snapToOctant(0, 0), { x: 0, z: 0 });
  assert.equal(clampAxis(5), 1);
  assert.equal(clampAxis(-5), -1);
  assert.equal(clampAxis(Number.NaN), 0);
});

// -------------------------------------------------------------------------------------------
// Gamepad
// -------------------------------------------------------------------------------------------

test('gamepad maps the standard buttons to the five documented actions', () => {
  const cases = [
    [0, 'strike'],
    [2, 'grab'],
    [3, 'special'],
    [4, 'dodgeHigh'],
    [5, 'dodgeLow'],
    [6, 'targetSwitch'],
  ];
  for (const [button, action] of cases) {
    const pad = setButton(makePad(), button, true);
    const [sample] = new GamepadSource({ navigator: navigatorFor([pad]) }).poll();
    assert.ok(sample, 'pad sampled');
    assert.equal(sample.control.held[action], true, `button ${button} -> ${action}`);
    assert.ok(sample.pressed.includes(action), `button ${button} is a press edge for ${action}`);
    assert.equal(sample.active, true);
  }
});

test('gamepad guard follows the stick: B alone is high, B + down is the sweep guard', () => {
  const pad = makePad();
  const source = new GamepadSource({ navigator: navigatorFor([pad]) });

  setButton(pad, 1, true); // B held
  let [sample] = source.poll();
  assert.equal(sample.control.held.guardHigh, true);
  assert.equal(sample.control.held.guardLow, false);

  pad.axes = [0, 1]; // push the stick down
  [sample] = source.poll();
  assert.equal(sample.control.held.guardHigh, true);
  assert.equal(sample.control.held.guardLow, true, 'down + guard is the sweep guard');

  pad.axes = [0, 0];
  [sample] = source.poll();
  assert.equal(sample.control.held.guardLow, false);
});

test('gamepad deadzones the stick and folds in the D-pad', () => {
  const pad = makePad();
  const source = new GamepadSource({ navigator: navigatorFor([pad]) });

  pad.axes = [0.08, -0.05]; // resting drift
  let [sample] = source.poll();
  assert.equal(sample.control.moveX, 0, 'resting drift is rejected');
  assert.equal(sample.control.moveZ, 0);
  assert.equal(sample.active, false, 'a resting pad is not a player');

  pad.axes = [1, 0];
  [sample] = source.poll();
  assert.ok(sample.control.moveX > 0.9, 'full right');
  assert.equal(sample.control.moveZ, 0);

  pad.axes = [0, 0];
  setButton(pad, 12, true); // D-pad up
  [sample] = source.poll();
  assert.equal(sample.control.moveZ, -1, 'D-pad up walks back');
  assert.equal(sample.active, true);
});

test('gamepad reports one press edge per physical press', () => {
  const pad = makePad();
  const source = new GamepadSource({ navigator: navigatorFor([pad]) });

  setButton(pad, 0, true);
  let [sample] = source.poll();
  assert.deepEqual([...sample.pressed], ['strike']);

  [sample] = source.poll(); // still held
  assert.deepEqual([...sample.pressed], [], 'a held button is not a second press');

  setButton(pad, 0, false);
  source.poll();
  setButton(pad, 0, true);
  [sample] = source.poll();
  assert.deepEqual([...sample.pressed], ['strike'], 'releasing and pressing again is a new press');
});

test('gamepad polls at most four pads and sorts by index', () => {
  assert.equal(MAX_GAMEPADS, 4);
  const pads = [3, 1, 0, 2, 5].map((index) => setButton(makePad(index), 0, true));
  const samples = new GamepadSource({ navigator: navigatorFor(pads) }).poll();
  assert.equal(samples.length, 4);
  assert.deepEqual(samples.map((s) => s.index), [0, 1, 2, 3]);
});

test('gamepad survives a host with no gamepad API', () => {
  const source = new GamepadSource();
  // Node has `navigator` but no `getGamepads`; the source must degrade to "no pads", not throw.
  assert.equal(source.available, false);
  assert.deepEqual(source.poll(), []);

  const throwing = new GamepadSource({
    navigator: {
      getGamepads() {
        throw new Error('Gamepad API disabled');
      },
    },
  });
  assert.deepEqual(throwing.poll(), []);
});

// -------------------------------------------------------------------------------------------
// Keyboard
// -------------------------------------------------------------------------------------------

test('the two split-keyboard layouts share no key', () => {
  assert.equal(KEYBOARD_LAYOUTS.length, 2);
  assert.equal(P1_KEYBOARD.slot, 0);
  assert.equal(P2_KEYBOARD.slot, 1);
  assert.equal(P1_KEYBOARD.up, 'KeyW');
  assert.equal(P2_KEYBOARD.up, 'ArrowUp');
  assert.deepEqual(
    [...layoutKeyOverlap(P1_KEYBOARD, P2_KEYBOARD)],
    [],
    'two players on one keyboard must not fight over a key',
  );
  for (const layout of KEYBOARD_LAYOUTS) {
    assert.equal(layoutKeyCodes(layout).size, 12, `${layout.id} binds 12 distinct keys`);
  }
});

test('keyboard source samples both layouts independently', () => {
  const keyboard = new KeyboardSource();

  keyboard.keyDown('KeyD');
  keyboard.keyDown('Numpad1');
  keyboard.keyDown('ArrowLeft');
  const states = keyboard.poll();
  const p1 = states.find((s) => s.layout.id === P1_KEYBOARD.id);
  const p2 = states.find((s) => s.layout.id === P2_KEYBOARD.id);
  assert.equal(p1.control.moveX, 1);
  assert.equal(p1.active, true);
  assert.equal(p1.pressed.length, 0, 'a direction key is not an action press');
  assert.equal(p2.control.held.strike, true);
  assert.deepEqual(
    [...p2.pressed],
    ['strike'],
    'a later keydown must not wipe a press edge that has not been sampled yet',
  );
  assert.equal(p1.control.held.strike, false, 'P2 pressing strike must not fire P1');

  keyboard.keyUp('Numpad1');
  assert.equal(keyboard.stateFor(P2_KEYBOARD.id).control.held.strike, false);
});

test('keyboard ignores OS auto-repeat and clears on blur', () => {
  const keyboard = new KeyboardSource();
  keyboard.keyDown('KeyJ');
  let p1 = keyboard.poll().find((s) => s.layout.id === P1_KEYBOARD.id);
  assert.deepEqual([...p1.pressed], ['strike']);

  keyboard.keyDown('KeyJ', true); // OS repeat
  p1 = keyboard.poll().find((s) => s.layout.id === P1_KEYBOARD.id);
  assert.deepEqual([...p1.pressed], [], 'auto-repeat is not a press');
  assert.equal(p1.control.held.strike, true, 'the key is still down');

  keyboard.releaseAll();
  assert.equal(keyboard.stateFor(P1_KEYBOARD.id).active, false);
  assert.equal(keyboard.isActive(P1_KEYBOARD.id), false);

  // A keyup for a key this source never saw is a fact about the OS, not an input-layer error.
  assert.deepEqual([...keyboard.keyUp('KeyQ')], []);
});

test('the keyboard source reports which keys the game owns', () => {
  const keyboard = new KeyboardSource();
  // The entry point calls `preventDefault()` on these, so a binding the browser also uses (the
  // arrow cluster scrolls the page) must be reported.
  for (const code of ['KeyW', 'KeyJ', 'ArrowUp', 'Numpad1', 'ShiftLeft']) {
    assert.equal(keyboard.bindsKey(code), true, `${code} is bound`);
  }
  for (const code of ['KeyQ', 'Enter', 'Space', 'F1']) {
    assert.equal(keyboard.bindsKey(code), false, `${code} is not bound`);
  }
});

// -------------------------------------------------------------------------------------------
// Input buffer
// -------------------------------------------------------------------------------------------

test('stance follows the held direction for 4-way chain branching', () => {
  assert.equal(stanceFor(0, -1), 'up');
  assert.equal(stanceFor(0, 1), 'down');
  assert.equal(stanceFor(1, 0), 'side');
  assert.equal(stanceFor(-1, 0), 'side');
  assert.equal(stanceFor(0, 0), 'neutral');
  assert.equal(stanceFor(0.6, -0.8), 'up', 'up wins over the diagonal it is combined with');
});

test('each action maps to a legal attack token', () => {
  assert.equal(attackTokenFor('strike', { stance: 'neutral', guarding: false }), CHAIN_PRESS);
  assert.equal(attackTokenFor('grab', { stance: 'neutral', guarding: false }), GRAB_HIGH_MOVE);
  assert.equal(attackTokenFor('grab', { stance: 'down', guarding: false }), GRAB_LOW_MOVE);
  assert.equal(attackTokenFor('special', { stance: 'neutral', guarding: false }), SPA_LETHAL_MOVE);
  assert.equal(
    attackTokenFor('special', { stance: 'neutral', guarding: true }),
    SPA_CROWD_MOVE,
    'SPA while guarding is the crowd-clear escape',
  );
  assert.equal(attackTokenFor('dodgeHigh', { stance: 'neutral', guarding: false }), null);
  assert.equal(attackTokenFor('targetSwitch', { stance: 'neutral', guarding: false }), null);
});

test('one press yields one attack, and holding does not machine-gun the chain', () => {
  const history = new InputHistory(0);
  const holdingStrike = controlWith(NEUTRAL, { held: { strike: true } });

  const first = tick(history, holdingStrike, 0);
  assert.equal(first.attack, CHAIN_PRESS);
  assert.equal(history.pressed('strike', 0), true, 'the press edge is visible on its own tick');
  history.settle(true, 0);

  for (let t = 1; t <= 20; t += 1) {
    const input = tick(history, holdingStrike, t);
    assert.equal(input.attack, null, `tick ${t} must not re-fire a held strike`);
    history.settle(true, t);
  }
  assert.equal(
    history.pressed('strike', 20),
    false,
    'the press edge aged out of the 8-tick history',
  );
});

test('a rejected press is buffered for eight ticks, then dropped', () => {
  const history = new InputHistory(0);
  const press = controlWith(NEUTRAL, { held: { strike: true } });
  const idle = controlWith();

  tick(history, press, 0);
  history.settle(false, 0); // fighter was in recovery

  for (let t = 1; t < INPUT_BUFFER_TICKS; t += 1) {
    const input = tick(history, idle, t);
    assert.equal(input.attack, CHAIN_PRESS, `press is still live on tick ${t}`);
    history.settle(false, t);
  }

  const expired = tick(history, idle, INPUT_BUFFER_TICKS);
  assert.equal(expired.attack, null, 'the press expired after the 8-tick window');
  assert.equal(history.pendingPresses, 0);
});

test('an accepted press discards older buffered presses', () => {
  const history = new InputHistory(0);
  tick(history, controlWith(NEUTRAL, { held: { strike: true } }), 0);
  history.settle(false, 0);
  tick(history, controlWith(NEUTRAL, { held: { grab: true } }), 1);
  // Tick 2 still owes the strike press; the grab arrives behind it in the queue.
  assert.equal(history.pendingPresses, 2);

  tick(history, NEUTRAL, 2);
  history.settle(true, 2);
  assert.equal(
    history.pendingPresses,
    0,
    'a landed press must not still have an earlier mash waiting behind it',
  );
});

test('buffered presses keep the stance they were made with', () => {
  const history = new InputHistory(0);
  // Press "up-strike", then let go of the stick while the press waits.
  tick(history, controlWith(NEUTRAL, { moveZ: -1, held: { strike: true } }), 0);
  history.settle(false, 0);
  const later = tick(history, NEUTRAL, 1);
  assert.equal(later.attack, CHAIN_PRESS);
  assert.equal(later.stance, 'up', 'the press was made holding up');
});

test('movement and guard are levels, not presses', () => {
  const history = new InputHistory(0);
  const walking = controlWith(NEUTRAL, { moveX: 1, held: { guardHigh: true, guardLow: true } });
  for (let t = 0; t < 5; t += 1) {
    const input = tick(history, walking, t);
    assert.equal(input.moveX, 1, 'held movement is not buffered away');
    assert.equal(input.attack, null);
    assert.equal(input.dodge, 'none');
    assert.equal(input.guard, 'low', 'the sweep guard wins when both guards are held');
  }
  assert.equal(tick(history, NEUTRAL, 5).guard, 'none');
});

test('dodge presses are edge-detected and resolve to a direction', () => {
  const history = new InputHistory(0);
  const low = controlWith(NEUTRAL, { moveZ: 1, held: { dodgeLow: true } });
  const input = tick(history, low, 0);
  assert.equal(input.dodge, 'low');
  assert.equal(input.attack, null);
  history.settle(true, 0);
  assert.equal(tick(history, low, 1).dodge, 'none', 'a held dodge does not re-fire');
});

test('frameInput is idempotent within a tick and re-drivable for a rollback', () => {
  const history = new InputHistory(0);
  history.record(controlWith(NEUTRAL, { held: { strike: true } }), 7);
  const a = history.frameInput(7);
  const b = history.frameInput(7);
  assert.equal(a, b, 'the same tick yields the same input object');

  // A snapshot restore re-simulates tick 7 from tick 6: identical history, identical input.
  const replayed = new InputHistory(0);
  replayed.record(NEUTRAL, 6);
  replayed.record(controlWith(NEUTRAL, { held: { strike: true } }), 7);
  assert.deepEqual(replayed.frameInput(7), a);
});

test('input history is per-slot and defaults to an eight-tick window', () => {
  assert.equal(INPUT_BUFFER_TICKS, 8);
  assert.equal(new InputHistory(0).capacity, 8);
  assert.throws(() => new InputHistory(0, { bufferTicks: 0 }), RangeError);
});

// -------------------------------------------------------------------------------------------
// The whole stack, against the real simulation
// -------------------------------------------------------------------------------------------

test('a device press drives the real simulation, and every token it can emit is legal', () => {
  const runner = new MatchRunner(engagementSpawns());
  const history = new InputHistory(0);

  // Walk in, then throw a chain opener, exactly as a keyboard player would.
  let moved = false;
  for (let t = 1; t <= 12; t += 1) {
    const input = tick(history, controlWith(NEUTRAL, { moveX: 1 }), t);
    const fighter = runner.fighterAt(0);
    if (fighter.x !== 0) moved = true;
    runner.fixedUpdate(1 / 60, [input, NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT]);
    history.settle(t, [fighter.currentMove !== null && fighter.movePhaseFrame === 1, false, false, false]);
  }
  assert.ok(moved, 'the fighter actually walked');

  const strike = tick(history, controlWith(NEUTRAL, { held: { strike: true } }), 13);
  assert.equal(strike.attack, CHAIN_PRESS);
  runner.fixedUpdate(1 / 60, [strike, NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT]);
  const fighter = runner.fighterAt(0);
  assert.notEqual(fighter.currentMove, null, 'the chain opener started a real move');
  assert.equal(fighter.state, 'startup');

  // Every token the input layer can emit is either a stance, CHAIN_PRESS, a charge entry or a real
  // move id. Anything else makes `MatchRunner.handleAttack` throw mid-match, which is why this is
  // asserted over the whole action set rather than for the one move above.
  const { MOVESET } = sim;
  const known = new Set(MOVESET.map((m) => m.id));
  const chargeEntries = new Set(
    sim.ARCHETYPES.map((a) => a.charge?.chainEntry).filter((id) => typeof id === 'string'),
  );
  for (const action of INPUT_ACTIONS) {
    for (const stance of ['neutral', 'up', 'down', 'side']) {
      for (const guarding of [false, true]) {
        const token = attackTokenFor(action, { stance, guarding });
        if (token === null) continue;
        const legal =
          token === CHAIN_PRESS || known.has(token) || chargeEntries.has(token) || sim.isStance(token);
        assert.ok(legal, `action ${action} produced an illegal attack token: ${token}`);
      }
    }
  }
});

// -------------------------------------------------------------------------------------------
// Architecture gate
// -------------------------------------------------------------------------------------------

test('the input layer never reaches for the DOM, a wall clock or randomness', async () => {
  const raw = await sourceFor('input-arch', INPUT_ENTRY);
  // Comments are stripped by the bundler only when it chooses to; a `/** ... */` rationale block
  // survives into the output, and a doc comment that happens to say "window blur" is not a DOM
  // dependency. Strip comments before scanning, so the gate reads code (AGENTS.md §2 asks for the
  // documentation to stay, so the scan cannot demand its absence).
  const code = stripComments(raw);
  const banned = [
    'document',
    'window',
    'Math.random',
    'Date.now',
    'performance.now',
    'addEventListener',
    'localStorage',
  ];
  for (const needle of banned) {
    assert.ok(!code.includes(needle), `src/input/* must not reference ${needle}`);
  }

  // And the whole graph imports cleanly with no browser globals defined at all.
  const sources = await buildSources();
  assert.ok(sources.sim.length > 0);
});

/** Remove block and line comments so an architecture scan sees code, not prose. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}