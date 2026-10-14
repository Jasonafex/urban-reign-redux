/**
 * The room referee — slot allocation, roster, lockstep broadcast and the desync audit.
 *
 * ## Why this exists as its own module
 *
 * Phase 6 makes it possible for the *first browser* to host a four-player room with no Node process
 * anywhere, which means the referee has to exist in two transports at once: `src/net/server.ts`
 * (a `ws` relay on the house LAN) and `src/net/webrtc.ts` (an in-browser relay reached over
 * `RTCDataChannel`s). Both must behave identically, down to which slot a fourth guest gets and
 * which side of a `desync` broadcast a hash appears on.
 *
 * Two copies of those rules would be a live desync bug waiting for a house with two LAN tablets and
 * a laptop on Wi-Fi — one room assigning slots one way, the other the other way, and four people
 * watching three different fights. So the referee lives here, once, and takes a *transport* instead
 * of importing one.
 *
 * ## What this module deliberately does not do
 *
 * It is a wire, not a referee in the gameplay sense. It never inspects an input, never reorders one,
 * never buffers one and never resolves a disagreement. `src/net/rollback.ts` is the source of truth
 * for what a tick means; this file only decides who hears what, and when. That is the same contract
 * the WebSocket relay has always had, and it is why a browser tab can take the job without the
 * game's fairness changing underneath it.
 *
 * ## Headless and side-effect free
 *
 * There is no socket, no clock of its own and no DOM here. The clock is injected (the lobby sweep is
 * wall-clock work and therefore must be fakeable), the transport is injected, and nothing here
 * imports `ws`, `three` or `RTCPeerConnection`. `test/webrtc.test.mjs` drives the whole referee with
 * in-memory sockets and a fake clock, and `test/lan.test.mjs` drives it over a real one.
 */

import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  decodeMessage,
  tryEncodeMessage,
  type HashClaim,
  type NetMessage,
  type RosterEntry,
} from './protocol';

/** Ticks of audit history kept. A peer that is 2 seconds behind has already lost the match. */
export const AUDIT_WINDOW_TICKS = 120;

/** A peer that connects but never says `hello` is dropped after this long. */
export const HANDSHAKE_TIMEOUT_MS = 8000;

/**
 * Everything the referee needs from a connection, and nothing else.
 *
 * Deliberately two methods rather than a `SocketLike`: the host side of a WebRTC room has an
 * in-memory socket, the LAN side has a `ws` socket, and neither should have to pretend to be the
 * other. Encoding is the referee's job, so `send` takes a `NetMessage` and the transport deals with
 * bytes — which is also what keeps `MAX_MESSAGE_BYTES` enforced in exactly one place.
 */
export interface RoomTransport {
  send(message: NetMessage): void;
  close(code?: number, reason?: string): void;
}

/** The LAN answer to `lan-ip`, which a peer asks for so it can render a join QR code. */
export interface RoomLanAddress {
  readonly port: number;
  readonly urls: readonly string[];
}

/** One admitted (or pending) peer. Mutable by the referee, read-only for everyone else. */
export interface RoomPeerSummary {
  readonly id: string;
  readonly slot: number;
  readonly name: string;
  readonly ready: boolean;
}

interface RoomPeer {
  readonly id: string;
  readonly transport: RoomTransport;
  slot: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** Wall-clock ms of the last frame received, for the idle sweep. */
  lastSeenMs: number;
  /** Wall-clock ms this peer joined. */
  joinedMs: number;
}

interface AuditTick {
  readonly claims: Map<number, string>;
  reported: boolean;
}

export interface RoomOptions {
  /** AGENTS.md §5 caps a room at four simultaneous combatants. */
  readonly maxPlayers?: number | undefined;
  readonly stage?: string | undefined;
  readonly seed?: number | undefined;
  /** Audit history depth. Defaults to `AUDIT_WINDOW_TICKS`. */
  readonly auditWindowTicks?: number | undefined;
  /** Wall-clock ms before a silent peer is dropped. Defaults to `HANDSHAKE_TIMEOUT_MS`. */
  readonly handshakeTimeoutMs?: number | undefined;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Log sink. Defaults to `console.log`; pass `() => {}` for silence in tests. */
  readonly log?: ((message: string) => void) | undefined;
  /**
   * Answer to a peer's `lan-ip` request.
   *
   * A WebSocket relay knows its own bind address; an in-browser room does not, because its guests
   * never dial an address — they connect peer-to-peer through a signaling broker — so it leaves this
   * unset and answers with an empty URL list. The client already handles that (`location.href` is
   * the fallback it renders), which is why this is optional rather than required.
   */
  readonly lanAddress?: (() => RoomLanAddress) | undefined;
}

/**
 * The referee. One instance per room.
 *
 * Lifecycle is `addPeer` → `handleMessage`×n → (`disconnectPeer` | `sweep`)×n → `close`. Every entry
 * point is idempotent: dropping an unknown peer, or sweeping an empty room, is a no-op rather than a
 * throw, because a peer that vanishes mid-handshake is an ordinary event on a house network and
 * not something a caller should have to guard against.
 */
export class RoomCoordinator {
  private readonly peers = new Map<string, RoomPeer>();
  private readonly audit = new Map<number, AuditTick>();

  private readonly maxPlayers: number;
  private readonly stage: string;
  private readonly seed: number;
  private readonly auditWindow: number;
  private readonly handshakeTimeoutMs: number;
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  private readonly lanAddress: (() => RoomLanAddress) | null;

  private highestTick = 0;
  private closed = false;
  /**
   * Latched once every peer readies up, so `start` goes out exactly once per ready-cycle.
   *
   * Kept separate from "is this room open" on purpose: the two used to share a flag, which meant the
   * first match in a house silently un-started the listener and made the start broadcast a no-op for
   * everyone who joined afterwards.
   */
  private matchAnnounced = false;
  private nextId = 1;

  constructor(options: RoomOptions = {}) {
    this.maxPlayers = Math.min(options.maxPlayers ?? MAX_PLAYERS, MAX_PLAYERS);
    this.stage = options.stage ?? 'alley';
    this.seed = options.seed ?? 0;
    this.auditWindow = options.auditWindowTicks ?? AUDIT_WINDOW_TICKS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.clock = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message: string) => console.log(message));
    this.lanAddress = options.lanAddress ?? null;
  }

  /** Peers currently connected, in slot order. */
  get peersList(): readonly RoomPeerSummary[] {
    return Object.freeze(
      [...this.peers.values()]
        .filter((peer) => peer.connected)
        .map((peer) => ({ id: peer.id, slot: peer.slot, name: peer.name, ready: peer.ready }))
        .sort((a, b) => a.slot - b.slot),
    );
  }

  /** Highest tick any peer has claimed. Used to prune the audit window. */
  get currentTick(): number {
    return this.highestTick;
  }

  /** Total peers ever admitted, including those who have since left. */
  get admissionCount(): number {
    return this.nextId - 1;
  }

  /**
   * Register a connection.
   *
   * The peer is *pending* until it says `hello`: `slot` is -1 and the sweep will drop it after
   * `handshakeTimeoutMs`. An unauthenticated connection is never trusted with anything but `hello`,
   * `ping` and `lan-ip` — that gate is what stops a peer from injecting an `input` for someone else's
   * fighter.
   */
  addPeer(transport: RoomTransport): string {
    const id = `p${this.nextId++}`;
    const now = this.clock();
    this.peers.set(id, {
      id,
      transport,
      slot: -1,
      name: '',
      ready: false,
      connected: true,
      lastSeenMs: now,
      joinedMs: now,
    });
    return id;
  }

  /** Forget a peer and free its slot. Idempotent, and a no-op for an unknown id. */
  disconnectPeer(id: string, reason: string): void {
    const peer = this.peers.get(id);
    if (peer === undefined || !peer.connected) {
      return;
    }
    peer.connected = false;
    peer.ready = false;
    this.peers.delete(id);
    if (peer.slot >= 0) {
      this.log(`${peer.name || peer.id} left slot ${peer.slot} (${reason})`);
      // Re-arm the start latch: a player who reconnects and readies up again should be able to
      // restart the room rather than being told the match already began an hour ago.
      this.matchAnnounced = false;
      this.broadcastRoster();
    }
  }

  /**
   * Drop peers that went quiet, and prune audit history.
   *
   * Public so a transport can drive it on its own timer, and so a test can force a sweep with a fake
   * clock instead of sleeping.
   */
  sweep(): void {
    if (this.closed) {
      return;
    }
    const now = this.clock();
    for (const peer of [...this.peers.values()]) {
      if (!peer.connected) {
        continue;
      }
      const idle = now - peer.lastSeenMs;
      if (peer.slot < 0) {
        // Connected but never said `hello`.
        if (idle > this.handshakeTimeoutMs) {
          this.log(`dropping ${peer.id}: no hello within ${this.handshakeTimeoutMs}ms`);
          this.disconnectPeer(peer.id, 'no hello');
        }
        continue;
      }
      if (idle > this.handshakeTimeoutMs * 4) {
        this.disconnectPeer(peer.id, 'timed out');
      }
    }
    this.pruneAudit();
  }

  /** The roster every peer currently sees: one entry per slot, always four of them. */
  roster(): readonly RosterEntry[] {
    const entries: RosterEntry[] = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      const peer = [...this.peers.values()].find(
        (candidate) => candidate.connected && candidate.slot === slot,
      );
      entries.push(
        peer === undefined
          ? { slot, name: '', connected: false }
          : { slot, name: peer.name, connected: true },
      );
    }
    return Object.freeze(entries);
  }

  /** Broadcast the current roster to everyone. */
  broadcastRoster(): void {
    this.broadcast({ t: 'roster', entries: this.roster() });
  }

  /**
   * Refuse every remaining peer and stop accepting work.
   *
   * A relay closing while four people are mid-match is a normal event (a tab closed, a laptop
   * lid came down), and every peer deserves the same terminal message the WebSocket relay has
   * always sent rather than a silent disconnect they have to infer from a stalled HUD.
   */
  close(reason = 'room closed'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const peer of [...this.peers.values()]) {
      if (!peer.connected) {
        continue;
      }
      this.send(peer, { t: 'reject', code: 'protocol', reason });
      peer.transport.close(1001, reason);
      peer.connected = false;
    }
    this.peers.clear();
    this.audit.clear();
  }

  /** Handle one raw frame from `id`. A malformed frame is silence, never an exception. */
  handleMessage(id: string, data: unknown): void {
    const peer = this.peers.get(id);
    if (peer === undefined || !peer.connected) {
      return;
    }
    peer.lastSeenMs = this.clock();
    const message = decodeMessage(data);
    if (message === null) {
      return; // silence, per the protocol's "a bad packet is a missing packet" rule
    }

    switch (message.t) {
      case 'hello':
        this.onHello(peer, message);
        return;
      case 'ping':
        this.send(peer, { t: 'pong', seq: message.seq, at: message.at });
        return;
      case 'lan-ip': {
        const address = this.lanAddress?.() ?? { port: 0, urls: [] };
        this.send(peer, {
          t: 'lan-ip-reply',
          port: address.port,
          urls: address.urls.slice(),
        });
        return;
      }
      default:
        break;
    }

    // Everything below requires an admitted peer.
    if (peer.slot < 0) {
      return;
    }

    switch (message.t) {
      case 'input':
        this.onInput(peer, message);
        return;
      case 'ready':
        this.onReady(peer, message);
        return;
      case 'sync':
        this.onSync(peer, message);
        return;
      case 'desync':
        // A peer forwarding someone else's desync claim: treat it as its own hash report.
        this.broadcast(message);
        return;
      default:
        return;
    }
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  private onHello(
    peer: RoomPeer,
    message: Extract<NetMessage, { t: 'hello' }>,
  ): void {
    if (peer.slot >= 0) {
      return; // already admitted; a second `hello` is ignored rather than reassigning a slot
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.send(peer, {
        t: 'reject',
        code: 'version',
        reason: `protocol v${message.v} != v${PROTOCOL_VERSION}`,
      });
      peer.transport.close(1002, 'protocol version');
      peer.connected = false;
      this.peers.delete(peer.id);
      return;
    }
    const slot = this.freeSlot();
    if (slot < 0) {
      this.send(peer, { t: 'reject', code: 'full', reason: 'all four slots are taken' });
      peer.transport.close(1013, 'room full');
      peer.connected = false;
      this.peers.delete(peer.id);
      return;
    }

    peer.slot = slot;
    peer.name = message.name;
    peer.ready = false;
    peer.joinedMs = this.clock();

    this.send(peer, {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      slot,
      room: message.room,
      stage: this.stage,
    });
    this.broadcast({ t: 'stage', stage: this.stage, seed: this.seed });
    this.broadcastRoster();
    this.log(`${peer.name} joined slot ${slot} (${peer.id})`);
  }

  private onInput(peer: RoomPeer, message: Extract<NetMessage, { t: 'input' }>): void {
    if (message.slot !== peer.slot) {
      return; // a peer may only speak for its own fighter
    }
    if (message.tick <= this.highestTick - this.auditWindow) {
      return; // too old to matter; rebroadcasting it would only cost bandwidth
    }
    if (message.tick > this.highestTick) {
      this.highestTick = message.tick;
      this.pruneAudit();
    }
    // Relay verbatim, to everyone except the author.
    this.broadcast(message, peer.id);
  }

  private onReady(peer: RoomPeer, message: Extract<NetMessage, { t: 'ready' }>): void {
    if (message.slot !== peer.slot) {
      return;
    }
    peer.ready = message.ready;
    this.broadcast({ t: 'ready', slot: peer.slot, ready: message.ready });
    this.maybeStart();
  }

  private onSync(peer: RoomPeer, message: Extract<NetMessage, { t: 'sync' }>): void {
    const tick = message.tick;
    let entry = this.audit.get(tick);
    if (entry === undefined) {
      entry = { claims: new Map<number, string>(), reported: false };
      this.audit.set(tick, entry);
    }
    // First claim for a slot wins: a later, contradictory claim from the *same* peer is a rollback
    // artefact (the peer re-reported a corrected hash for a tick it had already sent), not evidence
    // of divergence.
    if (!entry.claims.has(peer.slot)) {
      entry.claims.set(peer.slot, message.hash);
    }

    const hashes = new Set(entry.claims.values());
    if (hashes.size > 1 && !entry.reported) {
      entry.reported = true;
      const claims: HashClaim[] = [...entry.claims.entries()]
        .map(([slot, hash]) => ({ slot, hash }))
        .sort((a, b) => a.slot - b.slot);
      this.log(`DESYNC at tick ${tick}: ${claims.map((c) => `slot${c.slot}=${c.hash}`).join(' ')}`);
      this.broadcast({ t: 'desync', tick, claims: Object.freeze(claims) });
    }
  }

  private maybeStart(): void {
    if (this.matchAnnounced || this.closed) {
      return;
    }
    const roster = this.peersList;
    if (roster.length === 0 || !roster.every((peer) => peer.ready)) {
      return;
    }
    this.matchAnnounced = true;
    this.broadcast({ t: 'start', tick: 0, stage: this.stage, seed: this.seed });
    this.log('all peers ready — start');
  }

  private freeSlot(): number {
    const taken = new Set([...this.peers.values()].map((peer) => peer.slot));
    // `maxPlayers` rather than `MAX_PLAYERS`, so a room deliberately configured for a two-player
    // living-room duel actually refuses a third `hello` instead of accepting it into a slot it can
    // never start a match in.
    for (let slot = 0; slot < this.maxPlayers; slot += 1) {
      if (!taken.has(slot)) {
        return slot;
      }
    }
    return -1;
  }

  private pruneAudit(): void {
    const cutoff = this.highestTick - this.auditWindow;
    if (cutoff <= 0) {
      return;
    }
    for (const tick of this.audit.keys()) {
      if (tick < cutoff) {
        this.audit.delete(tick);
      }
    }
  }

  private send(peer: RoomPeer, message: NetMessage): void {
    // The size budget is enforced *here* rather than in each transport, so the in-memory WebRTC
    // socket and the `ws` socket cannot disagree about what is sendable: an oversized message is
    // dropped here and never reaches either.
    if (tryEncodeMessage(message) === null) {
      return;
    }
    try {
      peer.transport.send(message);
    } catch {
      // The transport is going away; `disconnectPeer` will clean up.
    }
  }

  private broadcast(message: NetMessage, exceptPeerId?: string): void {
    for (const peer of this.peers.values()) {
      if (!peer.connected || peer.id === exceptPeerId) {
        continue;
      }
      this.send(peer, message);
    }
  }
}