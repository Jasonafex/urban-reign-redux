/**
 * House-LAN relay server (AGENTS.md §3.3).
 *
 * One process per house, listening on `8765`, that does three jobs and deliberately no others:
 *
 *   1. **Room lifecycle** — assigns the lowest free slot to each peer that says `hello`, broadcasts
 *      the roster on every change, and frees the slot when a socket drops.
 *   2. **Lockstep broadcast** — relays `input` packets to every *other* peer. It is a wire, not a
 *      referee: it never inspects, reorders, buffers or rewrites an input. The moment the relay
 *      starts making decisions about gameplay, rollback stops being the source of truth and the
 *      server becomes a single point of failure for four people in a living room.
 *   3. **Desync audit** — collects each peer's `stateHash()` per tick and, when two peers disagree,
 *      broadcasts both hashes. It reports the disagreement; it does not resolve it.
 *
 * The relay is deliberately *not* part of the simulation's trust boundary. `src/net/rollback.ts`
 * and `src/net/protocol.ts` are pure and headless; this file is the only piece that needs Node's
 * socket stack, and nothing in `src/sim`, `src/combat` or `src/core` imports it.
 *
 * ## Wall-clock use is allowed here
 *
 * This is a transport, not a tick. It reads a clock for peer timeouts and ping probes, which is
 * exactly the wall-clock use AGENTS.md §3.2 forbids *inside physics, combat and input buffering*.
 * No hash, no input and no state in this file depends on when a packet arrived.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  decodeMessage,
  joinUrls,
  selectLanIPv4,
  tryEncodeMessage,
  type HashClaim,
  type NetMessage,
  type NetworkInterfaces,
  type RosterEntry,
} from './protocol';

/** Ticks of audit history kept. A peer that is 2 seconds behind has already lost the match. */
export const AUDIT_WINDOW_TICKS = 120;

/** Default port the *web client* is served on (see `vite.config.ts`). */
export const DEFAULT_WEB_PORT = 5173;

/** A peer that connects but never says `hello` is dropped after this long. */
export const HANDSHAKE_TIMEOUT_MS = 8000;

export interface RelayPeer {
  readonly id: string;
  readonly socket: WebSocket;
  slot: number;
  name: string;
  ready: boolean;
  /** False once the socket has dropped; the slot is freed at the same moment. */
  connected: boolean;
  /** Wall-clock ms of the last frame received, for the idle sweep. */
  lastSeenMs: number;
  /** Wall-clock ms this peer joined. */
  joinedMs: number;
}

export interface RelayPeerSummary {
  readonly id: string;
  readonly slot: number;
  readonly name: string;
  readonly ready: boolean;
}

export interface RelayAddress {
  readonly port: number;
  readonly host: string;
  /** LAN IPv4 addresses other devices in the house can dial. */
  readonly ips: readonly string[];
  /** Join URLs encoding the *web client* (not the relay) — these are what the QR code shows. */
  readonly joinUrls: readonly string[];
}

export interface RelayServerOptions {
  readonly port?: number;
  /** Bind address. Defaults to all interfaces so a phone on the Wi-Fi can reach it. */
  readonly host?: string;
  readonly maxPlayers?: number;
  readonly stage?: string;
  readonly seed?: number;
  /** Port the game page is served on, used to build join URLs. Defaults to `DEFAULT_WEB_PORT`. */
  readonly webPort?: number;
  /** Idle/timeout sweep period in ms. Defaults to 2000. */
  readonly sweepIntervalMs?: number;
  /** Clock injection point for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Log sink. Defaults to `console.log`; pass `() => {}` for silence in tests. */
  readonly log?: (message: string) => void;
}

interface AuditTick {
  readonly claims: Map<number, string>;
  reported: boolean;
}

export class LanRelayServer {
  private readonly wss: WebSocketServer;
  private readonly host: string;
  private readonly port: number;
  private readonly maxPlayers: number;
  private readonly stage: string;
  private readonly seed: number;
  private readonly webPort: number;
  private readonly sweepMs: number;
  private readonly clock: () => number;
  private readonly log: (message: string) => void;

  private readonly bySocket = new Map<WebSocket, RelayPeer>();
  private readonly byId = new Map<string, RelayPeer>();
  private readonly audit = new Map<number, AuditTick>();

  private nextId = 1;
  private highestTick = 0;
  /**
   * Latched once every peer readies up, so `start` goes out exactly once per ready-cycle.
   *
   * Kept separate from `listening` on purpose: these two used to share a flag, which meant the
   * first match in a house silently un-started the listener and made `start()` a no-op for
   * everyone who joined afterwards.
   */
  private matchAnnounced = false;
  private listening = false;
  private stopped = false;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private boundAddress: RelayAddress | null = null;

  constructor(options: RelayServerOptions = {}) {
    this.port = options.port ?? DEFAULT_RELAY_PORT;
    this.host = options.host ?? '0.0.0.0';
    this.maxPlayers = Math.min(options.maxPlayers ?? MAX_PLAYERS, MAX_PLAYERS);
    this.stage = options.stage ?? 'alley';
    this.seed = options.seed ?? 0;
    this.webPort = options.webPort ?? DEFAULT_WEB_PORT;
    this.sweepMs = options.sweepIntervalMs ?? 2000;
    this.clock = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message: string) => console.log(message));
    this.wss = new WebSocketServer({ host: this.host, port: this.port });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.wss.on('error', (error: Error) => this.log(`relay error: ${error.message}`));
  }

  /** Start listening. Resolves with the bound address, including the real port when asked for 0. */
  async start(): Promise<RelayAddress> {
    if (this.listening) {
      return this.requireAddress();
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.wss.once('error', onError);
      this.wss.once('listening', () => {
        this.wss.removeListener('error', onError);
        resolve();
      });
    });

    const address = this.wss.address();
    const boundPort = typeof address === 'object' && address !== null ? (address as AddressInfo).port : this.port;
    const ips = selectLanIPv4(networkInterfacesSnapshot());
    this.boundAddress = {
      port: boundPort,
      host: this.host,
      ips: Object.freeze([...ips]),
      joinUrls: Object.freeze(joinUrls(ips, this.webPort)),
    };

    this.listening = true;
    this.stopped = false;
    this.sweepHandle = setInterval(() => this.sweep(), this.sweepMs);
    // Do not hold the process open just for the sweep; the listening socket does that. Guarded
    // because `setInterval` is typed by the DOM lib here (which returns a number, with no
    // `unref`) even though at runtime under Node it returns a Timeout.
    (this.sweepHandle as unknown as { unref?: () => void }).unref?.();

    this.log(`relay listening on ws://${this.host}:${boundPort} (web ${this.webPort})`);
    for (const url of this.boundAddress.joinUrls) {
      this.log(`  join: ${url}`);
    }
    return this.boundAddress;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.sweepHandle !== null) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    for (const peer of [...this.bySocket.values()]) {
      this.send(peer, { t: 'reject', code: 'protocol', reason: 'relay shutting down' });
      peer.socket.close(1001, 'relay shutting down');
    }
    this.bySocket.clear();
    this.byId.clear();
    this.audit.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    this.listening = false;
  }

  get address(): RelayAddress | null {
    return this.boundAddress;
  }

  get joinUrls(): readonly string[] {
    return this.boundAddress?.joinUrls ?? Object.freeze([]);
  }

  get peers(): readonly RelayPeerSummary[] {
    return Object.freeze(
      [...this.bySocket.values()]
        .filter((peer) => peer.connected)
        .map((peer) => ({ id: peer.id, slot: peer.slot, name: peer.name, ready: peer.ready }))
        .sort((a, b) => a.slot - b.slot),
    );
  }

  /** Highest tick any peer has claimed. Used to prune the audit window. */
  get currentTick(): number {
    return this.highestTick;
  }

  /**
   * Drop peers that went quiet, and prune audit history.
   *
   * Public so `server-cli.ts` can drive it on its own timer, and so `test/lan.test.mjs` can force a
   * sweep with a fake clock instead of sleeping.
   */
  sweep(): void {
    const now = this.clock();
    for (const peer of [...this.bySocket.values()]) {
      if (!peer.connected) {
        continue;
      }
      const idle = now - peer.lastSeenMs;
      if (peer.slot < 0) {
        // Connected but never said `hello`.
        if (idle > HANDSHAKE_TIMEOUT_MS) {
          this.log(`dropping ${peer.id}: no hello within ${HANDSHAKE_TIMEOUT_MS}ms`);
          this.dropPeer(peer, 'no hello');
        }
        continue;
      }
      if (idle > HANDSHAKE_TIMEOUT_MS * 4) {
        this.dropPeer(peer, 'timed out');
      }
    }
    this.pruneAudit();
  }

  /** Broadcast the current roster to everyone. */
  broadcastRoster(): void {
    const entries: RosterEntry[] = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      const peer = [...this.bySocket.values()].find((candidate) => candidate.connected && candidate.slot === slot);
      entries.push(
        peer === undefined
          ? { slot, name: '', connected: false }
          : { slot, name: peer.name, connected: true },
      );
    }
    this.broadcast({ t: 'roster', entries: Object.freeze(entries) });
  }

  // -----------------------------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const now = this.clock();
    const peer: RelayPeer = {
      id: `p${this.nextId++}`,
      socket,
      slot: -1,
      name: '',
      ready: false,
      connected: true,
      lastSeenMs: now,
      joinedMs: now,
    };
    this.bySocket.set(socket, peer);
    this.byId.set(peer.id, peer);

    socket.on('message', (data: unknown) => this.onMessage(peer, data));
    socket.on('close', () => this.dropPeer(peer, 'closed'));
    socket.on('error', () => this.dropPeer(peer, 'socket error'));
  }

  private onMessage(peer: RelayPeer, data: unknown): void {
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
      case 'lan-ip':
        this.send(peer, {
          t: 'lan-ip-reply',
          port: this.boundAddress?.port ?? this.port,
          urls: this.joinUrls,
        });
        return;
      default:
        break;
    }

    // Everything below requires an admitted peer. An unauthenticated socket cannot inject an
    // `input` for someone else's slot, which is the whole reason for the gate.
    if (!peer.connected || peer.slot < 0) {
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

  private onHello(
    peer: RelayPeer,
    message: Extract<NetMessage, { t: 'hello' }>,
  ): void {
    if (peer.connected && peer.slot >= 0) {
      return; // already admitted; a second `hello` is ignored rather than reassigning a slot
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.send(peer, {
        t: 'reject',
        code: 'version',
        reason: `protocol v${message.v} != v${PROTOCOL_VERSION}`,
      });
      peer.socket.close(1002, 'protocol version');
      return;
    }
    const slot = this.freeSlot();
    if (slot < 0) {
      this.send(peer, { t: 'reject', code: 'full', reason: 'all four slots are taken' });
      peer.socket.close(1013, 'room full');
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

  private onInput(peer: RelayPeer, message: Extract<NetMessage, { t: 'input' }>): void {
    if (message.slot !== peer.slot) {
      return; // a peer may only speak for its own fighter
    }
    if (message.tick <= this.highestTick - AUDIT_WINDOW_TICKS) {
      return; // too old to matter; rebroadcasting it would only cost bandwidth
    }
    if (message.tick > this.highestTick) {
      this.highestTick = message.tick;
      this.pruneAudit();
    }
    // Relay verbatim, to everyone except the author.
    this.broadcast(message, peer.id);
  }

  private onReady(peer: RelayPeer, message: Extract<NetMessage, { t: 'ready' }>): void {
    if (message.slot !== peer.slot) {
      return;
    }
    peer.ready = message.ready;
    this.broadcast({ t: 'ready', slot: peer.slot, ready: message.ready });
    this.maybeStart();
  }

  private onSync(peer: RelayPeer, message: Extract<NetMessage, { t: 'sync' }>): void {
    const tick = message.tick;
    let entry = this.audit.get(tick);
    if (entry === undefined) {
      entry = { claims: new Map<number, string>(), reported: false };
      this.audit.set(tick, entry);
    }
    // First claim for a slot wins: a later, contradictory claim from the *same* peer is a
    // rollback artefact (the peer re-reported a corrected hash for a tick it had already sent),
    // not evidence of divergence.
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
    if (this.matchAnnounced) {
      return;
    }
    const roster = this.peers;
    if (roster.length === 0 || !roster.every((peer) => peer.ready)) {
      return;
    }
    this.matchAnnounced = true;
    this.broadcast({ t: 'start', tick: 0, stage: this.stage, seed: this.seed });
    this.log('all peers ready — start');
  }

  private freeSlot(): number {
    const taken = new Set([...this.bySocket.values()].map((peer) => peer.slot));
    // `maxPlayers` rather than `MAX_PLAYERS`, so a relay deliberately configured for a two-player
    // living-room duel actually refuses a third `hello` instead of accepting it into a slot it can
    // never start a match in.
    for (let slot = 0; slot < this.maxPlayers; slot += 1) {
      if (!taken.has(slot)) {
        return slot;
      }
    }
    return -1;
  }

  private dropPeer(peer: RelayPeer, reason: string): void {
    if (!peer.connected) {
      return;
    }
    peer.connected = false;
    peer.ready = false;
    if (this.bySocket.get(peer.socket) === peer) {
      this.bySocket.delete(peer.socket);
    }
    if (this.byId.get(peer.id) === peer) {
      this.byId.delete(peer.id);
    }
    if (peer.slot >= 0) {
      this.log(`${peer.name || peer.id} left slot ${peer.slot} (${reason})`);
      // Re-arm the start latch: a player who reconnects and readies up again should be able to
      // restart the room rather than being told the match already began an hour ago.
      this.matchAnnounced = false;
      this.broadcastRoster();
    }
  }

  private pruneAudit(): void {
    const cutoff = this.highestTick - AUDIT_WINDOW_TICKS;
    if (cutoff <= 0) {
      return;
    }
    for (const tick of this.audit.keys()) {
      if (tick < cutoff) {
        this.audit.delete(tick);
      }
    }
  }

  private send(peer: RelayPeer, message: NetMessage): void {
    const text = tryEncodeMessage(message);
    if (text === null) {
      return;
    }
    try {
      peer.socket.send(text);
    } catch {
      // The socket is going away; `close` will clean up.
    }
  }

  private broadcast(message: NetMessage, exceptPeerId?: string): void {
    const text = tryEncodeMessage(message);
    if (text === null) {
      return;
    }
    for (const peer of this.bySocket.values()) {
      if (!peer.connected || peer.id === exceptPeerId) {
        continue;
      }
      try {
        peer.socket.send(text);
      } catch {
        // See `send`.
      }
    }
  }

  private requireAddress(): RelayAddress {
    if (this.boundAddress === null) {
      throw new Error('Relay has no bound address; call start() first.');
    }
    return this.boundAddress;
  }
}

/**
 * `os.networkInterfaces()` behind a seam.
 *
 * Exported so `test/lan.test.mjs` can gate address *selection* against a fixed fixture instead of
 * whatever network the machine running the tests happens to be on — a CI box on a VPN would
 * otherwise silently change which addresses the relay advertises.
 */
export function networkInterfacesSnapshot(): NetworkInterfaces {
  return networkInterfaces() as NetworkInterfaces;
}