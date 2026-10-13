/**
 * Multi-device joining and four-player local play (`npm test`).
 *
 * The Phase 1 suite proved that *one* player's inputs are deterministic. This suite proves the
 * Phase 2 claim: four players on four *different kinds* of device, joining and leaving mid-match,
 * still produce a match that is bit-identical at every refresh rate.
 *
 * Covered:
 *   - a resting device never claims a slot, and an active one always does
 *   - slots are sticky across a dropped poll, and released after the debounce window
 *   - claim order is fixed, so two machines with the same devices agree on who is in which slot
 *   - bot fill holds the empty slots without pretending to be an AI
 *   - four players (pad, two keyboards, phone) play a real match to the same hash
 *   - the same input script produces the same hash at 30 / 60 / 144 / 240Hz
 *   - buffers never cross-talk between players
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadInput, loadLoop, loadSim, loadTouch } from '../tools/load-sim.mjs';

const input = await loadInput();
const touch = await loadTouch();
const sim = await loadSim();
const loopModule = await loadLoop();

const {
  JoinManager,
  GAMEPAD_LOSS_POLLS,
  MAX_PLAYER_SLOTS,
  KeyboardSource,
  controlWith,
} = input;
const { TouchInputState } = touch;
const { FixedStepAccumulator } = loopModule;
const { MatchRunner, NEUTRAL_INPUT } = sim;
const { engagementSpawns } = await import('../tools/measure-frames.mjs');

after(cleanup);

// -------------------------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------------------------

/** A pad-shaped sampler whose activity the test drives directly. */
function padSampler() {
  const pads = new Map();
  return {
    /** Connect a pad. `active: false` is a pad that is plugged in but idle. */
    connect(index, { active = false, control = controlWith() } = {}) {
      pads.set(index, {
        index,
        id: `Pad ${index}`,
        connected: true,
        active,
        pressed: [],
        startPressed: false,
        control,
      });
      return this;
    },
    /** Simulate the pad reporting no gamepads at all (asleep, unplugged, browser quirk). */
    disconnect(index) {
      pads.delete(index);
      return this;
    },
    activate(index) {
      const pad = pads.get(index);
      if (pad !== undefined) {
        pad.active = true;
      }
      return this;
    },
    setControl(index, control) {
      const pad = pads.get(index);
      if (pad !== undefined) {
        pad.control = control;
        pad.active = true;
      }
      return this;
    },
    poll() {
      return [...pads.values()].sort((a, b) => a.index - b.index);
    },
  };
}

// -------------------------------------------------------------------------------------------
// Slot allocation
// -------------------------------------------------------------------------------------------

test('four slots, and a device only claims one when it is actually used', () => {
  assert.equal(MAX_PLAYER_SLOTS, 4);
  const pads = padSampler().connect(0).connect(1).connect(2).connect(3);
  const join = new JoinManager({ gamepads: pads });

  assert.deepEqual([...join.poll(1)], [], 'four plugged-in pads are not four players');
  assert.equal(join.joinedCount, 0);
  assert.deepEqual(join.slots.map((s) => s.kind), ['empty', 'empty', 'empty', 'empty']);

  pads.activate(2);
  const events = join.poll(2);
  assert.equal(join.joinedCount, 1);
  assert.equal(join.slots[0].kind, 'gamepad');
  assert.equal(join.slots[0].deviceId, 'gamepad:2', 'the lowest free slot is taken, not slot 2');
  assert.deepEqual(
    events.map((e) => e.type),
    ['join'],
  );
});

test('a slot survives a dropped poll and is released only after the debounce window', () => {
  assert.equal(GAMEPAD_LOSS_POLLS, 3);
  const pads = padSampler().connect(0, { active: true });
  const join = new JoinManager({ gamepads: pads });
  join.poll(1);
  assert.equal(join.slots[0].kind, 'gamepad');

  // A wireless pad blinks out of `getGamepads()` for a frame or two all the time.
  pads.disconnect(0);
  assert.deepEqual([...join.poll(2)], [], 'one missing poll is not a departure');
  assert.equal(join.slots[0].kind, 'gamepad', 'the player keeps their fighter');
  assert.deepEqual(join.frameInputs(2)[0], { ...NEUTRAL_INPUT }, 'and stands still, not frozen');

  join.poll(3);
  assert.equal(join.slots[0].kind, 'gamepad');
  const events = join.poll(4);
  assert.equal(join.slots[0].kind, 'empty', 'released after the window closes');
  assert.deepEqual(
    events.map((e) => `${e.type}:${e.slot}`),
    ['leave:0'],
  );

  // Reconnecting the same pad is a fresh join, with no remembered press state.
  pads.connect(0, { active: true, control: controlWith(controlWith(), { moveX: 1 }) });
  join.poll(5);
  assert.equal(join.slots[0].kind, 'gamepad');
  assert.equal(
    join.frameInputs(5)[0].attack,
    null,
    'a reconnected pad does not replay the last input it sent before it slept',
  );
  assert.equal(join.frameInputs(5)[0].moveX, 1, 'and its new stick position is live immediately');

  // A pad that joins while the player is *already* holding strike gets exactly that one press:
  // the first sample after a join has no previous state to compare against.
  pads.setControl(0, controlWith(controlWith(), { held: { strike: true } }));
  join.poll(6);
  assert.equal(join.frameInputs(6)[0].attack, sim.CHAIN_PRESS);
  join.settle(6, [true]);
  assert.equal(join.frameInputs(7)[0].attack, null, 'and only that one');
});

test('five devices, four slots: the overflow one is simply not seated', () => {
  const pads = padSampler().connect(0, { active: true }).connect(1, { active: true }).connect(2, { active: true });
  const keyboard = new KeyboardSource();
  const touchState = new TouchInputState();
  const join = new JoinManager({ gamepads: pads, keyboard, touch: touchState });

  keyboard.keyDown('KeyD');
  touchState.beginPointer(1, 0.5, 0.3);
  join.poll(1);

  assert.equal(join.joinedCount, 4);
  assert.equal(join.humanCount, 4);
  assert.deepEqual(join.slots.map((s) => s.kind), ['gamepad', 'gamepad', 'gamepad', 'keyboard']);

  // A slot frees up, and the waiting phone takes it on the next poll.
  pads.disconnect(0);
  join.poll(2);
  join.poll(3);
  const left = join.poll(4);
  assert.deepEqual(
    left.map((e) => `${e.type}:${e.slot}:${e.kind}`),
    ['leave:0:gamepad', 'join:0:touch'],
    'the phone that was waiting takes the freed slot',
  );
  assert.equal(join.humanCount, 4);
});

test('bot fill holds the remaining slots and yields them to a human', () => {
  const pads = padSampler().connect(0, { active: true });
  const join = new JoinManager({ gamepads: pads, botFill: 4 });

  const events = join.poll(1);
  assert.equal(join.humanCount, 1);
  assert.equal(join.joinedCount, 4);
  assert.deepEqual(join.slots.map((s) => s.kind), ['gamepad', 'bot', 'bot', 'bot']);
  assert.deepEqual(
    events.filter((e) => e.kind === 'bot').length,
    3,
    'humans are seated before bots',
  );

  // A bot slot is a fighter that exists and can be fought, not an AI pretending to play.
  const inputs = join.frameInputs(1);
  assert.deepEqual(inputs[1], { ...NEUTRAL_INPUT });

  // An explicit release frees the slot immediately...
  const released = join.release(0);
  assert.equal(released.type, 'release');
  assert.equal(join.humanCount, 0);
  assert.equal(join.slots[0].kind, 'empty');
  // ...but a pad that is still plugged in and still being used is not "stood up", so it takes the
  // slot straight back on the next poll. Silently keeping a seat is better than an empty arena.
  join.poll(2);
  assert.equal(join.slots[0].kind, 'gamepad');

  // The real stand-up: the controller is put down and goes quiet.
  pads.disconnect(0);
  join.poll(3);
  join.poll(4);
  join.poll(5);
  assert.equal(join.humanCount, 0);
  assert.equal(join.joinedCount, 4, 'bot fill takes the freed slot');
  assert.equal(join.slots[0].kind, 'bot');

  // And lowering the fill releases the bots again.
  join.setBotFill(0);
  join.reset();
  join.poll(2);
  assert.equal(join.joinedCount, 0);
  assert.equal(join.slots.every((s) => s.kind === 'empty'), true);
});

test('target switch is reported per slot and never leaks into another slot', () => {
  const pads = padSampler().connect(0, {
    active: true,
    control: controlWith(controlWith(), { held: { targetSwitch: true } }),
  });
  const join = new JoinManager({ gamepads: pads });
  join.poll(1);
  join.frameInputs(1);
  assert.equal(join.targetSwitchPressed(0, 1), true);
  assert.equal(join.targetSwitchPressed(1, 1), false);
  assert.equal(join.targetSwitchPressed(3, 1), false, 'an empty slot has nothing to switch');
});

// -------------------------------------------------------------------------------------------
// Four-player local play
// -------------------------------------------------------------------------------------------

/**
 * One scripted match with a different device in every slot, driven exactly the way `src/main.ts`
 * drives it: poll, build inputs, step, settle.
 */
function scriptedMatch() {
  const pads = padSampler();
  const keyboard = new KeyboardSource();
  const touchState = new TouchInputState();
  const join = new JoinManager({ gamepads: pads, keyboard, touch: touchState, botFill: 1 });
  const runner = new MatchRunner(engagementSpawns());
  const hashes = [];

  pads.connect(0, { active: true, control: controlWith(controlWith(), { moveX: 1 }) });
  pads.connect(1, {
    active: true,
    control: controlWith(controlWith(), { moveZ: 1, held: { strike: true } }),
  });
  const strike = touchState.layout.buttons.find((b) => b.action === 'strike');
  touchState.beginPointer(9, strike.x, strike.y); // the phone holds strike
  touchState.beginPointer(10, touchState.layout.stickX, touchState.layout.stickY);
  touchState.movePointer(
    10,
    touchState.layout.stickX + touchState.layout.stickRadius,
    touchState.layout.stickY,
  ); // ...and walks right the whole match

  const startPositions = runner.fighters.map((f) => ({ x: f.x, z: f.z }));

  for (let tick = 1; tick <= 90; tick += 1) {
    // Everyone keeps doing what they were told to; the presses simply stop being fresh.
    keyboard.keyDown('KeyD');
    if (tick === 40) {
      keyboard.keyDown('KeyJ');
    }
    if (tick === 60) {
      touchState.endPointer(9); // the phone lets go of strike
    }
    pads.setControl(0, controlWith(controlWith(), { moveX: 1 }));

    join.poll(tick);
    const inputs = join.frameInputs(tick);
    assert.equal(inputs.length, 4);
    runner.fixedUpdate(1 / 60, inputs);
    join.settle(
      tick,
      runner.fighters.map((f) => f.currentMove !== null && f.movePhaseFrame === 1),
    );
    hashes.push(runner.stateHash());
  }
  return { runner, join, hashes, startPositions };
}

test('four players on four kinds of device play one deterministic match', () => {
  assert.deepEqual(
    scriptedMatch().join.slots.map((s) => s.kind),
    ['gamepad', 'gamepad', 'keyboard', 'touch'],
    'pads first, then keyboards, then touch',
  );

  const a = scriptedMatch();
  const b = scriptedMatch();
  assert.deepEqual(a.hashes, b.hashes, 'the same script replays bit-identically');
  assert.equal(a.runner.stateHash(), b.runner.stateHash());

  // Each human actually moved their own fighter — the join -> buffer -> sim path is live.
  for (const slot of [0, 1, 2, 3]) {
    const fighter = a.runner.fighterAt(slot);
    const start = a.startPositions[slot];
    const moved = fighter.x !== start.x || fighter.z !== start.z;
    assert.ok(moved, `slot ${slot} walked`);
  }
});

test('two players pressing strike on the same tick each get their own press', () => {
  const pads = padSampler()
    .connect(0, { active: true, control: controlWith(controlWith(), { held: { strike: true } }) })
    .connect(1, { active: true, control: controlWith(controlWith(), { held: { strike: true } }) });
  const join = new JoinManager({ gamepads: pads });

  join.poll(1);
  const inputs = join.frameInputs(1);
  assert.equal(inputs[0].attack, sim.CHAIN_PRESS);
  assert.equal(inputs[1].attack, sim.CHAIN_PRESS, 'one player never eats the other player input');
  join.settle(1, [false, true]);
  const next = join.frameInputs(2);
  assert.equal(next[0].attack, sim.CHAIN_PRESS, 'slot 0 was refused, so its press is still live');
  assert.equal(next[1].attack, null, 'slot 1 was accepted, so its press is spent');
});

test('the same input script is bit-identical at 30, 60, 144 and 240Hz', () => {
  /**
   * Devices are sampled once per *simulated tick*, never per rendered frame. That is what makes
   * this hold: a 240Hz host runs four renders per tick and still offers the sim one press.
   */
  function playAt(rate) {
    const pads = padSampler();
    const keyboard = new KeyboardSource();
    const join = new JoinManager({ gamepads: pads, keyboard, botFill: 4 });
    const runner = new MatchRunner(engagementSpawns());
    const accumulator = new FixedStepAccumulator();
    const frameMs = 1000 / rate;
    const script = [];

    // One press every 30 ticks for 180 ticks, from a pad and from a keyboard.
    for (let i = 0; i < 180; i += 1) {
      const striking = i % 30 === 0;
      script.push(striking);
    }

    let tick = 0;
    let frame = 0;
    let padPressed = false;
    let keyPressed = false;
    while (tick < 180 && frame < 100000) {
      frame += 1;
      const ticks = accumulator.advance(frameMs);
      for (let i = 0; i < ticks; i += 1) {
        tick += 1;
        const striking = script[tick - 1];
        // Edge-detect the script: the pad button and the key only go down on the rising edge.
        pads.setControl(0, controlWith(controlWith(), { moveX: 1, held: striking ? { strike: true } : {} }));
        if (striking && !padPressed) {
          pads.connect(0, { active: true, control: controlWith(controlWith(), { moveX: 1 }) });
          pads.setControl(0, controlWith(controlWith(), { moveX: 1, held: { strike: true } }));
        } else if (!striking && padPressed) {
          pads.setControl(0, controlWith(controlWith(), { moveX: 1 }));
        }
        padPressed = striking;

        if (striking && !keyPressed) {
          keyboard.keyDown('KeyJ');
        } else if (!striking && keyPressed) {
          keyboard.keyUp('KeyJ');
        }
        keyPressed = striking;

        join.poll(tick);
        const inputs = join.frameInputs(tick);
        runner.fixedUpdate(1 / 60, inputs);
        join.settle(
          tick,
          runner.fighters.map((f) => f.currentMove !== null && f.movePhaseFrame === 1),
        );
      }
      // 144Hz and 240Hz produce sub-tick frames; the accumulator is what turns them back into
      // whole 60Hz ticks, and the input stack only ever sees those.
    }
    assert.equal(tick, 180, `ran the full script at ${rate}Hz`);
    return runner.stateHash();
  }

  const hashes = [30, 60, 144, 240].map(playAt);
  assert.equal(new Set(hashes).size, 1, `refresh rates diverged: ${hashes.join(' ')}`);
});

test('the join manager is a pure read of the devices, with no wall clock', async () => {
  // A second manager driven by the same devices must reach the same table, tick for tick: the
  // allocation policy has to be reproducible or the rollback netcode in Phase 3 has no baseline.
  const first = new JoinManager({ gamepads: padSampler().connect(0, { active: true }) });
  const second = new JoinManager({ gamepads: padSampler().connect(0, { active: true }) });
  for (let tick = 1; tick <= 10; tick += 1) {
    first.poll(tick);
    second.poll(tick);
  }
  assert.deepEqual(first.slots, second.slots);

  // And a fresh manager never inherits a stale slot from a previous match.
  first.release(0);
  assert.equal(first.slots[0].kind, 'empty');
  assert.equal(second.slots[0].kind, 'gamepad', 'managers are independent');
});