/**
 * Reference signaling broker — `npm run signal-broker`.
 *
 * ## What this is
 *
 * The smallest thing that can work. WebRTC peers cannot find each other on their own, so for about
 * two seconds somebody has to introduce them. That somebody is a broker: it forwards opaque frames
 * between the members of a room and understands nothing else.
 *
 * This file exists because "point `?signal=` at a public broker" is an answer, not a plan — public
 * brokers get rate-limited, change their API, or shut down, and a game whose lobby dies with them is
 * a game that cannot be played at a friend's house. It is ~40 lines on purpose: if this ever needs to
 * grow state, it has stopped being a broker and become a server, which is precisely what the P2P
 * path exists to avoid.
 *
 * ## The contract
 *
 * Every frame carries its room (`src/net/webrtc.ts`, `SignalMessage`), so a broker only has to:
 *
 *   1. put each socket in the room named by its first frame,
 *   2. forward every frame to the rest of that room, and
 *   3. drop the socket's room membership when it closes.
 *
 * It never parses `offer`, `answer` or `ice`, never sees gameplay, and holds nothing after a frame is
 * forwarded. If you want to prove that, read `test/webrtc.test.mjs`'s `createBroker()` — the tests
 * run the real host and guest classes against exactly this policy, in memory.
 *
 * ## Usage
 *
 *   npm run signal-broker                 # ws://0.0.0.0:8766
 *   npm run signal-broker -- --port 9000
 *
 * Then point a browser at it. On the machine running it:
 *
 *   http://localhost:5173/?signal=ws://127.0.0.1:8766
 *
 * and from a phone on the same Wi-Fi (this is the part that matters — a loopback URL on the host is
 * not reachable from a phone):
 *
 *   http://192.168.1.42:5173/?signal=ws://192.168.1.42:8766
 */

import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';

/** Default port. Separate from the relay's 8765 on purpose: they solve different problems. */
const DEFAULT_SIGNAL_PORT = 8766;

/** Frames larger than this are refused before they are parsed. An SDP blob runs to a few KiB. */
const MAX_SIGNAL_BYTES = 16384;

/** Rooms longer than this are refused; a room code is `UR-XXXX`. */
const MAX_ROOM_LENGTH = 32;

function readPort(argv) {
  const at = argv.indexOf('--port');
  if (at >= 0 && at + 1 < argv.length) {
    const port = Number.parseInt(argv[at + 1], 10);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_SIGNAL_PORT;
  }
  return DEFAULT_SIGNAL_PORT;
}

/** Every non-internal IPv4 address this machine can be reached on, for the print-out. */
function reachableAddresses() {
  const out = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family;
      const isIpv4 = family === 'IPv4' || family === 4;
      if (isIpv4 && entry.internal !== true && typeof entry.address === 'string') {
        out.push(entry.address);
      }
    }
  }
  return out.sort();
}

/**
 * Join the room named in the first frame, and forward everything to everyone else in it.
 *
 * Returns true when the frame was forwarded. A socket that never names a usable room is in no room,
 * so its frames go nowhere — which is the honest failure for a broker that cannot parse a frame.
 */
function route(ws, raw) {
  const text = typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '';
  if (text.length === 0 || text.length > MAX_SIGNAL_BYTES) {
    return false;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return false; // not our problem to understand, and not ours to forward blindly
  }
  const claimed = message?.room;
  if (typeof claimed !== 'string' || claimed.length === 0 || claimed.length > MAX_ROOM_LENGTH) {
    return false;
  }

  // A socket may only be in the room it first claimed. Moving rooms mid-session would let one peer
  // announce a room and then start receiving another room's offers, which is a room hijack.
  if (ws.rooms.size === 0) {
    ws.rooms.add(claimed);
    let members = rooms.get(claimed);
    if (members === undefined) {
      members = new Set();
      rooms.set(claimed, members);
    }
    members.add(ws);
  }
  if (!ws.rooms.has(claimed)) {
    return false;
  }

  for (const member of rooms.get(claimed) ?? []) {
    if (member !== ws && member.readyState === WebSocket.OPEN) {
      member.send(text);
    }
  }
  return true;
}

const port = readPort(process.argv.slice(2));
const rooms = new Map();
const wss = new WebSocketServer({ host: '0.0.0.0', port });

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.on('message', (data) => {
    route(ws, data);
  });
  ws.on('close', () => {
    for (const room of ws.rooms ?? []) {
      const members = rooms.get(room);
      members?.delete(ws);
      if (members !== undefined && members.size === 0) {
        rooms.delete(room);
      }
    }
    ws.rooms.clear();
  });
  ws.on('error', () => {
    // A peer that fails mid-handshake is a normal event; `close` does the cleanup.
  });
});

wss.on('listening', () => {
  console.log(`signaling broker listening on ws://0.0.0.0:${port}`);
  console.log('  point a browser at it with ?signal=ws://<host>:' + port);
  for (const address of reachableAddresses()) {
    console.log(`  from the house LAN: http://<this-page>?signal=ws://${address}:${port}`);
  }
  console.log('  rooms hold no state and are forgotten the moment the last peer leaves');
});

wss.on('error', (error) => {
  console.error(`signaling broker error: ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    wss.close(() => process.exit(0));
  });
}