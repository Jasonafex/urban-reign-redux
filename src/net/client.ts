/**
 * House-LAN client — the browser half of the relay connection.
 *
 * Owns one socket, the room lifecycle, and latency measurement. It deliberately does *not* touch
 * the simulation: it turns received `input` packets into `RollbackSession.receiveRemoteInput` calls
 * and sends the local player's inputs out, but it never calls `fixedUpdate` itself. Keeping that
 * arrow one-directional is what lets `src/net/rollback.ts` stay a pure, headless, testable engine
 * (AGENTS.md §3.1).
 *
 * ## Headless safety
 *
 * `WebSocket`, `performance.now()` and `document` are all optional. Constructing a `LanClient` in
 * Node is legal and useful — `test/lan.test.mjs` does exactly that with an injected socket — and
 * `connect()` reports `false` rather than throwing when no transport exists. The clock is injected
 * rather than read, because latency measurement is the one thing here that is genuinely
 * wall-clock-dependent and therefore must be fakeable to stay testable.
 */

import {
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeInput,
  isMessageType,
  tryEncodeMessage,
  type HashClaim,
  type NetMessage,
  type RosterEntry,
} from './protocol';
import type { FrameInput } from '../sim/runner';

/** The slice of the `WebSocket` API this client relies on, so a fake can stand in for it. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type ClientState =
  | 'idle'
  | 'connecting'
  /** Socket is open; waiting for the relay's `welcome`. */
  | 'handshaking'
  | 'lobby'
  | 'ready'
  | 'playing'
  | 'rejected'
  | 'closed'
  /** No transport in this environment. Not an error — a desktop with no `WebSocket` global. */
  | 'unavailable';

export interface LatencyStats {
  /** Exponentially weighted moving average of the round trip. */
  readonly rttMs: number;
  /** Median of the sample window; robust to the one 400ms Wi-Fi stall per match. */
  readonly medianMs: number;
  /** Mean absolute deviation from the median. Reads as "how spiky is my link". */
  readonly jitterMs: number;
  /** Samples currently in the window. */
  readonly samples: number;
  /** Highest ping sequence answered so far; 0 before the first reply. */
  readonly lastSeq: number;
}

/** Rolling window of round-trip samples. 32 samples is ~16 s of play at 2 Hz probing. */
export const LATENCY_WINDOW = 32;

export interface LanClientOptions {
  /** Relay URL, or a bare `host:port` to have one built. */
  readonly url: string;
  readonly name?: string;
  readonly room?: string;
  /** Socket constructor. Defaults to the global `WebSocket` when one exists. */
  readonly createSocket?: SocketFactory;
  /** Monotonic clock in milliseconds. Defaults to `performance.now()`, else `Date.now()`. */
  readonly now?: () => number;
  /** Milliseconds between latency probes. Defaults to 1000. */
  readonly pingIntervalMs?: number;
  /** Any non-2xx, non-3xx, non-4xx code. Defaults to `LAN_CLIENT_VERSION`. */
  readonly clientVersion?: number;
}

/**
 * Build `hello.v` from the shared protocol constant.
 *
 * There is one version number in this codebase, `PROTOCOL_VERSION`, and the `hello` envelope's `v`
 * field *is* it. Keeping a second "client version" alongside it would be an invitation to bump one
 * and not the other, which fails silently as a mysterious parse rejection for one peer.
 */

function defaultClock(): () => number {
  if (typeof globalThis.performance === 'object' && typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now.bind(globalThis.performance);
  }
  return () => Date.now();
}

/** `ws://192.168.1.42:8765` from whatever the caller gave us. Accepts host, host:port and full URLs. */
export function relayUrl(url: string, port: number = DEFAULT_RELAY_PORT): string {
  const trimmed = url.trim();
  if (trimmed === '') {
    return `ws://127.0.0.1:${port}`;
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // A bare IPv6 literal has to be bracketed before a port can be appended.
  const needsBrackets = trimmed.includes(':') && !trimmed.startsWith('[');
  const host = needsBrackets ? `[${trimmed}]` : trimmed;
  return `ws://${host}:${port}`;
}

type Handler = (message: NetMessage) => void;

export class LanClient {
  private socket: SocketLike | null = null;
  private readonly factory: SocketFactory | null;
  private readonly clock: () => number;
  private readonly pingEveryMs: number;

  private currentState: ClientState = 'idle';
  private currentSlot = -1;
  private currentRoom: string;
  private currentStage: string;
  private currentRoster: readonly RosterEntry[] = Object.freeze([]);
  private currentSeed = 0;
  private pingSeq = 0;
  private readonly inflight = new Map<number, number>();
  private readonly samples: number[] = [];
  private readonly handlers = new Map<NetMessage['t'], Set<Handler>>();
  private readonly readySlots = new Set<number>();
  private stateListener: ((state: ClientState) => void) | null = null;
  private closedByUs = false;
  private lastPongSeq = 0;
  private lastPingAt = 0;

  readonly clientName: string;
  readonly room: string;
  readonly version: number;
  /** Resolved relay URL, normalised by `relayUrl`. */
  readonly url: string;

  constructor(options: LanClientOptions) {
    this.clientName = options.name ?? 'guest';
    this.room = options.room ?? 'house';
    this.currentRoom = this.room;
    this.currentStage = 'alley';
    this.version = options.clientVersion ?? PROTOCOL_VERSION;
    this.clock = options.now ?? defaultClock();
    this.pingEveryMs = options.pingIntervalMs ?? 1000;
    this.url = relayUrl(options.url);

    const provided = options.createSocket;
    if (provided !== undefined) {
      this.factory = provided;
    } else if (typeof globalThis.WebSocket === 'function') {
      const Ctor = globalThis.WebSocket;
      this.factory = (url) => new Ctor(url) as unknown as SocketLike;
    } else {
      this.factory = null;
    }
  }

  get state(): ClientState {
    return this.currentState;
  }

  /** Slot assigned by the relay, or -1 before `welcome`. */
  get slot(): number {
    return this.currentSlot;
  }

  get stage(): string {
    return this.currentStage;
  }

  /** Room the relay actually admitted us to, which may differ from the one we asked for. */
  get joinedRoom(): string {
    return this.currentRoom;
  }

  get roster(): readonly RosterEntry[] {
    return this.currentRoster;
  }

  /** Peers currently connected, excluding this one. */
  get peerCount(): number {
    return this.currentRoster.filter((entry) => entry.connected).length - (this.currentSlot >= 0 ? 1 : 0);
  }

  get seed(): number {
    return this.currentSeed;
  }

  get latency(): LatencyStats {
    return this.computeLatency();
  }

  /** Subscribe to a message type. Returns an unsubscribe function. */
  on(type: NetMessage['t'], handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set<Handler>();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Subscribe to state transitions. Used by the HUD to show "connecting…", "rejected", etc. */
  onState(listener: (state: ClientState) => void): () => void {
    this.stateListener = listener;
    return () => {
      if (this.stateListener === listener) {
        this.stateListener = null;
      }
    };
  }

  /**
   * Open the socket and send `hello`.
   *
   * Returns false (and moves to `unavailable`) when there is no transport, so a caller can render
   * "LAN mode unavailable" instead of crashing.
   */
  connect(): boolean {
    if (this.socket !== null) {
      return true;
    }
    if (this.factory === null) {
      this.setState('unavailable');
      return false;
    }

    this.closedByUs = false;
    this.setState('connecting');

    let socket: SocketLike;
    try {
      socket = this.factory(this.url);
    } catch {
      this.setState('unavailable');
      return false;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setState('handshaking');
      this.send({ t: 'hello', v: this.version, name: this.clientName, room: this.room });
    };
    socket.onmessage = (event) => {
      this.handleRaw(event.data);
    };
    socket.onerror = () => {
      // `onclose` always follows, and that is where the state actually settles.
    };
    socket.onclose = () => {
      this.socket = null;
      this.inflight.clear();
      this.setState(this.closedByUs ? 'closed' : 'closed');
    };

    return true;
  }

  close(): void {
    this.closedByUs = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client closed');
    this.setState('closed');
  }

  /** Encode and send. Returns false when the socket is gone or the message will not fit. */
  send(message: NetMessage): boolean {
    const socket = this.socket;
    if (socket === null) {
      return false;
    }
    const text = tryEncodeMessage(message);
    if (text === null) {
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  sendReady(ready: boolean): boolean {
    return this.send({ t: 'ready', slot: this.slot, ready });
  }

  /** Send the local player's input for `tick`. The rollback engine has already canonicalised it. */
  sendInput(tick: number, input: FrameInput): boolean {
    if (this.slot < 0) {
      return false;
    }
    return this.send({ t: 'input', tick, slot: this.slot, input: encodeInput(input) });
  }

  /** Report a `stateHash()` for the relay's desync audit. */
  sendSync(tick: number, hash: string): boolean {
    return this.send({ t: 'sync', tick, hash });
  }

  /** Ask the relay which LAN addresses the house can reach this machine on. */
  requestLanIp(): boolean {
    return this.send({ t: 'lan-ip', v: this.version });
  }

  /** Send one latency probe. The reply lands in `latency` as `pong` arrives. */
  ping(): boolean {
    const seq = this.pingSeq;
    // Advance the sequence *before* sending. Reusing one sequence number would make every probe
    // indistinguishable from every other, so two probes in flight would overwrite each other's
    // send time and `lastSeq` would be permanently 0.
    this.pingSeq += 1;
    this.inflight.set(seq, this.clock());
    this.lastPingAt = this.clock();
    return this.send({ t: 'ping', seq, at: this.clock() });
  }

  /**
   * Drive latency probing from the caller's frame loop.
   *
   * Deliberately not a `setInterval`. A self-timer keeps running after the match ends, keeps the
   * socket alive, and cannot be fast-forwarded by a test; polling from the loop that is already
   * running means probing stops the instant the session does, and a test can pump it by hand.
   *
   * Returns true when this call actually emitted a probe.
   */
  poll(): boolean {
    if (this.socket === null || this.currentState === 'closed' || this.currentState === 'unavailable') {
      return false;
    }
    const now = this.clock();
    if (this.lastPingAt > 0 && now - this.lastPingAt < this.pingEveryMs) {
      return false;
    }
    return this.ping();
  }

  // -----------------------------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------------------------

  private setState(next: ClientState): void {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.stateListener?.(next);
  }

  private handleRaw(data: unknown): void {
    // A socket we have closed, or never opened, must not have its state rewritten by a frame that
    // was already in flight. Without this, `close()` sets `closed` and then a late `reject` from
    // the relay's shutdown flips the HUD to "rejected", which is a lie.
    if (this.currentState === 'closed' || this.currentState === 'unavailable') {
      return;
    }
    const message = decodeMessage(data);
    if (message === null) {
      return; // a malformed frame is silence, never an exception
    }

    switch (message.t) {
      case 'welcome':
        this.currentSlot = message.slot;
        this.currentRoom = message.room;
        this.currentStage = message.stage;
        this.setState('lobby');
        break;
      case 'roster':
        this.currentRoster = message.entries;
        break;
      case 'stage':
        this.currentStage = message.stage;
        this.currentSeed = message.seed;
        break;
      case 'reject':
        this.setState('rejected');
        break;
      case 'ready':
        // Track who has their start button up. The relay does not decide when a match begins —
        // it broadcasts every readiness change and the *peers* agree on when the room is full, so
        // a relay that dies mid-lobby cannot strand four people in a dead "waiting" screen.
        if (message.ready) {
          this.readySlots.add(message.slot);
        } else {
          this.readySlots.delete(message.slot);
        }
        this.refreshReadyState();
        break;
      case 'start':
        this.setState('playing');
        break;
      case 'sync':
        // Audit traffic only; the client reports its own hashes and lets the relay arbitrate.
        break;
      case 'desync':
        this.reactToDesync(message.tick, message.claims);
        break;
      case 'pong': {
        const sentAt = this.inflight.get(message.seq);
        if (sentAt !== undefined) {
          this.inflight.delete(message.seq);
          this.lastPongSeq = message.seq;
          this.recordSample(this.clock() - sentAt);
        }
        break;
      }
      default:
        break;
    }

    const set = this.handlers.get(message.t);
    if (set !== undefined) {
      for (const handler of set) {
        handler(message);
      }
    }
  }

  /**
   * The relay says two peers disagree about `tick`.
   *
   * If our own hash is the odd one out we log it rather than forcing a resync. Forcing a full
   * resync from a hash claim alone would mean trusting the majority over the local player on the
   * strength of a 32-bit FNV hash, and the local player is the one who would feel it. The honest
   * response to a disagreement is to surface it; recovery is a deliberate act.
   */
  private reactToDesync(tick: number, claims: readonly HashClaim[]): void {
    const mine = claims.find((claim) => claim.slot === this.currentSlot);
    if (mine !== undefined) {
      const others = claims.filter((claim) => claim.slot !== this.currentSlot);
      const disagreeing = others.filter((claim) => claim.hash !== mine.hash);
      if (disagreeing.length > 0) {
        console.warn(
          `[urban-reign] desync at tick ${tick}: local ${mine.hash} vs ` +
            disagreeing.map((claim) => `slot${claim.slot} ${claim.hash}`).join(', '),
        );
      }
    }
  }

  private recordSample(rtt: number): void {
    if (!Number.isFinite(rtt) || rtt < 0) {
      return;
    }
    this.samples.push(rtt);
    if (this.samples.length > LATENCY_WINDOW) {
      this.samples.shift();
    }
  }

  private computeLatency(): LatencyStats {
    if (this.samples.length === 0) {
      return { rttMs: 0, medianMs: 0, jitterMs: 0, samples: 0, lastSeq: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const upper = sorted[mid] ?? 0;
    const lower = sorted[mid - 1] ?? upper;
    const median = sorted.length % 2 === 0 ? (upper + lower) / 2 : upper;

    const deviation = this.samples.reduce((sum, value) => sum + Math.abs(value - median), 0);
    // EWMA weighted towards the newest sample (alpha = 1/8), so a link that has just got worse
    // reports it within a few probes instead of over the whole window.
    let ewma = this.samples[0] ?? 0;
    for (let i = 1; i < this.samples.length; i += 1) {
      ewma += ((this.samples[i] ?? ewma) - ewma) / 8;
    }

    return {
      rttMs: Math.round(ewma * 100) / 100,
      medianMs: Math.round(median * 100) / 100,
      jitterMs: Math.round((deviation / this.samples.length) * 100) / 100,
      samples: this.samples.length,
      lastSeq: this.lastPongSeq,
    };
  }

  /**
   * Promote to `ready` when every connected slot has readied up.
   *
   * A slot counts as connected only if the roster says so *and* it is not this client (whose own
   * readiness is counted through the same relay broadcast, so it arrives like everyone else's).
   */
  private refreshReadyState(): void {
    if (this.currentState !== 'lobby' && this.currentState !== 'ready') {
      return;
    }
    const connected = this.currentRoster.filter((entry) => entry.connected);
    const everyoneReady =
      connected.length > 0 &&
      connected.every((entry) => entry.slot === this.currentSlot || this.readySlots.has(entry.slot));
    this.setState(everyoneReady ? 'ready' : 'lobby');
  }
}

/** Slots this client may be assigned, for a UI that wants to render the grid. */
export const ASSIGNABLE_SLOTS: readonly number[] = Object.freeze(
  Array.from({ length: MAX_PLAYERS }, (_value, index) => index),
);

export { isMessageType };