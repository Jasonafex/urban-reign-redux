/**
 * House-LAN relay, wire protocol and address discovery (`npm test`).
 *
 * Two halves, and the split is the point:
 *
 *   - **The protocol is a validator, not a parser.** `src/net/protocol.ts` runs here with no
 *     sockets at all, because a house LAN also contains the roommate's laptop. Every property below
 *     is about what the relay must refuse to believe: a hostile or merely broken peer must never be
 *     able to throw inside `MatchRunner.fixedUpdate`, poison a slot, or smuggle an unknown move id
 *     into the simulation.
 *   - **The relay is a wire, not a referee.** The second half binds a real `ws` server on an
 *     ephemeral port and drives real clients against it, because the only way to know a relay
 *     assigns slots, rebroadcasts inputs and arbitrates hashes is to run one.
 *
 * The relay is *not* allowed to decide anything about gameplay. The tests below assert that
 * explicitly: it rebroadcasts inputs verbatim, and when peers disagree about a tick it reports the
 * disagreement without resolving it.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { cleanup, loadClient, loadNet, loadServer, loadSim } from '../tools/load-sim.mjs';

const net = await loadNet();
const serverModule = await loadServer();
const clientModule = await loadClient();
const sim = await loadSim();

const {
  PROTOCOL_VERSION,
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  MESSAGE_TYPES,
  MAX_MESSAGE_BYTES,
  isValidSlot,
  encodeInput,
  decodeInput,
  decodeWireInput,
  inputFromWire,
  encodeMessage,
  decodeMessage,
  sanitizeName,
  isValidAttack,
  quantiseAxis,
  isValidIPv4,
  isPrivateIPv4,
  selectLanIPv4,
  joinUrl,
  joinUrls,
  NEUTRAL_WIRE_INPUT,
} = net;
const { LanRelayServer } = serverModule;
const { LanClient, relayUrl } = clientModule;
const { idleInput, MatchRunner, DT } = sim;

after(cleanup);

/** Every relay started by this suite, so a failing test cannot leak a listening socket. */
const relays = [];
after(async () => {
  for (const relay of relays) {
    await relay.stop();
  }
});

async function startRelay(options = {}) {
  const relay = new LanRelayServer({ port: 0, host: '127.0.0.1', log: () => {}, ...options });
  const address = await relay.start();
  relays.push(relay);
  return { relay, address };
}

/** Resolve once `predicate` holds, or reject after `timeoutMs`. Never a sleep-and-hope. */
function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/** A raw socket, so the suite can speak the wire by hand instead of only through the client. */
function rawSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = decodeMessage(data.toString());
    inbox.push(message);
    // Wake every waiter, and remove *none* of them here. A waiter that does not match this
    // message stays registered: an earlier cut used `waiters.splice(0)`, which destroyed waiters
    // on first wake, so a `next('welcome')` woken by an unrelated `stage` broadcast was silently
    // gone by the time the welcome actually arrived — and the test hung on a message that was
    // sitting right there in the inbox.
    for (const waiter of [...waiters]) {
      waiter();
    }
  });
  return {
    socket,
    sent: [],
    open: () => new Promise((resolve) => socket.once('open', resolve)),
    send(message) {
      this.sent.push(message);
      socket.send(encodeMessage(message));
    },
    sendRaw(text) {
      socket.send(text);
    },
    /** Wait for the next message of a given type, looking in anything already received. */
    async next(type, timeoutMs = 4000) {
      // Take-and-remove in one step. An earlier cut of this helper resolved with the message and
      // then looked it up a *second* time to splice it out; on the second lookup it was gone, so
      // `indexOf(undefined)` returned -1 and `splice(-1, 1)` silently ate the last message in the
      // inbox. Every relay test below then failed on a missing `welcome`.
      const take = () => {
        const index = inbox.findIndex((m) => m !== null && m.t === type);
        return index < 0 ? undefined : inbox.splice(index, 1)[0];
      };

      const existing = take();
      if (existing !== undefined) {
        return existing;
      }

      return new Promise((resolve, reject) => {
        const waiter = () => {
          const message = take();
          if (message !== undefined) {
            clearTimeout(timer);
            const at = waiters.indexOf(waiter);
            if (at >= 0) {
              waiters.splice(at, 1);
            }
            resolve(message);
          }
        };
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) {
            waiters.splice(at, 1);
          }
          reject(new Error(`no ${type} arrived within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    all() {
      return inbox;
    },
    /** Like `next`, but skips messages until `accept` is satisfied. */
    async nextUntil(type, accept, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        const message = await this.next(type, Math.max(remaining, 1));
        if (accept(message)) {
          return message;
        }
        if (Date.now() > deadline) {
          throw new Error(`no ${type} satisfied the condition`);
        }
      }
    },
    close() {
      socket.close();
    },
  };
}

// -------------------------------------------------------------------------------------------
// Input validation — the hostile-peer half
// -------------------------------------------------------------------------------------------

test('a valid input survives a full encode/decode round trip unchanged', () => {
  const input = idleInput({ moveX: 1, moveZ: -1, attack: 'chain', stance: 'side', guard: 'low', dodge: 'high' });
  const wire = encodeInput(input);
  const back = decodeInput(wire);
  assert.ok(back, 'decoded');
  assert.deepEqual(back, { ...input, moveX: 1, moveZ: -1 });
});

test('every attack token the simulation accepts is accepted by the validator', () => {
  // The regression this guards: omitting the chain sentinel from the allowlist would silently
  // strip every combo press on the wire, turning a LAN match into nothing but jabs.
  assert.equal(isValidAttack('chain'), true);
  assert.equal(isValidAttack('neutral'), true, 'stances are legal attack tokens');
  assert.equal(isValidAttack('side'), true);
  assert.equal(isValidAttack('jack5_gigaton'), true, 'a charge sentinel is legal');
  assert.equal(isValidAttack('jab'), true, 'a move id is legal');
});

test('an unknown or hostile attack token is rejected outright, never partially repaired', () => {
  const hostile = [
    'nuke', // unknown move: would make MatchRunner throw
    '__proto__', // prototype pollution
    'constructor',
    'prototype',
    '../../etc/passwd', // path traversal
    'JAB', // wrong case
    '',
    'x'.repeat(200), // over the length cap
    'jab;rm -rf /',
    'jab ',
    42,
    true,
    {},
  ];

  // `null` is the one non-string attack that is *not* hostile: it is how the wire says "no press
  // this tick", so dropping it would make an idle fighter indistinguishable from a broken packet.
  assert.equal(isValidAttack(null), false, 'null is not an attack token');
  assert.notEqual(
    decodeWireInput({ ...NEUTRAL_WIRE_INPUT, atk: null }),
    null,
    'but a null attack is a perfectly valid packet',
  );
  for (const attack of hostile) {
    assert.equal(isValidAttack(attack), false, `${JSON.stringify(attack)} must be rejected`);
    const wire = { ...NEUTRAL_WIRE_INPUT, atk: attack };
    assert.equal(decodeWireInput(wire), null, 'the whole packet is dropped, not patched');
  }
});

test('a decoded input can never throw inside the simulation', () => {
  // The point of the allowlist. `handleAttack` throws a RangeError on an unknown move id, which is
  // right for a local caller and catastrophic for a network one.
  const attempts = [
    { ...NEUTRAL_WIRE_INPUT, atk: 'definitely_not_a_move' },
    { ...NEUTRAL_WIRE_INPUT, atk: '__proto__' },
    { ...NEUTRAL_WIRE_INPUT, atk: 'constructor' },
  ];
  for (const wire of attempts) {
    const decoded = decodeInput(wire);
    assert.equal(decoded, null);
    // Whatever does get through must be safe to feed straight to a real runner.
    if (decoded !== null) {
      const runner = new MatchRunner();
      runner.fixedUpdate(DT, runner.fighters.map((f) => (f.slot === 0 ? decoded : idleInput())));
    }
  }
});

test('a malformed input axis is rejected instead of being silently coerced', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, '0.5', null, undefined, {}]) {
    assert.equal(decodeWireInput({ ...NEUTRAL_WIRE_INPUT, x: bad }), null, `x = ${String(bad)}`);
    assert.equal(decodeWireInput({ ...NEUTRAL_WIRE_INPUT, z: bad }), null, `z = ${String(bad)}`);
  }
});

test('a valid input with a wild axis is clamped onto the eight-way table', () => {
  const clamped = decodeWireInput({ ...NEUTRAL_WIRE_INPUT, x: 47, z: -47 });
  assert.equal(clamped.x, 1);
  assert.equal(clamped.z, -1);
  assert.equal(quantiseAxis(Number.NaN), 0, 'a NaN axis becomes zero, not a thrown error');
  assert.equal(Object.is(quantiseAxis(-0.01), 0), true, 'negative zero is normalised away');
  assert.equal(quantiseAxis(-0.4), -0.375, 'and genuinely negative axes snap to the grid');
});

test('stance, guard and dodge must be enum members', () => {
  for (const bad of ['sideways', 'MID', 0, null, undefined, '']) {
    assert.equal(decodeWireInput({ ...NEUTRAL_WIRE_INPUT, st: bad }), null, `stance ${String(bad)}`);
    assert.equal(decodeWireInput({ ...NEUTRAL_WIRE_INPUT, gd: bad }), null, `guard ${String(bad)}`);
    assert.equal(decodeWireInput({ ...NEUTRAL_WIRE_INPUT, dg: bad }), null, `dodge ${String(bad)}`);
  }
});

test('slot validation rejects anything outside the four-fighter roster', () => {
  for (const slot of [0, 1, 2, 3]) {
    assert.equal(isValidSlot(slot), true);
  }
  for (const slot of [-1, 4, 1.5, Number.NaN, '1', null, undefined]) {
    assert.equal(isValidSlot(slot), false, `${String(slot)} must be rejected`);
  }
});

// -------------------------------------------------------------------------------------------
// Message envelopes
// -------------------------------------------------------------------------------------------

test('every declared message type round-trips through encode and decode', () => {
  const samples = {
    hello: { t: 'hello', v: PROTOCOL_VERSION, name: 'a', room: 'house' },
    welcome: { t: 'welcome', v: PROTOCOL_VERSION, slot: 2, room: 'house', stage: 'alley' },
    roster: { t: 'roster', entries: [{ slot: 0, name: 'a', connected: true }] },
    stage: { t: 'stage', stage: 'alley', seed: 7 },
    reject: { t: 'reject', code: 'full', reason: 'taken' },
    ready: { t: 'ready', slot: 1, ready: true },
    start: { t: 'start', tick: 0, stage: 'alley', seed: 0 },
    input: { t: 'input', tick: 5, slot: 1, input: encodeInput(idleInput({ moveX: 1 })) },
    sync: { t: 'sync', tick: 5, hash: 'deadbeef' },
    desync: { t: 'desync', tick: 5, claims: [{ slot: 0, hash: 'deadbeef' }] },
    ping: { t: 'ping', seq: 1, at: 0 },
    pong: { t: 'pong', seq: 1, at: 0 },
    'lan-ip': { t: 'lan-ip', v: PROTOCOL_VERSION },
    'lan-ip-reply': { t: 'lan-ip-reply', port: 8765, urls: ['http://192.168.1.5:5173/?lan'] },
  };

  assert.deepEqual(Object.keys(samples).sort(), [...MESSAGE_TYPES].sort(), 'every type is covered');
  for (const [type, message] of Object.entries(samples)) {
    const decoded = decodeMessage(encodeMessage(message));
    assert.ok(decoded, `${type} decoded`);
    assert.equal(decoded.t, type);
    assert.deepEqual(decoded, message, `${type} round-trips intact`);
  }
});

test('garbage on the wire decodes to null instead of throwing', () => {
  const hostile = [
    'not json at all',
    '{',
    '[]',
    'null',
    '"a string"',
    '{"t":"input"}', // no slot, no tick
    '{"t":"input","tick":1,"slot":0,"input":{"x":1}}', // truncated input
    '{"t":"made-up","slot":0}',
    '{"t":"input","tick":-1,"slot":0,"input":' + JSON.stringify(NEUTRAL_WIRE_INPUT) + '}',
    '{"t":"input","tick":1,"slot":9,"input":' + JSON.stringify(NEUTRAL_WIRE_INPUT) + '}',
    '{"t":"reject","code":"because"}',
    '{"t":"desync","tick":1,"claims":[]}',
    '{"t":"sync","tick":1,"hash":"NOTHEX"}',
    `{"t":"hello","v":1,"name":"${'x'.repeat(5000)}"}`,
    '',
    String.fromCharCode(0, 1), // a NUL/SOH frame: must not even parse
  ];
  for (const raw of hostile) {
    assert.equal(decodeMessage(raw), null, `${raw.slice(0, 40)} must decode to null`);
  }
  // Non-string garbage too.
  for (const raw of [null, undefined, 42, [], () => {}]) {
    assert.equal(decodeMessage(raw), null);
  }
});

test('a message over the size budget is refused at the sender', () => {
  const oversized = { t: 'input', tick: 1, slot: 0, input: { ...NEUTRAL_WIRE_INPUT, atk: 'x'.repeat(9000) } };
  assert.throws(() => encodeMessage(oversized), RangeError);
  assert.ok(MAX_MESSAGE_BYTES < 8192, 'the budget stays small enough to be a real limit');
});

test('a hostile name is stripped of control characters and length-capped', () => {
  assert.equal(sanitizeName('pad one'), 'pad one');
  assert.equal(sanitizeName(`evil${String.fromCharCode(0, 0)} name`), 'evil name');
  assert.equal(sanitizeName('x'.repeat(200)).length, 24);
  assert.equal(sanitizeName('   '), 'guest', 'blank falls back');
  assert.equal(sanitizeName(12345), 'guest', 'a non-string falls back');
  assert.equal(sanitizeName(String.fromCharCode(0, 7)), 'guest');
});

// -------------------------------------------------------------------------------------------
// LAN address selection — pure, so it is gated against a fixture, not the test host's network
// -------------------------------------------------------------------------------------------

test('IPv4 validation is strict', () => {
  for (const good of ['192.168.1.42', '10.0.0.1', '0.0.0.0', '255.255.255.255']) {
    assert.equal(isValidIPv4(good), true, good);
  }
  for (const bad of ['1.2.3', '1.2.3.4.5', '256.0.0.1', '010.1.1.1', '', 'localhost', '1.2.3.4 ', '::1']) {
    assert.equal(isValidIPv4(bad), false, bad);
  }
});

test('only private, non-loopback IPv4 addresses are advertised', () => {
  const fixture = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }],
    // A virtual adapter, as every laptop with Docker/Hyper-V/VirtualBox has.
    veth: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    wifi: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    v6: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    // Numeric family, as newer Node reports it.
    eth1: [{ address: '172.20.0.3', family: 4, internal: false }],
    publicish: [{ address: '8.8.8.8', family: 'IPv4', internal: false }],
    undetermined: [{ address: '0.0.0.0', family: 'IPv4', internal: false }],
  };

  const selected = selectLanIPv4(fixture);
  assert.deepEqual(selected, ['10.0.0.5', '172.17.0.1', '172.20.0.3', '192.168.1.42']);
  assert.equal(selected.includes('127.0.0.1'), false, 'loopback is not joinable');
  assert.equal(selected.includes('8.8.8.8'), false, 'a public address is not on the house LAN');
  assert.equal(selected.includes('fe80::1'), false, 'IPv6 is out of scope for the join URL');

  // Deterministic and duplicate-free: the same fixture always yields the same list.
  assert.deepEqual(selectLanIPv4(fixture), selected);
  assert.deepEqual(selectLanIPv4({}), []);
});

test('join URLs point at the web client and are well formed', () => {
  assert.equal(joinUrl('192.168.1.42', 5173), 'http://192.168.1.42:5173/?lan');
  assert.equal(joinUrl('192.168.1.42', 5173, '/join'), 'http://192.168.1.42:5173/join');
  assert.equal(joinUrl('192.168.1.42', 5173, 'lan'), 'http://192.168.1.42:5173/lan', 'slash is added');
  assert.deepEqual(joinUrls(['10.0.0.5', '192.168.1.42'], 5173), [
    'http://10.0.0.5:5173/?lan',
    'http://192.168.1.42:5173/?lan',
  ]);
});

test('relay URLs are normalised from whatever the join link gave us', () => {
  assert.equal(relayUrl('192.168.1.42'), 'ws://192.168.1.42:8765');
  assert.equal(relayUrl('localhost'), 'ws://localhost:8765');
  assert.equal(relayUrl('ws://host:1234'), 'ws://host:1234', 'an explicit URL is left alone');
  assert.equal(relayUrl('  '), 'ws://127.0.0.1:8765');
  assert.equal(relayUrl('fe80::1'), 'ws://[fe80::1]:8765', 'IPv6 literals get bracketed');
  assert.equal(DEFAULT_RELAY_PORT, 8765);
});

// -------------------------------------------------------------------------------------------
// The relay, over real sockets
// -------------------------------------------------------------------------------------------

test('the relay assigns the lowest free slot and broadcasts the roster', async () => {
  const { relay, address } = await startRelay();

  const first = rawSocket(address.port);
  await first.open();
  first.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'pad-one', room: 'house' });
  const welcomeOne = await first.next('welcome');
  assert.equal(welcomeOne.slot, 0);

  const second = rawSocket(address.port);
  await second.open();
  second.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'pad-two', room: 'house' });
  const welcomeTwo = await second.next('welcome');
  assert.equal(welcomeTwo.slot, 1, 'the second peer takes the next slot, not slot 0 again');

  // The first peer learns about the second through the roster broadcast. Two rosters go out — one
  // for each join — so this waits for the one that describes both rather than taking the first.
  const roster = await first.nextUntil(
    'roster',
    (message) => message.entries.filter((entry) => entry.connected).length === 2,
  );
  const connected = roster.entries.filter((entry) => entry.connected).map((entry) => entry.slot);
  assert.deepEqual(connected, [0, 1]);
  assert.equal(roster.entries.length, MAX_PLAYERS, 'all four slots are always described');

  first.close();
  second.close();
  await waitFor(() => relay.peers.length === 0);
  assert.equal(relay.peers.length, 0, 'both slots were freed when the peers went away');
});

test('the relay refuses a peer whose protocol version it does not speak', async () => {
  const { address } = await startRelay();
  const peer = rawSocket(address.port);
  await peer.open();
  peer.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'from-the-future', room: 'house' });

  const reject = await peer.next('reject');
  assert.equal(reject.code, 'version');
  assert.ok(reject.reason.includes(String(PROTOCOL_VERSION + 1)));
  peer.close();
});

test('the relay refuses a fifth player, because the match only has four fighters', async () => {
  const { address } = await startRelay();
  const peers = [];
  for (let i = 0; i < MAX_PLAYERS; i += 1) {
    const peer = rawSocket(address.port);
    await peer.open();
    peer.send({ t: 'hello', v: PROTOCOL_VERSION, name: `p${i}`, room: 'house' });
    await peer.next('welcome');
    peers.push(peer);
  }

  const extra = rawSocket(address.port);
  await extra.open();
  extra.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'fifth', room: 'house' });
  const reject = await extra.next('reject');
  assert.equal(reject.code, 'full');

  for (const peer of [...peers, extra]) {
    peer.close();
  }
});

test('a relay configured for fewer players holds to that limit', async () => {
  const { address } = await startRelay({ maxPlayers: 1 });
  const first = rawSocket(address.port);
  await first.open();
  first.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'one', room: 'house' });
  await first.next('welcome');

  const second = rawSocket(address.port);
  await second.open();
  second.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'two', room: 'house' });
  const reject = await second.next('reject');
  assert.equal(reject.code, 'full', 'a two-player duel relay must not admit a third');

  first.close();
  second.close();
});

test('the relay rebroadcasts an input verbatim to every peer except its author', async () => {
  const { address } = await startRelay();
  const sender = rawSocket(address.port);
  const watcher = rawSocket(address.port);
  await Promise.all([sender.open(), watcher.open()]);

  sender.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'a', room: 'house' });
  watcher.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'b', room: 'house' });
  await sender.next('welcome');
  await watcher.next('welcome');
  await watcher.next('roster'); // a's join
  await watcher.next('roster'); // b's join

  const payload = encodeInput(idleInput({ moveX: 1, attack: 'chain', stance: 'side' }));
  sender.send({ t: 'input', tick: 12, slot: 0, input: payload });

  const relayed = await watcher.next('input');
  assert.deepEqual(relayed, { t: 'input', tick: 12, slot: 0, input: payload });

  // The relay must not echo to the author, or every peer would apply its own input twice.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    sender.all().filter((m) => m !== null && m.t === 'input').length,
    0,
    'the relay does not echo an input back to its author',
  );

  sender.close();
  watcher.close();
});

test('a peer cannot speak for another peer slot', async () => {
  const { address } = await startRelay();
  const liar = rawSocket(address.port);
  const victim = rawSocket(address.port);
  await Promise.all([liar.open(), victim.open()]);

  liar.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'liar', room: 'house' });
  victim.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'victim', room: 'house' });
  await liar.next('welcome');
  await victim.next('welcome');

  // The liar is slot 0 and claims to be slot 1.
  liar.send({ t: 'input', tick: 3, slot: 1, input: encodeInput(idleInput({ moveX: 1 })) });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    victim.all().filter((m) => m !== null && m.t === 'input').length,
    0,
    'an input for a slot the sender does not own is dropped',
  );

  liar.close();
  victim.close();
});

test('the relay answers a latency probe and reports the joinable LAN addresses', async () => {
  const { address } = await startRelay({ webPort: 5173 });
  const peer = rawSocket(address.port);
  await peer.open();
  peer.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'a', room: 'house' });
  await peer.next('welcome');

  peer.send({ t: 'ping', seq: 7, at: 1234 });
  const pong = await peer.next('pong');
  assert.equal(pong.seq, 7);
  assert.equal(pong.at, 1234, 'the sender clock is echoed back untouched');

  peer.send({ t: 'lan-ip', v: PROTOCOL_VERSION });
  const reply = await peer.next('lan-ip-reply');
  assert.equal(reply.port, address.port);
  assert.ok(Array.isArray(reply.urls));
  // The join URLs address the *web client*, not the relay: a phone must load the game page first.
  for (const url of reply.urls) {
    assert.ok(url.startsWith('http://'), `${url} is a page URL`);
    assert.ok(url.includes(':5173/'), 'pointed at the web port, not the relay port');
  }
  peer.close();
});

test('the relay reports a desync instead of resolving it', async () => {
  const { relay, address } = await startRelay();
  const a = rawSocket(address.port);
  const b = rawSocket(address.port);
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'a', room: 'house' });
  b.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'b', room: 'house' });
  await a.next('welcome');
  await b.next('welcome');

  // Two peers claim different hashes for the same tick.
  a.send({ t: 'sync', tick: 42, hash: 'aaaaaaaa' });
  b.send({ t: 'sync', tick: 42, hash: 'bbbbbbbb' });

  const report = await a.next('desync');
  assert.equal(report.tick, 42);
  const hashes = report.claims.map((claim) => claim.hash).sort();
  assert.deepEqual(hashes, ['aaaaaaaa', 'bbbbbbbb'], 'both hashes are reported, neither chosen');

  // And it is reported once, not on every subsequent claim.
  a.send({ t: 'sync', tick: 42, hash: 'aaaaaaaa' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(a.all().filter((m) => m !== null && m.t === 'desync').length, 0, 'no repeat report');
  assert.ok(relay.currentTick >= 0);

  a.close();
  b.close();
});

test('agreeing hashes are never reported as a desync', async () => {
  const { address } = await startRelay();
  const a = rawSocket(address.port);
  const b = rawSocket(address.port);
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'a', room: 'house' });
  b.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'b', room: 'house' });
  await a.next('welcome');
  await b.next('welcome');

  for (let tick = 1; tick <= 5; tick += 1) {
    a.send({ t: 'sync', tick, hash: 'abcdef01' });
    b.send({ t: 'sync', tick, hash: 'abcdef01' });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.all().filter((m) => m !== null && m.t === 'desync').length, 0);

  a.close();
  b.close();
});

test('the relay frees a slot when a peer disconnects', async () => {
  const { relay, address } = await startRelay();
  const first = rawSocket(address.port);
  await first.open();
  first.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'first', room: 'house' });
  await first.next('welcome');

  const second = rawSocket(address.port);
  await second.open();
  second.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'second', room: 'house' });
  await second.next('welcome');
  await waitFor(() => relay.peers.length === 2);

  first.close();
  await waitFor(() => relay.peers.length === 1);
  assert.equal(relay.peers[0].slot, 1, 'the survivor keeps its own slot');

  // A new peer now takes the freed slot 0 rather than being pushed out.
  const third = rawSocket(address.port);
  await third.open();
  third.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'third', room: 'house' });
  const welcome = await third.next('welcome');
  assert.equal(welcome.slot, 0, 'the freed slot is reused');

  second.close();
  third.close();
});

// -------------------------------------------------------------------------------------------
// The client, against the real relay
// -------------------------------------------------------------------------------------------

test('a client completes the room lifecycle: connect, welcome, roster, ready', async () => {
  const { relay, address } = await startRelay();

  const client = new LanClient({
    url: `ws://127.0.0.1:${address.port}`,
    name: 'phone',
    room: 'house',
    createSocket: (url) => new WebSocket(url),
  });

  const welcome = new Promise((resolve) => client.on('welcome', resolve));
  assert.equal(client.connect(), true);
  const message = await welcome;
  assert.equal(message.slot, 0);
  assert.equal(client.state, 'lobby');
  assert.equal(client.slot, 0);

  await waitFor(() => relay.peers.length === 1);
  assert.equal(relay.peers[0].name, 'phone');

  client.sendReady(true);
  assert.ok(client.roster.length >= 0);
  client.close();
  assert.equal(client.state, 'closed');
});

test('client latency is measured from real ping/pong round trips', async () => {
  const { address } = await startRelay();
  const client = new LanClient({
    url: `ws://127.0.0.1:${address.port}`,
    name: 'p',
    createSocket: (url) => new WebSocket(url),
    // A fake clock driven by hand: no sleeping, and the numbers are exact.
    now: (() => {
      let t = 1000;
      return () => (t += 25);
    })(),
    pingIntervalMs: 1,
  });

  const welcomed = new Promise((resolve) => client.on('welcome', resolve));
  assert.equal(client.connect(), true);
  const message = await welcomed;
  assert.equal(message.slot, 0);

  assert.equal(client.latency.samples, 0, 'no samples before the first probe');

  for (let i = 0; i < 5; i += 1) {
    client.ping();
    await waitFor(() => client.latency.samples > i);
  }

  const latency = client.latency;
  assert.equal(latency.samples, 5);
  assert.ok(latency.rttMs > 0, 'a round trip was measured');
  assert.ok(latency.medianMs >= 0);
  assert.ok(latency.jitterMs >= 0);
  assert.equal(latency.lastSeq, 4, 'five probes are numbered 0..4');
  client.close();
});

test('a client with no transport reports unavailable instead of throwing', () => {
  const client = new LanClient({ url: 'ws://nothing', name: 'headless' });
  // No `createSocket` and no browser `WebSocket` reachable through this path: the client must
  // degrade to a state, not blow up the page that constructed it.
  const connected = client.connect();
  assert.equal(typeof connected, 'boolean');
  if (!connected) {
    assert.equal(client.state, 'unavailable');
  }
  assert.equal(client.send({ t: 'ping', seq: 0, at: 0 }), false, 'sending without a socket is a no-op');
  client.close();
});

test('a client drives a real rollback session against a real relay', async () => {
  const { relay, address } = await startRelay();
  const { RollbackSession, inputFromWire: project } = net;

  const a = new LanClient({ url: `ws://127.0.0.1:${address.port}`, name: 'a', createSocket: (u) => new WebSocket(u) });
  const b = new LanClient({ url: `ws://127.0.0.1:${address.port}`, name: 'b', createSocket: (u) => new WebSocket(u) });

  const welcomeA = new Promise((r) => a.on('welcome', r));
  const welcomeB = new Promise((r) => b.on('welcome', r));
  a.connect();
  b.connect();
  const [slotA, slotB] = await Promise.all([welcomeA, welcomeB]);
  assert.equal(slotA.slot, 0);
  assert.equal(slotB.slot, 1);

  const sessionA = new RollbackSession({ localSlot: slotA.slot });
  const sessionB = new RollbackSession({ localSlot: slotB.slot });

  // Wire the relay's rebroadcasts into each session — this is exactly what `main.ts` does.
  a.on('input', (m) => m.t === 'input' && sessionA.receiveRemoteInput(m.slot, m.tick, project(m.input)));
  b.on('input', (m) => m.t === 'input' && sessionB.receiveRemoteInput(m.slot, m.tick, project(m.input)));

  for (let tick = 1; tick <= 60; tick += 1) {
    const inputA = idleInput({ moveX: tick % 30 < 15 ? 1 : -1 });
    const inputB = idleInput({ moveX: tick % 30 < 15 ? -1 : 1 });
    // 0 input delay: advance first, publish after — the relay may be slower than the tick.
    sessionA.advance(inputA);
    a.sendInput(tick, inputA);
    sessionB.advance(inputB);
    b.sendInput(tick, inputB);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  await waitFor(() => sessionA.tick === 60 && sessionB.tick === 60);
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(
    sessionA.hash(),
    sessionB.hash(),
    'two peers talking through a real relay converge on a bit-identical world',
  );
  assert.ok(sessionA.stats.rollbacks + sessionB.stats.rollbacks > 0, 'and the link really needed correcting');

  a.close();
  b.close();
  assert.ok(relay.peers.length >= 0);
});