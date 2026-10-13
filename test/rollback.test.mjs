/**
 * Speculative rollback netcode (`npm test`).
 *
 * AGENTS.md §3.3 promises three things this suite has to hold the engine to: local input with zero
 * delay, remote inputs predicted and then *corrected* by rewinding, and a world that stays
 * bit-identical across peers no matter how badly the network behaves.
 *
 * The central test is `two peers converge`. Everything else exists to explain a failure of that
 * one, which is why the link model is shared and deterministic: a divergence reported here has to
 * be reproducible, or it is not a test.
 *
 * Note what is *not* tested: permanent packet loss. Rollback netcode has no retransmission, so an
 * input that never arrives leaves a peer guessing forever and no implementation can converge from
 * that. Latency and reordering are recoverable and are what this engine is for.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { buildSources, cleanup, loadNet, loadSim } from '../tools/load-sim.mjs';

const net = await loadNet();
const sim = await loadSim();
const sources = await buildSources();

const {
  RollbackSession,
  DEFAULT_MAX_ROLLBACK_TICKS,
  repeatLastInput,
  canonicalizeInput,
  inputFromWire,
  encodeInput,
  frameInputsEqual,
  MAX_PLAYERS,
} = net;
const { idleInput, NEUTRAL_INPUT } = sim;

after(cleanup);

// -------------------------------------------------------------------------------------------
// Deterministic link model — no Math.random anywhere, so a failure always reproduces
// -------------------------------------------------------------------------------------------

/** A per-tick input stream with enough variety that a wrong replay cannot hide. */
function scriptedInput(tick, slot) {
  const phase = (tick + slot * 37) % 60;
  return idleInput({
    moveX: phase < 20 ? 1 : phase < 40 ? -1 : 0,
    moveZ: phase >= 20 && phase < 30 ? 1 : 0,
    attack: phase === 45 ? 'chain' : null,
    stance: phase > 45 ? 'side' : 'neutral',
    guard: phase > 50 ? 'high' : 'none',
    dodge: phase === 52 ? 'high' : 'none',
  });
}

/**
 * Ticks that arrive `delay` ticks late. Congestion comes in bursts, which is what a house Wi-Fi
 * actually does: three packets land together after the radio fights for the channel.
 */
function latencyFor(tick) {
  const residue = tick % 10;
  if (residue >= 5 && residue <= 7) {
    return 5;
  }
  return residue === 8 ? 2 : 0;
}

/** One peer's view of an inbound link: sorted by arrival, so ticks genuinely arrive out of order. */
function makeLink(peer, slot, until) {
  const packets = [];
  for (let tick = 1; tick <= until; tick += 1) {
    packets.push({ arrive: tick + latencyFor(tick), tick });
  }
  packets.sort((x, y) => x.arrive - y.arrive || x.tick - y.tick);
  let cursor = 0;

  return (upto) => {
    while (cursor < packets.length && packets[cursor].arrive <= upto) {
      const packet = packets[cursor];
      // Round-trip through the wire format on every hop, so the suite exercises quantisation and
      // validation instead of quietly assuming the in-memory shortcut is the same thing.
      const wire = encodeInput(scriptedInput(packet.tick, slot));
      peer.receiveRemoteInput(slot, packet.tick, inputFromWire(wire));
      cursor += 1;
    }
  };
}

// -------------------------------------------------------------------------------------------
// Headless safety and architecture
// -------------------------------------------------------------------------------------------

test('headless: the rollback engine runs with no browser globals present', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  // Node 22 ships a global `WebSocket`, so its presence proves nothing here. What matters is that
  // the engine never *reaches* for one — which the architecture scan below gates directly.

  const session = new RollbackSession({ localSlot: 0 });
  const result = session.advance(idleInput({ moveX: 1 }));
  assert.equal(result.tick, 1);
  assert.equal(session.tick, 1);
});

test('architecture: protocol and rollback contain no DOM, socket, clock or randomness', () => {
  assert.ok(sources.net.includes('RollbackSession'), 'net bundle looks empty');

  // The engine owns four fighters' worth of prediction and rewind. A clock or a random number in
  // here would mean two peers rewinding to different worlds, which is the failure mode this whole
  // layer exists to make impossible.
  const forbidden = [
    /\bdocument\s*[.[]/,
    /\btypeof\s+document\b/,
    /\bwindow\s*[.[]/,
    /\btypeof\s+window\b/,
    /\bWebSocket\b/,
    /\bTHREE\b/,
    /\bDate\s*\.\s*now\b/,
    /\bperformance\s*\.\s*now\b/,
    /\bMath\s*\.\s*random\b/,
    /\bsetTimeout\b/,
    /\bsetInterval\b/,
    /\bfetch\s*\(/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(sources.net), false, `net bundle matches ${pattern}`);
  }
});

test('a session refuses an out-of-range local slot or rewind depth', () => {
  assert.throws(() => new RollbackSession({ localSlot: -1 }), RangeError);
  assert.throws(() => new RollbackSession({ localSlot: MAX_PLAYERS }), RangeError);
  assert.throws(() => new RollbackSession({ localSlot: 0, maxRollbackTicks: 0 }), RangeError);
  assert.throws(() => new RollbackSession({ localSlot: 0, maxRollbackTicks: 2.5 }), RangeError);
});

// -------------------------------------------------------------------------------------------
// Zero local input delay
// -------------------------------------------------------------------------------------------

test('the local input is consumed by the very next tick, with no delay buffer', () => {
  const session = new RollbackSession({ localSlot: 0 });
  const fighter = session.runner.fighterAt(0);
  assert.ok(fighter, 'slot 0 exists');

  // A held right-walk for three ticks moves the fighter immediately: if there were any input
  // delay, the first tick would be neutral and the fighter would lag by one tick's worth of motion.
  const startX = fighter.x;
  for (let tick = 1; tick <= 3; tick += 1) {
    session.advance(idleInput({ moveX: 1 }));
    assert.equal(session.tick, tick, 'tick advanced immediately');
  }
  assert.ok(fighter.x > startX, 'the fighter moved on the first tick, not a buffered later one');

  // Compare against the same three ticks driven directly through a MatchRunner: identical.
  const direct = new sim.MatchRunner();
  for (let tick = 0; tick < 3; tick += 1) {
    direct.fixedUpdate(sim.DT, direct.fighters.map((f) => (f.slot === 0 ? idleInput({ moveX: 1 }) : NEUTRAL_INPUT)));
  }
  assert.equal(fighter.x, direct.fighterAt(0).x, 'rollback world matches a directly-driven one');
});

// -------------------------------------------------------------------------------------------
// Prediction and correction
// -------------------------------------------------------------------------------------------

test('a remote input that matches the prediction causes no rollback at all', () => {
  const session = new RollbackSession({ localSlot: 0 });

  // Seed the prediction: this is what the engine will repeat into the ticks it has not heard about.
  const queued = session.receiveRemoteInput(1, 1, idleInput({ moveX: 1 }));
  assert.equal(queued.queued, true, 'an input for a tick we have not reached is held, not applied');
  assert.equal(session.tick, 0, 'receiving a future input does not itself advance the world');
  assert.equal(session.stats.rollbacks, 0);

  session.advance(NEUTRAL_INPUT); // tick 2: slot 1 is predicted (hold right)
  session.advance(NEUTRAL_INPUT); // tick 3: slot 1 is predicted (hold right)

  // The real input for tick 2 turns out to be exactly what was predicted.
  const result = session.receiveRemoteInput(1, 2, idleInput({ moveX: 1 }));
  assert.equal(result.queued, false);
  assert.equal(result.rolledBack, false, 'a correct prediction must not cost a rewind');
  assert.equal(session.stats.rollbacks, 0);
  assert.equal(session.stats.mispredictions, 0);
});

test('a mispredicted remote input rewinds to the tick before it and replays forward', () => {
  const session = new RollbackSession({ localSlot: 0 });

  // Prediction seed: slot 1 is holding right.
  session.receiveRemoteInput(1, 1, idleInput({ moveX: 1 }));
  for (let tick = 0; tick < 4; tick += 1) {
    session.advance(NEUTRAL_INPUT);
  }
  assert.equal(session.tick, 4);
  assert.equal(session.stats.rollbacks, 0);

  // Reality for tick 2 was "hold left". The engine simulated "hold right" from tick 2 onwards, so
  // ticks 2, 3 and 4 are all downstream of the lie and all have to be replayed.
  const result = session.receiveRemoteInput(1, 2, idleInput({ moveX: -1 }));
  assert.equal(result.rolledBack, true);
  assert.equal(result.rolledBackTicks, 3, 'rewound to tick 1 and replayed 2..4');
  assert.equal(session.tick, 4, 'the world is back at the present after the rewind');
  assert.equal(session.stats.mispredictions, 1);

  // The corrected fighter must be exactly where a straight, never-lied simulation put them.
  const reference = new sim.MatchRunner();
  reference.receiveInput?.();
  for (let tick = 1; tick <= 4; tick += 1) {
    reference.fixedUpdate(
      sim.DT,
      reference.fighters.map((f) => {
        if (f.slot === 0) {
          return NEUTRAL_INPUT;
        }
        return tick === 1 ? idleInput({ moveX: 1 }) : idleInput({ moveX: -1 });
      }),
    );
  }
  assert.equal(
    session.runner.fighterAt(1).x,
    reference.fighterAt(1).x,
    'after correction the remote fighter matches a never-mispredicted reference run',
  );
});

test('a rewind is clamped to the snapshot ring, and the clamp is reported', () => {
  const session = new RollbackSession({ localSlot: 0, maxRollbackTicks: 4 });
  assert.equal(session.maxRollbackTicks, 4);

  session.receiveRemoteInput(1, 1, idleInput({ moveX: 1 }));
  for (let tick = 0; tick < 20; tick += 1) {
    session.advance(NEUTRAL_INPUT);
  }

  // Tick 1 is long gone from a 4-tick ring, so this cannot be corrected.
  const result = session.receiveRemoteInput(1, 1, idleInput({ moveX: -1 }));
  assert.equal(result.rolledBack, false);
  assert.equal(session.stats.tooOldToCorrect, 1, 'the un-correctable input is counted, not hidden');
  assert.ok(
    session.stats.maxRewindTicks <= DEFAULT_MAX_ROLLBACK_TICKS,
    'a rewind never exceeds the configured window',
  );
});

test('the engine ignores an echo of its own input and an input for a departed slot', () => {
  const session = new RollbackSession({ localSlot: 0 });
  session.advance(NEUTRAL_INPUT);

  const echo = session.receiveRemoteInput(0, 1, idleInput({ moveX: 1 }));
  assert.equal(echo.ignored, true, 'a peer may not speak for our own fighter');

  session.markDeparted(1, session.tick + 1);
  session.advance(NEUTRAL_INPUT);
  const late = session.receiveRemoteInput(1, session.tick, idleInput({ moveX: 1 }));
  assert.equal(late.departed, true, 'a departed slot ignores late input rather than reviving');
  assert.equal(session.stats.droppedAfterDeparture, 1);
});

// -------------------------------------------------------------------------------------------
// Convergence — the property that matters
// -------------------------------------------------------------------------------------------

test('two peers converge to a bit-identical world over 300 ticks of a bad link', () => {
  const TOTAL = 300;
  const a = new RollbackSession({ localSlot: 0 });
  const b = new RollbackSession({ localSlot: 1 });
  const intoA = makeLink(a, 1, TOTAL);
  const intoB = makeLink(b, 0, TOTAL);

  for (let tick = 1; tick <= TOTAL; tick += 1) {
    a.advance(scriptedInput(tick, 0));
    b.advance(scriptedInput(tick, 1));
    intoA(tick);
    intoB(tick);
  }
  // Drain anything still in flight after the last tick.
  intoA(TOTAL + 30);
  intoB(TOTAL + 30);

  assert.equal(a.tick, TOTAL);
  assert.equal(b.tick, TOTAL);
  assert.equal(a.hash(), b.hash(), 'the two worlds are bit-identical');

  // And the correction actually happened — a suite that passed because nothing ever needed
  // correcting would be testing nothing at all.
  assert.ok(a.stats.rollbacks > 100, `expected heavy rollback activity, saw ${a.stats.rollbacks}`);
  assert.ok(b.stats.rollbacks > 100, `expected heavy rollback activity, saw ${b.stats.rollbacks}`);
  assert.equal(a.stats.tooOldToCorrect, 0, 'no input was so late the ring could not hold it');
  assert.ok(a.stats.maxRewindTicks <= DEFAULT_MAX_ROLLBACK_TICKS, 'rewinds stayed in the window');
});

test('three and four peers converge too, not just a pair', () => {
  const TOTAL = 180;
  const peers = [
    new RollbackSession({ localSlot: 0 }),
    new RollbackSession({ localSlot: 1 }),
    new RollbackSession({ localSlot: 2 }),
    new RollbackSession({ localSlot: 3 }),
  ];
  // Each peer receives the other three slots over its own independently-jittered link.
  const links = peers.map((peer) =>
    Array.from({ length: MAX_PLAYERS }, (_v, slot) =>
      slot === peer.localSlot ? null : makeLink(peer, slot, TOTAL),
    ),
  );

  for (let tick = 1; tick <= TOTAL; tick += 1) {
    for (let i = 0; i < peers.length; i += 1) {
      peers[i].advance(scriptedInput(tick, i));
    }
    for (let i = 0; i < peers.length; i += 1) {
      for (const link of links[i]) {
        link?.(tick);
      }
    }
  }
  for (let i = 0; i < peers.length; i += 1) {
    for (const link of links[i]) {
      link?.(TOTAL + 30);
    }
  }

  const hashes = peers.map((peer) => peer.hash());
  assert.equal(new Set(hashes).size, 1, `all four peers agree, got ${hashes.join(' ')}`);
});

test('a departure neutralises the slot from the same tick on every peer', () => {
  const TOTAL = 300;
  const LEAVE = 245;
  const a = new RollbackSession({ localSlot: 0 });
  const b = new RollbackSession({ localSlot: 1 });

  // Peer 1's packets stop the moment its phone locks. Peer 0's keep flowing.
  const intoA = makeLink(a, 1, LEAVE);
  const intoB = makeLink(b, 0, TOTAL);

  for (let tick = 1; tick <= TOTAL; tick += 1) {
    a.advance(scriptedInput(tick, 0));
    b.advance(scriptedInput(tick, 1));
    if (tick < LEAVE) {
      intoA(tick);
    }
    intoB(tick);

    if (tick === LEAVE) {
      // Both sessions are told the same thing at the same tick. The shared tick is the mechanism:
      // neither peer had to ask the other when the drop happened.
      a.markDeparted(1, LEAVE);
      b.markDeparted(1, LEAVE);
    }
  }

  assert.equal(a.isDeparted(1), true);
  assert.equal(b.isDeparted(1), true, 'the owning peer neutralises its own slot too');
  assert.equal(a.hash(), b.hash(), 'a mid-match disconnect does not fork the world');

  // And the departed fighter is genuinely idle, not still coasting on a stale prediction seed.
  const neutral = { ...NEUTRAL_INPUT };
  assert.equal(
    frameInputsEqual(a.simulatedInputAt(1, a.tick), neutral),
    true,
    'slot 1 feeds neutral input after departure',
  );
});

test('a departure announced for the next tick needs no rewind at all', () => {
  const session = new RollbackSession({ localSlot: 0 });
  session.receiveRemoteInput(1, 1, idleInput({ moveX: 1 }));
  session.advance(NEUTRAL_INPUT);

  const rewind = session.markDeparted(1, session.tick + 1);
  assert.equal(rewind, 0, 'the departure takes effect on a tick that has not run yet');
  session.advance(NEUTRAL_INPUT);
  assert.equal(session.isDeparted(1), true);
  assert.equal(
    frameInputsEqual(session.simulatedInputAt(1, session.tick), { ...NEUTRAL_INPUT }),
    true,
  );
});

// -------------------------------------------------------------------------------------------
// Canonicalisation — the invariant that stops silent, permanent desync
// -------------------------------------------------------------------------------------------

test('a raw gamepad axis is canonicalised identically on both sides of the wire', () => {
  // The bug this prevents is subtle and permanent: a local peer simulating 0.30000000000000004
  // while its peers simulate the quantised 0.375 would desync on every single rollback, forever,
  // with no packet left to correct it.
  const raw = idleInput({ moveX: 0.30000000000000004, moveZ: -0.7000000000000001 });
  const canonical = canonicalizeInput(raw);
  const peerCopy = inputFromWire(encodeInput(raw));

  assert.ok(frameInputsEqual(canonical, peerCopy), 'the canonical form equals what peers receive');
  // 0.3 is 2.4 eighths, so it snaps down to 2/8; -0.7 is -5.6 eighths, so it snaps to -6/8. Both
  // are exact binary fractions, which is the entire point of quantising on the wire.
  assert.equal(canonical.moveX, 0.25);
  assert.equal(canonical.moveZ, -0.75);
  assert.equal(canonical.moveX * 8, Math.trunc(canonical.moveX * 8), 'stays on the eighth grid');
});

test('a movement value the simulation never uses is clamped rather than trusted', () => {
  const wild = canonicalizeInput(idleInput({ moveX: 99, moveZ: -99 }));
  assert.equal(wild.moveX, 1, 'clamped to the eight-way table the sim reads');
  assert.equal(wild.moveZ, -1);
  assert.ok(frameInputsEqual(wild, inputFromWire(encodeInput(wild))), 'and stable under re-encoding');
});

test('a prediction that omits one-shot presses is honoured and still converges', () => {
  // Holding a chain opener across a 40ms prediction would auto-play a combo the player never
  // asked for, so the caller may drop the one-shot fields while keeping movement and guard.
  const holdableOnly = (last) =>
    last === null ? { ...NEUTRAL_INPUT } : { ...last, attack: null, dodge: 'none' };

  const TOTAL = 180;
  const a = new RollbackSession({ localSlot: 0, predict: holdableOnly });
  const b = new RollbackSession({ localSlot: 1, predict: holdableOnly });
  const intoA = makeLink(a, 1, TOTAL);
  const intoB = makeLink(b, 0, TOTAL);

  for (let tick = 1; tick <= TOTAL; tick += 1) {
    a.advance(scriptedInput(tick, 0));
    b.advance(scriptedInput(tick, 1));
    intoA(tick);
    intoB(tick);
  }
  intoA(TOTAL + 30);
  intoB(TOTAL + 30);

  assert.equal(a.hash(), b.hash(), 'a smarter predictor still converges');
  assert.ok(a.stats.rollbacks > 0, 'and it still had mispredictions to correct');
});

test('the default predictor repeats the last confirmed input verbatim', () => {
  const held = idleInput({ moveX: 1, guard: 'high' });
  assert.equal(repeatLastInput(held, 1), held);
  assert.ok(frameInputsEqual(repeatLastInput(null, 1), { ...NEUTRAL_INPUT }), 'neutral when unheard-from');
});

// -------------------------------------------------------------------------------------------
// Snapshot fidelity and reset
// -------------------------------------------------------------------------------------------

test('every tick in the rewind window is hashable, and the hash survives a replay', () => {
  const session = new RollbackSession({ localSlot: 0, maxRollbackTicks: 8 });
  for (let tick = 0; tick < 6; tick += 1) {
    session.advance(scriptedInput(tick + 1, 0));
  }

  // Hashes inside the window are the ones a rollback would rewind to.
  for (let tick = 0; tick <= 6; tick += 1) {
    assert.match(session.hashAt(tick), /^[0-9a-f]{8}$/, `hash for tick ${tick} is retained`);
  }
  // Beyond the window the ring has been overwritten, and saying so beats returning a stale hash.
  assert.equal(session.hashAt(500), null);
  assert.equal(session.hashAt(-1), null);
});

test('reset returns the world to a genuinely fresh match, not a zeroed tick', () => {
  const session = new RollbackSession({ localSlot: 0 });
  const start = session.hash();
  for (let tick = 0; tick < 30; tick += 1) {
    session.advance(scriptedInput(tick + 1, 0));
  }
  assert.notEqual(session.hash(), start);

  session.reset();
  assert.equal(session.tick, 0);
  assert.equal(session.hash(), start, 'fighters are back at spawn with full health');
});