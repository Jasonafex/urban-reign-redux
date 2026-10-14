/**
 * WebRTC in-browser P2P hosting (`npm test`).
 *
 * This suite has one job: prove that a four-player room can run **inside a browser tab**, with no
 * `ws` server anywhere, and that the netcode cannot tell the difference.
 *
 * The split is deliberate:
 *
 *   - **The pure half needs no browser at all.** Room codes, the ICE configuration, the signaling
 *     codec and the data-channel adapter are exercised directly against plain objects, in Node,
 *     with `RTCPeerConnection` genuinely absent. That is the "gracefully handles environments where
 *     `RTCPeerConnection` is undefined" requirement made falsifiable: if any of it touched a
 *     browser global at import or construction time, the very first assertion here would throw.
 *   - **The relay is driven with mock data channels**, and the referee underneath it is the *real*
 *     `RoomCoordinator` — the same one the Node relay in `test/lan.test.mjs` drives over a real
 *     socket. Slot allocation, roster broadcasts, lockstep input relay and the desync audit are
 *     therefore asserted twice, against both transports, and must agree.
 *   - **The whole handshake runs end to end.** A fake broker and a fake `RTCPeerConnection` (paired
 *     in-process) carry a real offer/answer/ICE exchange between a real `InBrowserP2pHost` and a real
 *     `InBrowserP2pGuest`. The guest then drives an ordinary `LanClient` over the resulting
 *     `WebRtcDataChannelSocket` and is admitted to the host's room with slot 1.
 *
 * That last one is the load-bearing test. It is the only assertion that would fail if the adapter,
 * the tap seam or the referee's message routing were subtly wrong in a way that every unit test
 * above was happy with — and it is the exact claim this feature makes: the same client, the same
 * rollback engine, no server.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadWebrtc } from '../tools/load-sim.mjs';

/**
 * One bundle, deliberately.
 *
 * The referee (`room.ts`), the data-channel adapter and `LanClient` all live in this graph, so the
 * end-to-end test drives the *real* client against the *real* referee over a mocked channel. If the
 * adapter were a shim that only satisfies the interface on paper, this is the test that notices.
 */
const {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
  SIGNAL_MAX_BYTES,
  SIGNAL_VERSION,
  DATA_CHANNEL_LABEL,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  SOCKET_CLOSED,
  PROTOCOL_VERSION,
  InBrowserHostRelay,
  InBrowserP2pGuest,
  InBrowserP2pHost,
  LanClient,
  PUBLIC_STUN_URLS,
  WebRtcDataChannelSocket,
  WebRtcSignaling,
  buildRtcConfiguration,
  createLinkedSocketPair,
  dataChannelStateToNumber,
  decodeMessage,
  decodeSignalMessage,
  encodeMessage,
  encodeSignalMessage,
  generateRoomCode,
  isValidRoomCode,
  isWebRtcSupported,
  normalizeRoomCode,
  publicIceServers,
  roomJoinUrl,
  signalBrokerUrl,
} = await loadWebrtc();

after(cleanup);

// -------------------------------------------------------------------------------------------
// Test doubles
// -------------------------------------------------------------------------------------------

/**
 * A data channel with no browser behind it.
 *
 * Faithful in the three ways that actually matter to the code under test: `readyState` is the string
 * `RTCDataChannel` actually uses, `send` *throws* when the channel is not open (the real one does,
 * and the adapter's "drop rather than throw" promise is only meaningful if the double does), and
 * delivery is asynchronous.
 */
class MockDataChannel {
  constructor(label = 'mock') {
    this.label = label;
    this.readyState = 'connecting';
    this.sent = [];
    this.peer = null;
    this.opened = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  static pair(labelA = 'a', labelB = 'b') {
    const a = new MockDataChannel(labelA);
    const b = new MockDataChannel(labelB);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  send(data) {
    if (this.readyState !== 'open') {
      throw new Error('RTCDataChannel is not open');
    }
    this.sent.push(data);
    this.peer?.receive(data);
  }

  close() {
    if (this.readyState === 'closed') {
      return;
    }
    this.readyState = 'closed';
    this.peer?.close();
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: '' }));
  }

  /** Deliver a frame as if it had arrived over the wire. */
  receive(data) {
    // Liveness was checked when the frame was sent, not now: a frame sent before `close()` is
    // still delivered, because the close is ordered after it — exactly as on a real channel.
    queueMicrotask(() => {
      this.onmessage?.({ data });
    });
  }

  /**
   * Settle both ends as open, as ICE completion would.
   *
   * `onopen` fires synchronously at the transition, exactly as a real channel does. That matters:
   * a real channel that opened *before* a handler was attached will never fire `open` again, so the
   * adapter has to replay it — and a double that queued its callback would make that replay look
   * like two opens. Walking the pair instead of recursing avoids an unbounded a→b→a→b loop.
   */
  openUp() {
    for (const end of this.peer === null ? [this] : [this, this.peer]) {
      if (end.opened) {
        continue;
      }
      end.opened = true;
      end.readyState = 'open';
      end.onopen?.({ type: 'open' });
    }
  }
}

/**
 * A peer connection that completes negotiation with another mock, in process.
 *
 * Channels are opened when the answer is applied, which is the earliest point a real DTLS handshake
 * could complete — and it means the guest's channel is *already open* by the time the adapter wraps
 * it, exercising the "a channel that was open before we wrapped it never fires `open` again" path
 * that a real ICE race produces roughly every time.
 */
class MockPeerConnection {
  constructor() {
    this.createdChannel = null;
    this.closed = false;
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.remote = null;
  }

  static connect(a, b) {
    a.remote = b;
    b.remote = a;
    return [a, b];
  }

  createDataChannel(label) {
    const [host, guest] = MockDataChannel.pair(label, `${label}-guest`);
    this.createdChannel = host;
    return host;
  }

  async createOffer() {
    return { type: 'offer', sdp: `offer-sdp-for-${this.label()}` };
  }

  async createAnswer() {
    return { type: 'answer', sdp: `answer-sdp-for-${this.label()}` };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
    this.onicecandidate?.({ candidate: { candidate: `local-${this.label()}`, sdpMid: '0', sdpMLineIndex: 0 } });
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    if (description.type === 'offer') {
      // Answerer side: the offerer's channel arrives here, and both ends come up together.
      const incoming = this.remote?.createdChannel;
      if (incoming !== null && incoming !== undefined) {
        queueMicrotask(() => {
          incoming.openUp();
          this.ondatachannel?.({ channel: incoming.peer });
        });
      }
      return;
    }
    // Offerer side: the answer means ICE can complete.
    queueMicrotask(() => this.createdChannel?.openUp());
  }

  async addIceCandidate(candidate) {
    this.addedCandidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.createdChannel?.close();
  }

  label() {
    return this.createdChannel?.label ?? 'pc';
  }
}

/**
 * A WebSocket broker that forwards frames to the rest of the room.
 *
 * Two lines of policy is the entire broker contract: join the room named in the first frame, and
 * forward every frame to everyone who is not the sender. It deliberately parses nothing else — if
 * this suite ever had to teach the broker what an `input` is, the broker would have become a server.
 */
function createBroker() {
  const rooms = new Map();
  const frames = [];

  return {
    frames,
    createSocket: () => {
      const sent = [];
      let joined = null;
      const ws = {
        readyState: SOCKET_CONNECTING,
        sent,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        open() {
          ws.readyState = SOCKET_OPEN;
          queueMicrotask(() => ws.onopen?.({}));
        },
        send(text) {
          if (ws.readyState !== SOCKET_OPEN) {
            throw new Error('broker socket not open');
          }
          frames.push(text);
          const message = JSON.parse(text);
          if (joined === null) {
            joined = message.room;
            let members = rooms.get(joined);
            if (members === undefined) {
              members = new Set();
              rooms.set(joined, members);
            }
            members.add(ws);
          }
          for (const member of rooms.get(message.room) ?? []) {
            if (member === ws) {
              continue;
            }
            member.deliver(text);
          }
        },
        deliver(text) {
          queueMicrotask(() => ws.onmessage?.({ data: text }));
        },
        close() {
          ws.readyState = SOCKET_CLOSED;
          if (joined !== null) {
            rooms.get(joined)?.delete(ws);
          }
          queueMicrotask(() => ws.onclose?.({ code: 1000, reason: '' }));
        },
      };
      queueMicrotask(() => ws.open());
      return ws;
    },
  };
}

/** Let every queued microtask, promise continuation and simulated frame settle. */
async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Collect the messages a socket receives, the way `LanClient` would. */
function readFrames(socket) {
  const received = [];
  socket.onmessage = (event) => {
    const message = decodeMessage(event.data);
    if (message !== null) {
      received.push(message);
    }
  };
  return received;
}

const quiet = { log: () => {} };

/** A room with slot 0 taken by the host itself. */
function hostRelay(options = {}) {
  return new InBrowserHostRelay({ log: () => {}, ...options });
}

// -------------------------------------------------------------------------------------------
// Headless safety
// -------------------------------------------------------------------------------------------

test('the module loads and reports "no WebRTC" in a plain Node process', () => {
  assert.equal(isWebRtcSupported(), false, 'Node has no RTCPeerConnection');
  assert.equal(typeof globalThis.RTCPeerConnection, 'undefined');
  // Constructing every headless piece with injected doubles must not touch a browser global.
  assert.ok(hostRelay().roomCode.length > 0);
  assert.equal(new WebRtcDataChannelSocket(null).readyState, SOCKET_CLOSED);
});

// -------------------------------------------------------------------------------------------
// Room codes
// -------------------------------------------------------------------------------------------

test('room codes are UR-XXXX and avoid characters humans transpose', () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = generateRoomCode();
    assert.match(code, ROOM_CODE_PATTERN);
    assert.equal(code.length, 'UR-'.length + ROOM_CODE_LENGTH);
    assert.ok(isValidRoomCode(code));
  }
  // The whole point of the alphabet: I/O/0/1 cannot appear, so `UR-1OZZ` cannot be read aloud
  // wrong and then fail to match.
  for (const ambiguous of ['I', 'O', '0', '1']) {
    assert.equal(ROOM_CODE_ALPHABET.includes(ambiguous), false);
  }
});

test('a seeded generator is reproducible and clamps a hostile RNG', () => {
  const seeded = () => generateRoomCode(() => 0);
  assert.equal(seeded(), seeded());
  assert.ok(isValidRoomCode(seeded()));
  // Out-of-range draws must not index off the end of the alphabet.
  for (const bad of [-1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(isValidRoomCode(generateRoomCode(() => bad)), `draw ${String(bad)} must still produce a code`);
  }
});

test('room codes normalise from the shapes a guest actually produces', () => {
  assert.equal(normalizeRoomCode('ur-abcd'), 'UR-ABCD');
  assert.equal(normalizeRoomCode(' UR-abcd '), 'UR-ABCD');
  assert.equal(normalizeRoomCode('ABCD'), 'UR-ABCD');
  assert.equal(normalizeRoomCode('URABCD'), 'UR-ABCD');
  // A five-character code is a typo. Matching its first four would put two players in a room
  // neither of them asked for, which is worse than refusing.
  assert.equal(normalizeRoomCode('UR-ABCDE'), null);
  assert.equal(normalizeRoomCode('UR-AB'), null);
  assert.equal(normalizeRoomCode('UR-AB!D'), null);
  assert.equal(normalizeRoomCode(undefined), null);
  assert.equal(isValidRoomCode('ur-abcd'), false, 'isValidRoomCode is the canonical form only');
});

test('the join URL carries the room, keeps the mode, and drops every other mode flag', () => {
  assert.equal(roomJoinUrl('ur-ab12'), '?room=UR-AB12');
  assert.equal(roomJoinUrl('ur-ab12', 'http://192.168.1.42:5173/'), 'http://192.168.1.42:5173/?room=UR-AB12');
  assert.equal(
    roomJoinUrl('UR-AB12', 'http://192.168.1.42:5173/?mode=team_battle&lan=1#top'),
    'http://192.168.1.42:5173/?mode=team_battle&room=UR-AB12',
  );
  // A QR carrying `?lan` *and* `?room=` would leave the guest's boot logic arguing with itself.
  assert.equal(
    roomJoinUrl('UR-AB12', 'http://host/?lan&join=192.168.1.9&room=UR-ZZZZ&p2p'),
    'http://host/?room=UR-AB12',
  );
  assert.throws(() => roomJoinUrl('nonsense', 'http://host/'), RangeError);
});

test('the broker URL follows the page origin and honours ?signal=', () => {
  assert.equal(signalBrokerUrl('http://192.168.1.42:5173/'), 'ws://192.168.1.42:5173/signal');
  assert.equal(signalBrokerUrl('https://house.example/'), 'wss://house.example/signal');
  assert.equal(signalBrokerUrl('https://x.dev/?room=UR-AB12'), 'wss://x.dev/signal');
  // An explicit broker wins — that is how a public broker replaces the house default.
  assert.equal(
    signalBrokerUrl('http://a.dev/?signal=wss%3A%2F%2Fbroker.example%2Frtc'),
    'wss://broker.example/rtc',
  );
});

// -------------------------------------------------------------------------------------------
// ICE
// -------------------------------------------------------------------------------------------

test('ICE defaults to public STUN and accepts an explicit TURN', () => {
  assert.ok(PUBLIC_STUN_URLS.includes('stun:stun.l.google.com:19302'));
  const bare = buildRtcConfiguration();
  assert.equal(bare.iceServers.length, PUBLIC_STUN_URLS.length);
  assert.equal(bare.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  assert.deepEqual(publicIceServers(), bare.iceServers);

  const withTurn = buildRtcConfiguration([
    { urls: 'turn:turn.example:3478', username: 'u', credential: 'p' },
  ]);
  assert.equal(withTurn.iceServers.length, bare.iceServers.length + 1, 'TURN is appended, not swapped');
  const turn = withTurn.iceServers[withTurn.iceServers.length - 1];
  assert.equal(turn.urls, 'turn:turn.example:3478');
  assert.equal(turn.username, 'u');

  // A blank entry is dropped rather than handed to the browser as an ICE server with no URLs.
  const withJunk = buildRtcConfiguration([{ urls: '' }]);
  assert.equal(withJunk.iceServers.length, bare.iceServers.length);
});

// -------------------------------------------------------------------------------------------
// Data channel adapter
// -------------------------------------------------------------------------------------------

test('the data channel adapter speaks the WebSocket contract LanClient expects', async () => {
  const [host, guest] = MockDataChannel.pair();
  const socket = new WebRtcDataChannelSocket(host);

  assert.equal(socket.readyState, SOCKET_CONNECTING, 'a connecting channel reports 0, not "connecting"');
  assert.equal(socket.send('early'), false, 'sending before open drops instead of throwing');

  let opened = 0;
  socket.onopen = () => {
    opened += 1;
  };
  host.openUp();
  assert.equal(socket.readyState, SOCKET_OPEN);
  await settle();
  assert.equal(opened, 1);

  const received = readFrames(socket);
  guest.send('{"t":"ping","seq":1,"at":2}');
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].t, 'ping');
  assert.equal(guest.sent.length, 1, 'the frame really left through the channel');
});

test('a channel that was already open still gets its open event exactly once', async () => {
  const [host] = MockDataChannel.pair();
  host.openUp();

  const socket = new WebRtcDataChannelSocket(host);
  assert.equal(socket.readyState, SOCKET_OPEN);

  let opened = 0;
  socket.onopen = () => {
    opened += 1;
  };
  await settle();
  assert.equal(opened, 1, 'the event the browser will never send is replayed');

  socket.send('ok');
  assert.deepEqual(host.sent, ['ok']);
});

test('a dead channel reports closed, drops sends, and notifies its observers once', async () => {
  const [host] = MockDataChannel.pair();
  const socket = new WebRtcDataChannelSocket(host);
  host.openUp();
  await settle();

  let drops = 0;
  socket.onDropped(() => {
    drops += 1;
  });
  const tapped = [];
  socket.tap((data) => tapped.push(data));

  host.close();
  await settle();
  assert.equal(socket.readyState, SOCKET_CLOSED);
  assert.equal(drops, 1);
  assert.equal(socket.send('gone'), false, 'a send into a closed channel is dropped, never thrown');

  // `onDropped` on an already-dead socket reports immediately, so a peer admitted onto a closed
  // channel cannot sit in the roster holding a slot until the next sweep.
  let late = 0;
  socket.onDropped(() => {
    late += 1;
  });
  assert.equal(late, 1);

  socket.close();
  socket.close();
  await settle();
  assert.equal(drops, 1, 'close is idempotent — one notification, not three');
});

test('a tap sees every frame even when the client owns onmessage', async () => {
  const [host, guest] = MockDataChannel.pair();
  const socket = new WebRtcDataChannelSocket(host);
  const tapped = [];
  socket.tap((data) => tapped.push(data));

  const seen = readFrames(socket);
  host.openUp();
  await settle();
  guest.send('{"t":"roster","entries":[]}');
  await settle();

  assert.equal(tapped.length, 1, 'the referee sees the frame the client also saw');
  assert.equal(seen.length, 1);
});

test('data channel states map onto WebSocket numbering', () => {
  assert.equal(dataChannelStateToNumber('connecting'), SOCKET_CONNECTING);
  assert.equal(dataChannelStateToNumber('open'), SOCKET_OPEN);
  assert.equal(dataChannelStateToNumber('closing'), 2);
  assert.equal(dataChannelStateToNumber('closed'), SOCKET_CLOSED);
  assert.equal(dataChannelStateToNumber(1), 1);
  assert.equal(dataChannelStateToNumber('bogus'), SOCKET_CLOSED);
});

// -------------------------------------------------------------------------------------------
// Signaling codec
// -------------------------------------------------------------------------------------------

test('signaling frames are validated like everything else on the wire', () => {
  const good = { t: 'offer', v: SIGNAL_VERSION, room: 'UR-AB12', from: 'host1', to: 'guest1', sdp: 'v=0' };
  assert.deepEqual(decodeSignalMessage(JSON.stringify(good)), good);
  assert.deepEqual(decodeSignalMessage(good), good, 'an already-parsed envelope is accepted');

  assert.equal(decodeSignalMessage('{'), null, 'garbage is silence');
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, v: 99 })), null, 'a version bump is refused');
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, room: 'not-a-room' })), null);
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, room: 'UR-AB!' })), null);
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, to: '' })), null);
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, sdp: '' })), null);
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, t: 'start' })), null);
  assert.equal(decodeSignalMessage(JSON.stringify({ ...good, from: 'x'.repeat(33) })), null);
  assert.equal(
    decodeSignalMessage(JSON.stringify({ ...good, sdp: 'v=0'.repeat(SIGNAL_MAX_BYTES) })),
    null,
    'an oversized frame is refused before it is parsed',
  );
});

test('the end-of-candidates marker survives the round trip', () => {
  // `null` candidates are how a peer learns gathering is *done*. Dropping it is a classic cause of a
  // connection that gathers perfectly and then never completes.
  const frame = {
    t: 'ice',
    v: SIGNAL_VERSION,
    room: 'UR-AB12',
    from: 'host1',
    to: 'guest1',
    candidate: null,
  };
  assert.deepEqual(decodeSignalMessage(JSON.stringify(frame)), frame);

  const withCandidate = {
    ...frame,
    candidate: { candidate: 'candidate:1 1 UDP', sdpMid: '0', sdpMLineIndex: 0 },
  };
  assert.deepEqual(decodeSignalMessage(JSON.stringify(withCandidate)), withCandidate);
  assert.equal(encodeSignalMessage(frame), JSON.stringify(frame));
});

test('the signaling client announces its room and ignores frames for everyone else', async () => {
  const sockets = [];
  const host = new WebRtcSignaling({
    room: 'ur-ab12',
    role: 'host',
    url: 'ws://broker/signal',
    selfId: 'host1',
    log: () => {},
    createSocket: () => {
      const ws = {
        readyState: SOCKET_CONNECTING,
        sent: [],
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data) {
          this.sent.push(data);
        },
        close() {
          this.readyState = SOCKET_CLOSED;
          queueMicrotask(() => this.onclose?.({}));
        },
      };
      sockets.push(ws);
      queueMicrotask(() => {
        ws.readyState = SOCKET_OPEN;
        ws.onopen?.({});
      });
      return ws;
    },
  });

  const joins = [];
  const offers = [];
  const ices = [];
  host.on('join', (message) => joins.push(message));
  host.on('offer', (message) => offers.push(message));
  host.on('ice', (message) => ices.push(message));
  assert.equal(host.room, 'UR-AB12');
  assert.equal(host.open(), true);

  await settle();
  assert.equal(host.state, 'open');
  const announced = JSON.parse(sockets[0].sent[0]);
  assert.equal(announced.t, 'host');
  assert.equal(announced.room, 'UR-AB12');
  assert.equal(announced.from, 'host1');

  const wire = (message) => sockets[0].onmessage({ data: JSON.stringify(message) });
  // Our own echo, a different room, and a frame for the room: only the last is ours.
  wire({ t: 'join', v: SIGNAL_VERSION, room: 'UR-AB12', from: 'host1' });
  wire({ t: 'join', v: SIGNAL_VERSION, room: 'UR-ZZZZ', from: 'guest9' });
  wire({ t: 'join', v: SIGNAL_VERSION, room: 'UR-AB12', from: 'guest2' });
  // …and an *addressed* frame for a third guest, which a broker would happily forward here too.
  wire({
    t: 'offer',
    v: SIGNAL_VERSION,
    room: 'UR-AB12',
    from: 'host1',
    to: 'guest3',
    sdp: 'v=0',
  });
  wire({
    t: 'ice',
    v: SIGNAL_VERSION,
    room: 'UR-AB12',
    from: 'host1',
    to: 'host1',
    candidate: null,
  });
  await settle();
  assert.equal(joins.length, 1, 'a broadcast frame is ours; an addressed one is not');
  assert.equal(joins[0].from, 'guest2');
  assert.deepEqual(offers, [], "another guest's offer is never acted on");
  assert.equal(ices.length, 0, "nor is a candidate we were not addressed");

  host.close();
  assert.equal(host.state, 'closed');
});

test('signaling reports unavailable rather than throwing when there is no WebSocket', () => {
  const original = globalThis.WebSocket;
  delete globalThis.WebSocket;
  try {
    const signaling = new WebRtcSignaling({ room: 'UR-AB12', role: 'guest', log: () => {} });
    assert.equal(signaling.open(), false);
    assert.equal(signaling.state, 'unavailable');
    assert.equal(signaling.send({ t: 'join', v: SIGNAL_VERSION, room: 'UR-AB12', from: 'x' }), false);
  } finally {
    if (original !== undefined) {
      globalThis.WebSocket = original;
    }
  }
  assert.throws(() => new WebRtcSignaling({ room: 'not-a-room', role: 'host' }), RangeError);
});

// -------------------------------------------------------------------------------------------
// In-browser relay
// -------------------------------------------------------------------------------------------

/**
 * Admit a guest sitting at the far end of a mocked channel.
 *
 * The host wraps *its own* end of the data channel — that is the real topology, because the guest
 * is a different browser — and the guest wraps its own end with the same adapter. So this helper
 * stands up two full sockets on one channel pair: `handle.socket` is the host's view of the guest,
 * and `guestSocket` is the guest browser's own `WebRtcDataChannelSocket`, which is what the guest's
 * `LanClient` would be driving in a real room.
 */
async function admitGuest(relay, label, name, room = 'UR-AB12') {
  const [relayEnd, remote] = MockDataChannel.pair(label, `${label}-remote`);
  relayEnd.openUp();
  const handle = relay.attachDataChannel(relayEnd);
  // The host's view of this guest: frames *arriving* from them, which is also what the referee's tap
  // sees. Nothing the referee *sends* to the guest appears here — those frames leave on the channel.
  const inbound = readFrames(handle.socket);
  const guestSocket = new WebRtcDataChannelSocket(remote);
  // The guest browser's own socket: frames arriving from the referee, plus everything it sends.
  const guestFrames = readFrames(guestSocket);
  guestSocket.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, name, room }));
  await settle();
  return {
    handle,
    inbound,
    guestSocket,
    guestFrames,
    remote,
    relayEnd,
    say: (message) => guestSocket.send(encodeMessage(message)),
  };
}

/** Admit the host itself, through an in-memory socket into the referee in its own tab. */
async function admitHost(relay, name = 'host', room = 'UR-AB12') {
  const handle = relay.attachLocal();
  const frames = readFrames(handle.socket);
  const say = (message) => handle.socket.send(encodeMessage(message));
  say({ t: 'hello', v: PROTOCOL_VERSION, name, room });
  await settle();
  return { handle, frames, say };
}

test('the in-browser relay hands slot 0 to the host and 1–3 to guests', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12', name: 'host' });
  assert.equal(relay.roomCode, 'UR-AB12');

  const host = await admitHost(relay);
  assert.equal(relay.peers.length, 1);
  assert.equal(relay.peers[0].slot, 0);
  assert.equal(relay.peers[0].name, 'host');
  assert.ok(host.frames.some((frame) => frame.t === 'welcome' && frame.slot === 0));

  for (let index = 1; index <= 3; index += 1) {
    const guest = await admitGuest(relay, `guest${index}`, `guest${index}`);
    assert.equal(relay.peers[index].slot, index, `guest ${index} takes slot ${index}`);
    // The guest reads its own `welcome` — the referee addressed it to the guest, over the channel.
    assert.ok(guest.guestFrames.some((frame) => frame.t === 'welcome' && frame.slot === index));
    // Every arrival re-broadcasts the roster and the stage, exactly like the Node relay.
    assert.ok(guest.guestFrames.some((frame) => frame.t === 'roster'));
    assert.ok(guest.guestFrames.some((frame) => frame.t === 'stage'));
    // And the host sees the guest's own frames go past — the tap the referee reads through.
    assert.deepEqual(
      guest.inbound.map((frame) => frame.t),
      ['hello'],
      'the host observes what the guest sent, and nothing the referee sent back',
    );
  }
  assert.equal(relay.peers.length, 4);
  relay.close();
});

test('a fifth guest is refused, and closing a channel frees its slot', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12' });
  await admitHost(relay);

  const guests = [];
  for (let index = 1; index <= 3; index += 1) {
    guests.push(await admitGuest(relay, `guest${index}`, `guest${index}`));
  }

  const late = await admitGuest(relay, 'overflow', 'late');
  const reject = late.guestFrames.find((frame) => frame.t === 'reject');
  assert.ok(reject, 'the fifth peer is told why');
  assert.equal(reject.code, 'full');
  assert.equal(relay.peers.length, 4);

  // A phone locking its screen closes the channel. The slot must come back immediately, because a
  // roster that keeps a ghost is a room that refuses a real player for the rest of the match.
  guests[1].guestSocket.close();
  await settle();
  assert.equal(relay.peers.length, 3);
  assert.equal(relay.peers.some((peer) => peer.slot === 2), false);

  const back = await admitGuest(relay, 'rejoin', 'guest2');
  assert.ok(
    back.guestFrames.some((frame) => frame.t === 'welcome' && frame.slot === 2),
    'the freed slot is reused, lowest first',
  );
  relay.close();
});

test('the relay relays inputs verbatim to everyone but the author', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12' });
  const host = await admitHost(relay);
  const guest1 = await admitGuest(relay, 'guest1', 'guest1');
  const guest2 = await admitGuest(relay, 'guest2', 'guest2');

  const input = { x: 0.375, z: 0, atk: 'jab', st: 'neutral', gd: 'none', dg: 'none' };
  guest1.say({ t: 'input', tick: 42, slot: 1, input });
  await settle();

  const inputs = (frames) => frames.filter((frame) => frame.t === 'input');
  assert.equal(inputs(guest2.guestFrames).length, 1, 'the other guest heard it');
  assert.equal(inputs(guest1.guestFrames).length, 0, 'the author never hears its own input');
  assert.equal(inputs(host.frames).length, 1, 'and the host heard it too, like any other peer');
  assert.equal(inputs(guest2.guestFrames)[0].tick, 42);
  assert.equal(
    inputs(guest2.guestFrames)[0].input.x,
    0.375,
    'quantised on the wire, exactly as over a LAN',
  );

  // The host hearing it through its own ordinary client is the whole reason there is no separate
  // "watch the guests" hook: one delivery, one code path, and a P2P host feeds its rollback session
  // through exactly the same handler a guest does.
  assert.deepEqual(
    inputs(guest1.inbound).map((frame) => frame.t),
    ['input'],
    'the guest sent exactly one input, and the referee never echoed it back to them',
  );

  // A peer may only speak for its own fighter. Spoofing another slot is refused outright — this is
  // the gate that stops a guest driving somebody else's combo.
  guest2.say({ t: 'input', tick: 43, slot: 1, input });
  await settle();
  assert.equal(inputs(guest1.guestFrames).length, 0, 'a spoofed slot reaches nobody');
  assert.equal(inputs(host.frames).length, 1, 'and the host does not hear it either');
  assert.equal(
    inputs(guest2.inbound).length,
    1,
    'the spoofing guest sent it and the referee dropped it — nobody was told to act on it',
  );
  relay.close();
});

test('the relay audits state hashes and reports a disagreement without resolving it', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12' });
  const host = await admitHost(relay);
  const guest = await admitGuest(relay, 'guest1', 'guest1');

  host.say({ t: 'sync', tick: 900, hash: 'a1b2c3d4' });
  guest.say({ t: 'sync', tick: 900, hash: 'ffffffff' });
  await settle();

  const desync = host.frames.find((frame) => frame.t === 'desync');
  assert.ok(desync, 'a disagreement is broadcast to everyone');
  assert.equal(desync.tick, 900);
  assert.equal(desync.claims.length, 2);
  assert.deepEqual(
    desync.claims.map((claim) => claim.slot),
    [0, 1],
  );
  assert.equal(guest.guestFrames.filter((frame) => frame.t === 'desync').length, 1);
  assert.equal(
    desync.claims.find((claim) => claim.slot === 0).hash,
    'a1b2c3d4',
    "the host's own hash is in the report — the referee does not pick a winner",
  );
  assert.equal(
    desync.claims.find((claim) => claim.slot === 1).hash,
    'ffffffff',
    'nor is the guest’s, and neither is marked as the wrong one',
  );

  // A third peer disagreeing about a tick that was already reported must not re-broadcast: a
  // rollback re-reports hashes, and a desync banner that re-fires every tick is a banner nobody
  // reads. First claim per slot also wins, so a peer cannot overwrite its own earlier hash.
  const guest2 = await admitGuest(relay, 'guest2', 'guest2');
  guest2.say({ t: 'sync', tick: 900, hash: 'deadbeef' });
  guest.say({ t: 'sync', tick: 900, hash: '99999999' });
  await settle();
  assert.equal(host.frames.filter((frame) => frame.t === 'desync').length, 1);
  assert.equal(desync.claims.length, 2, 'the report is a snapshot, not a running tally');

  // A *different* tick is a different disagreement and is reported in its own right.
  host.say({ t: 'sync', tick: 901, hash: '11111111' });
  guest.say({ t: 'sync', tick: 901, hash: '22222222' });
  await settle();
  assert.equal(host.frames.filter((frame) => frame.t === 'desync').length, 2);
  relay.close();
});

test('the relay starts the match once everyone is ready, and only once', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12', stage: 'parking', seed: 7 });
  const host = await admitHost(relay);
  const guest = await admitGuest(relay, 'guest1', 'guest1');

  host.say({ t: 'ready', slot: 0, ready: true });
  await settle();
  assert.equal(guest.guestFrames.filter((frame) => frame.t === 'start').length, 0, 'one ready is not a start');

  guest.say({ t: 'ready', slot: 1, ready: true });
  await settle();
  const starts = guest.guestFrames.filter((frame) => frame.t === 'start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].stage, 'parking');
  assert.equal(starts[0].seed, 7);

  // The latch is what stops a peer that readies up twice from restarting the match mid-fight.
  host.say({ t: 'ready', slot: 0, ready: false });
  host.say({ t: 'ready', slot: 0, ready: true });
  await settle();
  assert.equal(guest.guestFrames.filter((frame) => frame.t === 'start').length, 1);
  relay.close();
});

test('a peer that never says hello is dropped by the sweep, not by patience', async () => {
  let now = 1_000;
  const relay = hostRelay({ roomCode: 'UR-AB12', now: () => now });
  const [silentEnd] = MockDataChannel.pair('silent', 'silent-remote');
  silentEnd.openUp();
  relay.attachDataChannel(silentEnd);
  await settle();
  assert.equal(relay.peers.length, 1, 'connected but not admitted');

  now += 60_000;
  relay.sweep();
  assert.equal(relay.peers.length, 0, 'a silent channel is reaped');

  // And a P2P room advertises no LAN address, because a guest never dials one.
  const second = hostRelay({ roomCode: 'UR-CD34' });
  const host = await admitHost(second, 'host', 'UR-CD34');
  host.say({ t: 'lan-ip', v: PROTOCOL_VERSION });
  await settle();
  const reply = host.frames.find((frame) => frame.t === 'lan-ip-reply');
  assert.ok(reply);
  assert.deepEqual(reply.urls, [], 'no addresses to advertise — peers connect, they do not dial');
  second.close();
});

test('closing the relay refuses every peer and is idempotent', async () => {
  const relay = hostRelay({ roomCode: 'UR-AB12' });
  const host = await admitHost(relay);

  relay.close('host left');
  relay.close('host left');
  await settle();
  const reject = host.frames.find((frame) => frame.t === 'reject');
  assert.ok(reject, 'a peer mid-match is told the host went away');
  assert.equal(reject.reason, 'host left');
  assert.equal(relay.peers.length, 0);
});

test('the linked socket pair is a real open socket to both of its ends', async () => {
  const [referee, client] = createLinkedSocketPair();
  assert.equal(referee.readyState, SOCKET_OPEN);
  assert.equal(client.readyState, SOCKET_OPEN);

  let opened = false;
  client.onopen = () => {
    opened = true;
  };
  const received = [];
  referee.onmessage = (event) => received.push(event.data);
  client.send('ping');
  await settle();

  assert.equal(opened, true, 'onopen is delivered, just not synchronously');
  assert.deepEqual(received, ['ping']);

  client.close(1000, 'bye');
  await settle();
  assert.equal(client.readyState, SOCKET_CLOSED);
  assert.equal(referee.readyState, SOCKET_CLOSED, 'a close is visible on both ends');
});

// -------------------------------------------------------------------------------------------
// End to end: host, guest, broker, negotiation, and a real LanClient
// -------------------------------------------------------------------------------------------

test('a guest joins a hosted room over a negotiated data channel and plays it', async () => {
  const broker = createBroker();
  const hostPc = new MockPeerConnection();
  const guestPc = new MockPeerConnection();
  MockPeerConnection.connect(hostPc, guestPc);

  const guests = [];
  const host = new InBrowserP2pHost({
    roomCode: 'UR-AB12',
    name: 'host',
    signalUrl: 'ws://broker.test/signal',
    log: () => {},
    createSocket: broker.createSocket,
    createPeerConnection: () => hostPc,
    onGuest: (handle) => guests.push(handle),
  });
  assert.equal(host.roomCode, 'UR-AB12');
  assert.equal(host.start(), true);
  await settle();

  // The host's own client: slot 0, through an in-memory socket into its own referee. Identical path
  // to a guest's, because the host is just another peer to the room.
  const localHandle = host.relay.attachLocal();
  const localClient = new LanClient({
    url: 'ws://in-browser/relay',
    name: 'host',
    room: 'UR-AB12',
    createSocket: () => localHandle.socket,
  });
  localClient.connect();
  await settle();
  assert.equal(localClient.state, 'lobby');
  assert.equal(localClient.slot, 0);

  // Now the guest: announce, receive the offer, answer, and get a channel.
  //
  // The client is built *inside* `onChannel`, which is what the browser does too. It matters: by the
  // time negotiation finishes the channel is already open, and the adapter replays `open` on a
  // microtask — so a client created a turn later would never hear it and would sit in "connecting"
  // forever, having never sent its `hello`.
  let guestClient = null;
  const guest = new InBrowserP2pGuest({
    roomCode: 'ur-ab12',
    name: 'phone',
    signalUrl: 'ws://broker.test/signal',
    log: () => {},
    createSocket: broker.createSocket,
    createPeerConnection: () => guestPc,
    onChannel: (socket) => {
      // A real `LanClient`, over a real `WebRtcDataChannelSocket`, into a real in-browser referee.
      guestClient = new LanClient({
        url: 'ws://in-browser/relay',
        name: 'phone',
        room: 'UR-AB12',
        createSocket: () => socket,
      });
      guestClient.connect();
    },
  });
  assert.equal(guest.roomCode, 'UR-AB12');
  assert.equal(guest.start(), true);
  await settle(12);

  assert.ok(guestClient !== null, 'the guest received a data channel from the negotiated answer');
  assert.equal(guests.length, 1, 'the host admitted exactly one guest');
  assert.equal(host.peers.length, 2, 'slot 0 is the host, slot 1 is the guest');
  await settle(12);

  assert.equal(guestClient.state, 'lobby', 'the guest was admitted');
  assert.equal(guestClient.slot, 1);
  assert.deepEqual(
    guestClient.roster.filter((entry) => entry.connected).map((entry) => entry.slot),
    [0, 1],
  );

  // And the lockstep round trip: the guest's input reaches the host, the host's reaches the guest.
  const receivedByHost = [];
  localClient.on('input', (message) => receivedByHost.push(message));
  const receivedByGuest = [];
  guestClient.on('input', (message) => receivedByGuest.push(message));

  guestClient.sendInput(7, { moveX: 0.375, moveZ: 0, attack: null, stance: 'neutral', guard: 'none', dodge: 'none' });
  localClient.sendInput(7, { moveX: -0.5, moveZ: 0, attack: null, stance: 'up', guard: 'none', dodge: 'none' });
  await settle(12);

  assert.equal(receivedByHost.length, 1, "the host heard the guest's input");
  assert.equal(receivedByHost[0].slot, 1);
  assert.equal(receivedByHost[0].tick, 7);
  assert.equal(receivedByHost[0].input.x, 0.375, 'quantised on the wire, exactly as over a LAN');
  assert.equal(receivedByGuest.length, 1, "the guest heard the host's input");
  assert.equal(receivedByGuest[0].slot, 0);

  // A desync between the two hashes is still caught, in-browser, by the same referee. Register the
  // listener first this time — a rollback re-reports hashes, and a missing listener would make the
  // audit look like it never fired.
  const hostSawDesync = [];
  localClient.on('desync', (message) => hostSawDesync.push(message));
  localClient.sendSync(500, 'abcd1234');
  guestClient.sendSync(500, 'ffff0000');
  await settle(12);

  assert.equal(hostSawDesync.length, 1, 'two browsers, two hashes, one broadcast');
  assert.equal(hostSawDesync[0].tick, 500);
  assert.equal(host.peers.length, 2, 'reporting a desync does not evict anybody');

  guest.close();
  host.close();
  await settle();
  assert.equal(guestClient.state, 'closed', 'a closing guest is a closed client, not a hang');
  assert.equal(localClient.state, 'closed');
});

test('P2P refuses to start without WebRTC or a broker, and says so', () => {
  const host = new InBrowserP2pHost({
    roomCode: 'UR-AB12',
    log: () => {},
    createSocket: () => {
      throw new Error('no socket');
    },
    onGuest: () => {},
  });
  assert.equal(host.start(), false);
  assert.match(host.status, /no WebSocket/);
  host.close();

  // No RTCPeerConnection: the host still admits nobody and stays a usable object rather than
  // throwing from inside a click handler.
  const solo = new InBrowserP2pHost({
    roomCode: 'UR-CD34',
    log: () => {},
    createPeerConnection: () => null,
    onGuest: () => {},
  });
  assert.equal(solo.relay.peers.length, 0);
  solo.close();
});

test('the data channel label is stable, so a mismatched build cannot connect silently', () => {
  assert.equal(DATA_CHANNEL_LABEL, 'urban-reign');
});