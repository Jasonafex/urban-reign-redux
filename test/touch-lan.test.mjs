/**
 * Touch input and house-LAN joining (`npm test`).
 *
 * AGENTS.md §3.3 asks for "on-screen virtual touch arcade controls for mobile devices" so that a
 * phone anywhere in the house can open the arena and join. This suite covers both halves of that:
 *
 *   - `TouchInputState` is *pure*, so a whole two-thumb session is driven here in Node — pointer
 *     ownership, the deadzone, the digital snap, button geometry — with no browser in sight.
 *   - `TouchController` is *presentation*, and is proven harmless without a document rather than
 *     merely unexercised.
 *   - the join path end to end: a phone touching the screen claims a slot, keeps it, and drives its
 *     own fighter in a real `MatchRunner` without disturbing anyone else's.
 *
 * The LAN transport itself is Vite's (`vite.config.ts` sets `server.host`), not this engine's, so
 * what is gated here is everything the phone needs to *play* once it has loaded the page.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadInput, loadSim, loadTouch } from '../tools/load-sim.mjs';

const touch = await loadTouch();
const input = await loadInput();
const sim = await loadSim();

const { TouchInputState, TouchController, PHONE_TOUCH_LAYOUT } = touch;
const { InputHistory, KeyboardSource, JoinManager, controlWith } = input;
const { MatchRunner, NEUTRAL_INPUT } = sim;
const { engagementSpawns } = await import('../tools/measure-frames.mjs');

after(cleanup);

/** Centre of a layout button, for placing a synthetic finger exactly on it. */
function onButton(action) {
  const button = PHONE_TOUCH_LAYOUT.buttons.find((b) => b.action === action);
  assert.ok(button, `layout has a ${action} button`);
  return { x: button.x, y: button.y };
}

// -------------------------------------------------------------------------------------------
// Headless safety
// -------------------------------------------------------------------------------------------

test('the touch module is safe to import and construct with no document at all', () => {
  assert.equal(typeof document, 'undefined', 'this suite runs with no DOM');

  const state = new TouchInputState();
  assert.equal(state.active, false);
  assert.deepEqual(state.control().held.strike, false);

  const controller = new TouchController({ state });
  // Construction must not touch the DOM; attach must report it did nothing rather than throw.
  assert.equal(controller.attach(), false);
  assert.equal(controller.mounted, false);
  controller.setVisible(true); // no-op without a root
  controller.paint(); // no-op without a root
  controller.detach(); // must be safe when never attached

  assert.equal(typeof TouchInputState.isTouchDevice(), 'boolean');
});

// -------------------------------------------------------------------------------------------
// Multi-touch pointer tracking
// -------------------------------------------------------------------------------------------

test('a finger on a button and a finger on the stick are tracked independently', () => {
  const state = new TouchInputState();
  state.beginPointer(1, PHONE_TOUCH_LAYOUT.stickX, PHONE_TOUCH_LAYOUT.stickY);
  state.beginPointer(2, onButton('strike').x, onButton('strike').y);

  assert.equal(state.pointerCount, 2);
  assert.equal(state.stickPointerId, 1);
  assert.equal(state.points.find((p) => p.id === 2).action, 'strike');
  assert.equal(state.active, true);

  state.movePointer(1, PHONE_TOUCH_LAYOUT.stickX + PHONE_TOUCH_LAYOUT.stickRadius, PHONE_TOUCH_LAYOUT.stickY);
  const control = state.control();
  assert.equal(control.moveX, 1, 'full right');
  assert.equal(control.moveZ, 0);
  assert.equal(control.held.strike, true, 'the thumb on STRIKE keeps striking while walking');
});

test('a button press belongs to the finger that made it, not to where the finger is', () => {
  const state = new TouchInputState();
  const strike = onButton('strike');
  state.beginPointer(7, strike.x, strike.y);
  // Roll the thumb across SPA without lifting: this must NOT fire the special.
  state.movePointer(7, onButton('special').x, onButton('special').y);

  const control = state.control();
  assert.equal(control.held.strike, true, 'still striking');
  assert.equal(control.held.special, false, 'a thumb roll is not a special press');

  state.endPointer(7);
  assert.equal(state.control().held.strike, false);
  assert.equal(state.active, false);
});

test('a second finger with no button under it cannot steal the stick', () => {
  const state = new TouchInputState();
  state.beginPointer(1, 0.5, 0.2); // no button there — takes the stick
  state.beginPointer(2, 0.5, 0.35); // still no button, stick already taken
  assert.equal(state.pointerCount, 1);
  assert.equal(state.points[0].id, 1);

  // A duplicate pointer id is a browser bug, not a re-press.
  state.beginPointer(1, 0.1, 0.9);
  assert.equal(state.pointerCount, 1);
  assert.deepEqual(state.stickOrigin, { x: 0.5, y: 0.2 }, 'the stick did not teleport');
});

test('releasing everything re-centres the stick and releases every button', () => {
  const state = new TouchInputState();
  state.beginPointer(1, 0.2, 0.7);
  state.movePointer(1, 0.32, 0.7);
  state.beginPointer(2, onButton('guardHigh').x, onButton('guardHigh').y);
  assert.equal(state.control().moveX, 1);

  state.releaseAll();
  const control = state.control();
  assert.equal(control.moveX, 0);
  assert.equal(control.moveZ, 0);
  assert.equal(control.held.guardHigh, false);
  assert.equal(state.pointerCount, 0);
});

// -------------------------------------------------------------------------------------------
// Deadzone
// -------------------------------------------------------------------------------------------

test('the virtual stick deadzones a resting thumb and reads full deflection', () => {
  const layout = PHONE_TOUCH_LAYOUT;
  const state = new TouchInputState();
  state.beginPointer(1, layout.stickX, layout.stickY);

  // Below the gate (0.18 of the travel radius) — a thumb resting on glass.
  state.movePointer(1, layout.stickX + layout.stickRadius * 0.1, layout.stickY);
  assert.deepEqual(
    { x: state.control().moveX, z: state.control().moveZ },
    { x: 0, z: 0 },
    'a resting thumb does not walk the fighter',
  );

  // Just past the gate reads as a direction: the stick is digital, not analog.
  state.movePointer(1, layout.stickX + layout.stickRadius * 0.3, layout.stickY);
  assert.equal(state.control().moveX, 1);

  // Travel beyond the radius saturates rather than running away.
  state.movePointer(1, layout.stickX + layout.stickRadius * 4, layout.stickY);
  assert.equal(state.control().moveX, 1);

  // Diagonals survive the gate on both axes.
  state.movePointer(1, layout.stickX + layout.stickRadius, layout.stickY + layout.stickRadius);
  assert.deepEqual(
    { x: state.control().moveX, z: state.control().moveZ },
    { x: 1, z: 1 },
  );
});

test('guard on a phone resolves high or low from the stick, like a pad', () => {
  const layout = PHONE_TOUCH_LAYOUT;
  const state = new TouchInputState();
  state.beginPointer(1, onButton('guardHigh').x, onButton('guardHigh').y);
  assert.equal(state.control().held.guardHigh, true);
  assert.equal(state.control().held.guardLow, false, 'guard alone is the high guard');

  state.beginPointer(2, layout.stickX, layout.stickY);
  state.movePointer(2, layout.stickX, layout.stickY + layout.stickRadius);
  const control = state.control();
  assert.equal(control.moveZ, 1, 'pushing down');
  assert.equal(control.held.guardLow, true, 'down + guard is the sweep guard');
  assert.equal(control.held.guardHigh, true);
});

// -------------------------------------------------------------------------------------------
// Button geometry
// -------------------------------------------------------------------------------------------

test('no two touch buttons overlap, and all of them fit on the screen', () => {
  const { buttons, stickX, stickY, stickRadius } = PHONE_TOUCH_LAYOUT;
  assert.ok(buttons.length >= 6, 'the phone gets every action a pad has');

  for (const button of buttons) {
    assert.ok(
      button.x - button.radius >= 0 && button.x + button.radius <= 1,
      `${button.action} fits horizontally`,
    );
    assert.ok(
      button.y - button.radius >= 0 && button.y + button.radius <= 1,
      `${button.action} fits vertically`,
    );
    // A thumb that lands on the stick's resting circle would start walking *and* pressing.
    const gap = Math.hypot(button.x - stickX, button.y - stickY) - (button.radius + stickRadius);
    assert.ok(gap > 0, `${button.action} is clear of the stick`);
  }

  for (let i = 0; i < buttons.length; i += 1) {
    for (let j = i + 1; j < buttons.length; j += 1) {
      const a = buttons[i];
      const b = buttons[j];
      const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.radius + b.radius);
      assert.ok(gap > 0, `${a.action} and ${b.action} must not overlap (gap ${gap.toFixed(3)})`);
    }
  }
});

// -------------------------------------------------------------------------------------------
// Touch into the input buffer into the simulation
// -------------------------------------------------------------------------------------------

test('a thumb tap becomes the same FrameInput a keyboard press would', () => {
  const state = new TouchInputState();
  const history = new InputHistory(0);

  state.beginPointer(1, onButton('strike').x, onButton('strike').y);
  history.record(state.control(), 0);
  const strike = history.frameInput(0);
  assert.equal(strike.attack, sim.CHAIN_PRESS);
  history.settle(true, 0);
  state.endPointer(1);

  // SPA held behind a guard is the crowd-clear escape, on a phone exactly as on a pad.
  state.beginPointer(1, onButton('guardHigh').x, onButton('guardHigh').y);
  state.beginPointer(2, onButton('special').x, onButton('special').y);
  history.record(state.control(), 1);
  const special = history.frameInput(1);
  assert.equal(special.attack, 'spa2');
  assert.equal(special.guard, 'high');
  history.settle(true, 1);

  state.releaseAll();
  history.record(state.control(), 2);
  const idle = history.frameInput(2);
  assert.equal(idle.attack, null, 'lifting every finger stops attacking');
  assert.equal(idle.guard, 'none');
});

// -------------------------------------------------------------------------------------------
// Joining over the house LAN
// -------------------------------------------------------------------------------------------

test('a phone claims a slot on first touch and keeps it', () => {
  const touchState = new TouchInputState();
  const keyboard = new KeyboardSource();
  const join = new JoinManager({ keyboard, touch: touchState });

  assert.deepEqual([...join.poll(1)], [], 'an untouched screen is not a player');
  assert.equal(join.joinedCount, 0);

  keyboard.keyDown('KeyD'); // someone sits down at the keyboard first
  touchState.beginPointer(1, 0.5, 0.3); // ...then a phone joins over the LAN
  const events = join.poll(2);

  assert.equal(join.humanCount, 2);
  assert.equal(join.slots[0].kind, 'keyboard');
  assert.equal(join.slots[1].kind, 'touch');
  assert.deepEqual(
    events.map((e) => `${e.type}:${e.slot}`),
    ['join:0', 'join:1'],
  );

  // The phone keeps its slot while it stays in contact, and a second finger does not take another.
  touchState.beginPointer(2, 0.6, 0.4);
  assert.deepEqual([...join.poll(3)], []);
  assert.equal(join.slots[1].kind, 'touch');
  assert.equal(join.slots[1].deviceId, 'touch:0');
});

test('a touch player drives its own fighter in a real match, deterministically', () => {
  function playMatch() {
    const touchState = new TouchInputState();
    const join = new JoinManager({ touch: touchState });
    const runner = new MatchRunner(engagementSpawns());
    const layout = PHONE_TOUCH_LAYOUT;
    const hashes = [];

    // Tick 1: the phone arrives (thumb on the screen).
    touchState.beginPointer(1, layout.stickX, layout.stickY);
    join.poll(1);
    // Ticks 2..30: walk right, then throw the chain opener.
    for (let tick = 2; tick <= 30; tick += 1) {
      touchState.movePointer(1, layout.stickX + layout.stickRadius, layout.stickY);
      if (tick === 20) {
        touchState.beginPointer(2, onButton('strike').x, onButton('strike').y);
      }
      if (tick === 24) {
        touchState.endPointer(2);
      }
      join.poll(tick);
      const inputs = join.frameInputs(tick);
      assert.equal(inputs.length, 4, 'four slots, always');
      runner.fixedUpdate(1 / 60, inputs);
      const fighter = runner.fighterAt(1);
      join.settle(
        tick,
        runner.fighters.map((f) => f.currentMove !== null && f.movePhaseFrame === 1),
      );
      hashes.push(runner.stateHash());
      void fighter;
    }
    return { runner, hashes };
  }

  const a = playMatch();
  const b = playMatch();
  assert.deepEqual(a.hashes, b.hashes, 'the same touches produce the same match');
  assert.equal(a.runner.stateHash(), b.runner.stateHash());

  const phone = a.runner.fighterAt(1);
  assert.ok(phone.x !== 0, 'the phone walked its fighter');
});

test('touch joins coexist with a keyboard and a pad, and each slot is independent', () => {
  const touchState = new TouchInputState();
  const keyboard = new KeyboardSource();
  // A pad-shaped sampler: one connected pad that is being used.
  const pad = {
    index: 0,
    id: 'House Pad',
    connected: true,
    pressed: ['strike'],
    startPressed: false,
    active: true,
    control: controlWith(controlWith(), { moveZ: -1, held: { strike: true } }),
  };
  const join = new JoinManager({
    gamepads: { poll: () => [pad] },
    keyboard,
    touch: touchState,
  });

  keyboard.keyDown('ArrowLeft');
  touchState.beginPointer(1, 0.5, 0.3);
  join.poll(1);

  assert.equal(join.humanCount, 3, 'pad, keyboard and phone are all seated');
  assert.deepEqual(
    join.slots.map((s) => s.kind),
    ['gamepad', 'keyboard', 'touch', 'empty'],
    'claim order is pads, then keyboards, then touch — the same order on every machine',
  );
  assert.equal(join.slots[3].kind, 'empty');

  // Each device only ever moves its own fighter.
  const inputs = join.frameInputs(1);
  assert.equal(inputs[0].moveZ, -1, 'the pad is walking up');
  assert.equal(inputs[1].moveX, -1, 'P2 is walking left');
  assert.equal(inputs[2].attack, null, 'the phone has not pressed anything yet');
  assert.deepEqual(inputs[3], { ...NEUTRAL_INPUT }, 'the empty slot is neutral');
});

test('the target-lock button is surfaced without being smuggled into FrameInput', () => {
  const touchState = new TouchInputState();
  const join = new JoinManager({ touch: touchState });

  touchState.beginPointer(1, onButton('targetSwitch').x, onButton('targetSwitch').y);
  join.poll(1);
  const inputs = join.frameInputs(1);

  assert.equal(join.targetSwitchPressed(0, 1), true, 'the press is a readable HUD event');
  // The simulation has no manual target-switch input, so it must not appear as an attack: an
  // invented `FrameInput` field would be silently ignored by `applyInputs` and read as a bug later.
  assert.equal(inputs[0].attack, null);
  assert.equal(inputs[0].dodge, 'none');

  touchState.endPointer(1);
  join.poll(2);
  join.frameInputs(2);
  assert.equal(join.targetSwitchPressed(0, 2), true, 'still within the 8-tick press window');
  for (let tick = 3; tick <= 12; tick += 1) {
    join.poll(tick);
    join.frameInputs(tick);
  }
  assert.equal(join.targetSwitchPressed(0, 12), false, 'and gone once the window closes');
});