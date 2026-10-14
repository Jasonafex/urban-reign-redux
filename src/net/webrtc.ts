/**
 * WebRTC in-browser peer-to-peer hosting (AGENTS.md §3.3, the zero-config half).
 *
 * The house-LAN path already works, but it needs one thing the first browser cannot provide: a
 * `ws` server on somebody's machine. This module removes that requirement. The **first browser
 * becomes the host**: it runs the room referee (`InBrowserHostRelay`) inside its own tab, plays
 * slot 0 itself, and carries slots 1–3 over `RTCDataChannel`s straight to the other browsers. No
 * `npm run lan-server`, no bind address to type into a phone, and nothing for the guest to run at
 * all — a QR code containing `?room=UR-XXXX` is the entire join flow.
 *
 * ## The four pieces, and why they are four
 *
 *   1. `WebRtcDataChannelSocket` — an `RTCDataChannel` is not a `WebSocket`. It has no `onopen`
 *      contract with `readyState` as a *number*, and a channel that was already open before we
 *      wrapped it will never fire `open` again. This adapter fixes both, which is what lets the
 *      existing `LanClient` and `RollbackSession` run over a peer connection with **no changes to
 *      either** — the netcode cannot tell a house LAN from the internet.
 *   2. `InBrowserHostRelay` — the referee, over in-memory sockets instead of `ws`. The rules come
 *      from `src/net/room.ts`, the same ones the Node relay uses, so a room behaves identically
 *      whoever is hosting it.
 *   3. `WebRtcSignaling` — the one thing WebRTC genuinely cannot do alone: tell the other side how
 *      to reach it. A room code plus a small WebSocket broker, carrying nothing but SDP and ICE
 *      candidates. Once the channel is up, the broker is out of the loop entirely; the match never
 *      touches it again.
 *   4. `InBrowserP2pHost` / `InBrowserP2pGuest` — the offer/answer dance and candidate buffering,
 *      so `main.ts` wires two buttons instead of a hundred lines of async.
 *
 * ## Headless safety
 *
 * Every WebRTC and WebSocket global is reached through a `globalThis` probe with a fallback, never
 * at module scope, and every constructor takes an injectable factory. In Node — where
 * `RTCPeerConnection` does not exist — `isWebRtcSupported()` is `false`, the P2P classes refuse to
 * start instead of throwing, and the relay, the socket adapter and the signaling protocol still
 * load and run. That is what `test/webrtc.test.mjs` does: it drives the real referee and the real
 * wire protocol with mock data channels and no browser in the process.
 *
 * ## What the broker is, exactly
 *
 * A broker here is *not* a game server and must never become one. It forwards opaque frames to the
 * other members of a room and holds no game state: room codes, one `from`, an optional `to`, and a
 * payload it never parses. Public STUN is used by default (`PUBLIC_STUN_URLS`) — that is a NAT
 * traversal hint, not a relay, and it is the only third-party service in this file. The broker URL
 * is configurable (`?signal=`), because pinning one vendor's free tier into a game is how P2P stops
 * working on the day that tier rate-limits somebody.
 *
 * Symmetric-NAT-to-symmetric-NAT pairs (two houses, both behind carrier NAT) still need a TURN
 * server, which is a paid service. This module accepts one (`buildRtcConfiguration(extra)`) but
 * does not invent a default for it: the honest behaviour on a link STUN cannot solve is a slow
 * connection, and the honest response is a status line that says so.
 */

import type { NetMessage } from './protocol';
import { tryEncodeMessage } from './protocol';
import { RoomCoordinator, type RoomPeerSummary, type RoomTransport } from './room';
import type { SocketFactory, SocketLike } from './client';

// -------------------------------------------------------------------------------------------
// WebSocket-style constants
// -------------------------------------------------------------------------------------------

/**
 * `WebSocket.readyState` values, re-declared because `RTCDataChannel` reports its own as *strings*
 * and every line of the netcode compares against numbers.
 */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;

/** Map an `RTCDataChannel.readyState` string (or a raw number) onto the `WebSocket` numbering. */
export function dataChannelStateToNumber(state: unknown): number {
  switch (state) {
    case 'connecting':
      return SOCKET_CONNECTING;
    case 'open':
      return SOCKET_OPEN;
    case 'closing':
      return SOCKET_CLOSING;
    case 'closed':
      return SOCKET_CLOSED;
    default:
      return typeof state === 'number' &&
        state >= SOCKET_CONNECTING &&
        state <= SOCKET_CLOSED
        ? state
        : SOCKET_CLOSED;
  }
}

// -------------------------------------------------------------------------------------------
// Room codes
// -------------------------------------------------------------------------------------------

/** Room codes read `UR-XXXX` — the shape the QR code in the corner panel advertises. */
export const ROOM_CODE_PREFIX = 'UR-';

/**
 * The code body alphabet.
 *
 * Crockford-style: no `I`, `O`, `0` or `1`. Four characters get read aloud across a living room and
 * typed onto a phone keyboard, and those four are exactly the pairs humans transcribe as each other
 * (`1`/`I`, `0`/`O`). Removing them turns a class of "it says `UR-4OZZ`" into a class that cannot
 * happen, and 32 symbols is still 1,048,576 codes — far more than one house needs.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Characters of entropy in a room code. Four at 32 symbols is ~20 bits. */
export const ROOM_CODE_LENGTH = 4;

/** Canonical form only — what `normalizeRoomCode` returns and what the QR encodes. */
export const ROOM_CODE_PATTERN = /^UR-[0-9A-Z]{4}$/;

/**
 * Generate a room code.
 *
 * `random` is injected rather than read from `Math.random` inline so a test can pin it — and so a
 * future host can seed from something better if it wants to. It is also clamped: a generator that
 * returns exactly 1.0 (or drifts negative) must not index off the end of the alphabet and produce a
 * code with a `undefined` in it.
 */
export function generateRoomCode(random: () => number = Math.random): string {
  let body = '';
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const draw = random();
    const safe = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 0.999999) : 0;
    body += ROOM_CODE_ALPHABET.charAt(Math.floor(safe * ROOM_CODE_ALPHABET.length));
  }
  return `${ROOM_CODE_PREFIX}${body}`;
}

/** Is this already the canonical `UR-XXXX` form? */
export function isValidRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

/**
 * Parse whatever a human pasted into the canonical form, or return `null`.
 *
 * Accepts `ur-abcd`, `UR-ABCD`, `ABCD` and `URABCD`, because the two ways this value arrives — a
 * scanned QR code and a friend reading it aloud — are not the same shape. Rejects anything that is
 * not four alphanumerics after the prefix: a five-character code is a typo, and silently matching
 * its first four would put two players in a room neither of them asked for.
 */
export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  const body = trimmed.startsWith(ROOM_CODE_PREFIX)
    ? trimmed.slice(ROOM_CODE_PREFIX.length)
    : trimmed.startsWith('UR') && trimmed.length === 6
      ? trimmed.slice(2)
      : trimmed;
  if (!/^[0-9A-Z]{4}$/.test(body)) {
    return null;
  }
  return `${ROOM_CODE_PREFIX}${body}`;
}

/**
 * The URL a guest scans: this page, with `?room=UR-XXXX` on it.
 *
 * `room` replaces any existing one, and `lan`, `join` and `p2p` are stripped — those are the flags
 * that put *this* page into a mode, and a QR that carried `?lan` as well as `?room=` would have the
 * guest's boot logic argue with itself. `mode=` is deliberately kept: it is how a phone is told
 * which roster it is walking into.
 *
 * With no `base`, returns the relative `?room=…` form, which is what the panel needs when the page
 * is served from a LAN address it does not know it has.
 */
export function roomJoinUrl(code: string, base?: string): string {
  const room = normalizeRoomCode(code);
  if (room === null) {
    throw new RangeError(`Not a room code: ${String(code)}`);
  }
  if (base === undefined || base.trim() === '') {
    return `?room=${room}`;
  }
  const hashless = base.split('#')[0] ?? '';
  const queryAt = hashless.indexOf('?');
  const path = queryAt >= 0 ? hashless.slice(0, queryAt) : hashless;
  const query = queryAt >= 0 ? hashless.slice(queryAt + 1) : '';
  const kept = query
    .split('&')
    .filter((pair) => pair !== '' && !/^(room|lan|join|p2p|signal)(=|$)/.test(pair));
  return `${path}?${[...kept, `room=${room}`].join('&')}`;
}

// -------------------------------------------------------------------------------------------
// ICE configuration
// -------------------------------------------------------------------------------------------

/**
 * Google's public STUN servers.
 *
 * STUN answers one question — "what is my public address?" — which is enough to punch a hole
 * through the NAT in the overwhelming majority of home and mobile connections. It relays no game
 * traffic and sees no gameplay; it is the same service every WebRTC page uses. Public STUN servers
 * are unauthenticated and rate-limited, which is why the pair is a default rather than the last
 * resort.
 */
export const PUBLIC_STUN_URLS: readonly string[] = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
]);

/** Structural `RTCIceServer`, so this module needs no DOM types to build one. */
export interface IceServerLike {
  readonly urls: string | readonly string[];
  readonly username?: string | undefined;
  readonly credential?: string | undefined;
}

/** The default ICE server list: public STUN, no TURN. */
export function publicIceServers(): IceServerLike[] {
  return PUBLIC_STUN_URLS.map((url) => ({ urls: url }));
}

/**
 * `RTCConfiguration` for a peer connection.
 *
 * `extra` is how a TURN server gets in: `{ urls: 'turn:host:3478', username, credential }` is
 * appended after the public STUN entries. Order matters to some implementations — explicit
 * credentials are tried before anonymous STUN — which is why extras go last but are never dropped.
 */
export function buildRtcConfiguration(extra?: readonly IceServerLike[]): { iceServers: IceServerLike[] } {
  const servers = publicIceServers();
  if (extra !== undefined) {
    for (const server of extra) {
      if (server.urls !== undefined && server.urls !== '') {
        servers.push(server);
      }
    }
  }
  return { iceServers: servers };
}

/**
 * Does this environment have WebRTC at all?
 *
 * False in Node and in any browser too old for `RTCPeerConnection` — the callers use it to degrade
 * to a status line ("this browser can't do P2P, use the LAN relay") instead of throwing on a click.
 */
export function isWebRtcSupported(): boolean {
  const ctor = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  return typeof ctor === 'function';
}

// -------------------------------------------------------------------------------------------
// Data channel → SocketLike
// -------------------------------------------------------------------------------------------

/**
 * The slice of `RTCDataChannel` this module uses.
 *
 * Structural on purpose: a test hands in a plain object with four callbacks, and the real browser
 * type satisfies it without a cast. `readyState` is a string here because that is what
 * `RTCDataChannel` actually has — the adapter's whole job is to translate.
 */
export interface DataChannelLike {
  readyState: string;
  binaryType?: string;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * A `SocketLike` that can also be *watched* by a second party.
 *
 * This is the seam that lets one data channel serve both the `LanClient` and the in-browser relay
 * without either stealing the other's callbacks. `LanClient` owns `onmessage`/`onclose` outright —
 * it assigns them in `connect()`, after the socket exists — so anything the relay wanted to observe
 * had to survive that assignment. `tap` and `onDropped` are separate channels for exactly that: the
 * referee reads every inbound frame through a tap, and learns about a dead peer through a hook the
 * client has no way to overwrite.
 *
 * Hijacking `onmessage` instead would work exactly once, which is a bug that passes every test
 * written against the LAN path and fails only over the internet.
 */
export interface ObservableSocket extends SocketLike {
  /** Observe every inbound frame, in addition to the socket's own `onmessage`. */
  tap(listener: (data: unknown) => void): void;
  /** Observe the socket dying — closed by the peer, by us, or by the network. Fires at most once. */
  onDropped(listener: () => void): void;
}

/**
 * Adapts one `RTCDataChannel` to the `SocketLike` the rest of the netcode already speaks.
 *
 * `LanClient` was written against `WebSocket` and knows nothing about WebRTC. Making it speak this
 * interface is the whole trick behind running a rollback match with no server process: the client,
 * the rollback engine and the wire protocol are untouched, and a phone on 5G cannot tell that the
 * bytes arrived through a peer connection instead of a socket.
 *
 * Three mismatches are handled explicitly, because each one silently breaks a LAN-tested client if
 * it is ignored:
 *
 *   - **`readyState` is a string.** `LanClient` gates on `SOCKET_OPEN`, so state is translated on
 *     every read rather than cached at construction — a channel can close under a live match.
 *   - **An already-open channel never fires `open` again.** A guest whose channel opened while the
 *     page was still doing something else would otherwise wait forever for `onopen` and never send
 *     its `hello`. The initial open is therefore replayed on a microtask, which is late enough for
 *     the caller to have assigned its handler and early enough to feel instant.
 *   - **`send` on a closed channel throws.** A tab backgrounded mid-match, or a phone locking its
 *     screen, must degrade to "that input is missing" — which the rollback engine already covers by
 *     prediction — and never to an exception on the render thread.
 */
export class WebRtcDataChannelSocket implements ObservableSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly channel: DataChannelLike | null;
  private readonly taps = new Set<(data: unknown) => void>();
  private readonly dropListeners = new Set<() => void>();
  private closeNotified = false;

  constructor(channel: DataChannelLike | null) {
    this.channel = channel;
    if (channel === null) {
      // A null channel is a closed socket from the caller's point of view. Reporting it as such
      // means `LanClient.connect()` returns false and the HUD says so, instead of the page
      // waiting on an `onopen` that can never arrive.
      this.readyStateOverride = SOCKET_CLOSED;
      return;
    }
    this.readyStateOverride = -1;

    channel.onopen = (event: unknown) => this.onopen?.(event);
    // Taps run before the socket's own handler. The relay must see every frame even if the client's
    // handler throws, and the client must see every frame even if the relay decided to ignore it.
    channel.onmessage = (event: { data: unknown }) => {
      for (const tap of this.taps) {
        tap(event.data);
      }
      this.onmessage?.(event);
    };
    channel.onerror = (event: unknown) => this.onerror?.(event);
    channel.onclose = (event: unknown) => this.fireClose(event);

    if (channel.readyState === 'open') {
      // Already open before we wrapped it: replay the event the browser will never send.
      queueMicrotask(() => {
        if (!this.closeNotified) {
          this.onopen?.({ type: 'open' });
        }
      });
    }
  }

  /** `-1` means "derive from the channel"; a real value pins the state (used for a null channel). */
  private readyStateOverride: number;

  /** Live view of the channel, translated to `WebSocket` numbering. */
  get readyState(): number {
    if (this.readyStateOverride >= 0) {
      return this.readyStateOverride;
    }
    return dataChannelStateToNumber(this.channel?.readyState);
  }

  tap(listener: (data: unknown) => void): void {
    this.taps.add(listener);
  }

  onDropped(listener: () => void): void {
    if (this.closeNotified) {
      // Already dead: report it now rather than never, or a peer admitted onto a closed channel
      // would sit in the roster forever, holding a slot until the next sweep.
      listener();
      return;
    }
    this.dropListeners.add(listener);
  }

  /** The underlying channel, for a caller that wants the connection stats. */
  get bufferedAmount(): number {
    const amount = (this.channel as { bufferedAmount?: unknown } | null)?.bufferedAmount;
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  }

  /**
   * Send one frame. Silently drops anything that cannot be sent.
   *
   * A dropped input is recoverable — the rollback engine predicts it and corrects when the peer's
   * copy lands — whereas a thrown one inside `fixedUpdate` would take the whole match down.
   */
  send(data: string): boolean {
    const channel = this.channel;
    if (channel === null || this.readyState !== SOCKET_OPEN) {
      return false;
    }
    try {
      channel.send(data);
      return true;
    } catch {
      // Buffer full, or the channel closed between the state check and the send.
      return false;
    }
  }

  /** Close the channel. Idempotent, and always fires `onclose` exactly once. */
  close(code?: number, reason?: string): void {
    if (this.closeNotified) {
      return;
    }
    this.readyStateOverride = SOCKET_CLOSED;
    try {
      this.channel?.close();
    } catch {
      // Already closed.
    }
    this.fireClose({ code: code ?? 1000, reason: reason ?? '' });
  }

  private fireClose(event: unknown): void {
    if (this.closeNotified) {
      return;
    }
    this.closeNotified = true;
    this.onclose?.(event);
    for (const listener of this.dropListeners) {
      listener();
    }
    this.dropListeners.clear();
  }
}

// -------------------------------------------------------------------------------------------
// In-memory socket pair (the in-browser transport)
// -------------------------------------------------------------------------------------------

/**
 * One end of a pair of in-memory sockets — how slot 0 talks to the referee living in its own tab.
 *
 * Frames are delivered on a microtask rather than synchronously. That is not a performance detail:
 * a synchronous delivery would run the far end's `onmessage` inside this end's `send`, which inside a
 * broadcast would re-enter the referee's peer iteration and could broadcast from within a broadcast.
 * A microtask keeps delivery asynchronous, exactly as a real socket does, and gives a test a single
 * `await` to drain instead of a sleep.
 *
 * This is the *only* place a synchronous-looking transport appears, and it is deliberately invisible
 * above: from `LanClient`'s side, slot 0 behaves exactly like a guest on a data channel.
 */
class LinkedSocket implements ObservableSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private partner: LinkedSocket | null = null;
  private state = SOCKET_CONNECTING;
  private openNotified = false;
  private closeNotified = false;
  private readonly taps = new Set<(data: unknown) => void>();
  private readonly dropListeners = new Set<() => void>();

  get readyState(): number {
    return this.state;
  }

  /** Wire this end to its partner and settle both ends as open. */
  connectTo(other: LinkedSocket): void {
    this.partner = other;
    other.partner = this;
    this.markOpen();
    other.markOpen();
  }

  send(data: string): void {
    const target = this.partner;
    if (this.state !== SOCKET_OPEN || target === null || target.state !== SOCKET_OPEN) {
      return;
    }
    // The liveness check happens *here*, not at delivery. A frame sent before `close()` is still
    // delivered — the close is ordered after it, exactly as on a real socket — which is what makes
    // "refuse every peer, then close every peer" a message the peer actually reads instead of a
    // silent hang. Frames sent after the close were already dropped by the guard above.
    queueMicrotask(() => {
      for (const tap of target.taps) {
        tap(data);
      }
      target.onmessage?.({ data });
    });
  }

  close(code?: number, reason?: string): void {
    if (this.state === SOCKET_CLOSED) {
      return;
    }
    this.state = SOCKET_CLOSING;
    this.markClosed({ code: code ?? 1000, reason: reason ?? '' });
    // A real channel's close is visible on both ends; so is this one.
    this.partner?.close(code, reason);
  }

  tap(listener: (data: unknown) => void): void {
    this.taps.add(listener);
  }

  onDropped(listener: () => void): void {
    if (this.closeNotified) {
      listener();
      return;
    }
    this.dropListeners.add(listener);
  }

  private markOpen(): void {
    if (this.state !== SOCKET_CONNECTING) {
      return;
    }
    this.state = SOCKET_OPEN;
    if (!this.openNotified) {
      this.openNotified = true;
      queueMicrotask(() => {
        if (!this.closeNotified) {
          this.onopen?.({ type: 'open' });
        }
      });
    }
  }

  private markClosed(event: unknown): void {
    if (this.closeNotified) {
      return;
    }
    this.state = SOCKET_CLOSED;
    this.closeNotified = true;
    queueMicrotask(() => {
      this.onclose?.(event);
      for (const listener of this.dropListeners) {
        listener();
      }
      this.dropListeners.clear();
    });
  }
}

/**
 * A connected pair of in-memory sockets: `[referee, client]`.
 *
 * Exported because it is the seam the in-browser transport is built from, and a test that wants to
 * drive a raw `LanClient` against a raw room — without going anywhere near a data channel — needs
 * it. Both ends are already open when this returns; `onopen` is delivered on the next microtask,
 * exactly as a socket that connected a moment ago would deliver it.
 */
export function createLinkedSocketPair(): [ObservableSocket, ObservableSocket] {
  const referee = new LinkedSocket();
  const client = new LinkedSocket();
  referee.connectTo(client);
  return [referee, client];
}

// -------------------------------------------------------------------------------------------
// In-browser relay
// -------------------------------------------------------------------------------------------

export interface InBrowserHostRelayOptions {
  /** Use this room code instead of generating one. Must be canonical `UR-XXXX`. */
  readonly roomCode?: string | undefined;
  /** Display name for slot 0, shown in the HUD roster. */
  readonly name?: string | undefined;
  readonly stage?: string | undefined;
  readonly seed?: number | undefined;
  readonly maxPlayers?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((message: string) => void) | undefined;
}

/** One peer's admission to the in-browser room. */
export interface HostPeerHandle {
  readonly id: string;
  /** The end a `LanClient` drives. Closing it removes the peer and frees its slot. */
  readonly socket: SocketLike;
  /** Drop the peer, as if its tab had closed. */
  close(): void;
}

/**
 * The relay, running in the host browser tab.
 *
 * Slot 0 is this machine: `attachLocal()` hands out the same kind of socket a guest gets, so the
 * host plays the match through an ordinary `LanClient` and there is exactly one code path for "a
 * player in this room" instead of a special case for the host. Slots 1–3 arrive as
 * `attachDataChannel()`.
 *
 * The referee underneath is `RoomCoordinator` — the same one the Node relay uses — so a house that
 * hosts over Wi-Fi and the same house hosting over the internet assign slots, broadcast inputs and
 * arbitrate hashes identically. That equivalence is the whole reason the referee was extracted
 * rather than copied.
 */
export class InBrowserHostRelay {
  private readonly coordinator: RoomCoordinator;
  private readonly code: string;
  private readonly handles: HostPeerHandle[] = [];
  private closedFlag = false;

  readonly localName: string;

  constructor(options: InBrowserHostRelayOptions = {}) {
    const requested = options.roomCode === undefined ? null : normalizeRoomCode(options.roomCode);
    this.code = requested ?? generateRoomCode();
    this.localName = options.name ?? 'host';
    this.coordinator = new RoomCoordinator({
      maxPlayers: options.maxPlayers,
      stage: options.stage,
      seed: options.seed,
      now: options.now,
      log: options.log ?? ((message: string) => console.log(message)),
      // No `lanAddress`: a P2P guest never dials an address, it connects to a peer connection, so
      // there is nothing to advertise. The client already falls back to the page's own URL.
    });
  }

  /** The room code this relay is advertised under. */
  get roomCode(): string {
    return this.code;
  }

  /** Peers currently connected, in slot order — slot 0 is this browser. */
  get peers(): readonly RoomPeerSummary[] {
    return this.coordinator.peersList;
  }

  /** The roster every peer currently sees, as the message the referee broadcasts. */
  get rosterMessage(): NetMessage {
    return { t: 'roster', entries: this.coordinator.roster() };
  }

  /** Highest tick any peer has claimed. */
  get currentTick(): number {
    return this.coordinator.currentTick;
  }

  /**
   * Admit a peer arriving over a WebRTC data channel.
   *
   * One channel serves both the guest's `LanClient` and the referee: the client keeps `onmessage`
   * and `onclose`, the referee reads the same frames through a tap. That is why there is no socket
   * pair here — the data channel *is* the wire, and duplicating it through a mirror would only add a
   * place for the two halves to disagree.
   */
  attachDataChannel(channel: DataChannelLike | null): HostPeerHandle {
    // A channel that is already closed (or a null one) reports the drop immediately, which frees the
    // slot the moment it is taken rather than one sweep later.
    return this.admit(new WebRtcDataChannelSocket(channel));
  }

  /**
   * Admit a peer that already speaks `ObservableSocket` — how slot 0 joins its own referee, and how
   * a test admits a mock channel socket without pretending to be WebRTC.
   *
   * There is no name argument on purpose: a peer's name arrives in its `hello`, validated by the
   * protocol, and inventing a second channel for it is how a roster ends up showing a name the
   * sender never claimed.
   */
  attachObservable(socket: ObservableSocket): HostPeerHandle {
    return this.admit(socket);
  }

  /**
   * Admit this browser as slot 0.
   *
   * The host gets a socket pair rather than a data channel, because there is no peer to connect to —
   * the referee is in this same tab. Everything above this line is identical to a guest's path,
   * which is the point: there is no "host mode" anywhere in the netcode.
   */
  attachLocal(): HostPeerHandle {
    const [refereeEnd, clientEnd] = createLinkedSocketPair();
    const handle = this.admit(refereeEnd, clientEnd);
    return handle;
  }

  broadcastRoster(): void {
    this.coordinator.broadcastRoster();
  }

  /** Drop silent peers and prune audit history. Call from the host page's frame loop. */
  sweep(): void {
    this.coordinator.sweep();
  }

  /** Refuse every peer and free the room. */
  close(reason = 'room closed'): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    this.coordinator.close(reason);
    this.handles.length = 0;
  }

  /**
   * Admit one peer.
   *
   * `refereeEnd` is what the referee reads and writes; `clientEnd` is what the player's `LanClient`
   * drives. They are the same socket everywhere except slot 0, where the peer is this same tab and
   * the two ends of one in-memory pair face each other.
   *
   * The tap is installed *before* the peer is registered, so a frame that arrives in the same tick
   * the peer joined is read by the referee rather than dropped — which is exactly what happens when a
   * guest's `hello` is already in flight while its data channel finishes opening.
   */
  private admit(refereeEnd: ObservableSocket, clientEnd: SocketLike = refereeEnd): HostPeerHandle {
    let id = '';
    refereeEnd.tap((data) => {
      this.coordinator.handleMessage(id, data);
    });
    refereeEnd.onDropped(() => {
      if (id !== '') {
        this.coordinator.disconnectPeer(id, 'peer channel closed');
      }
    });
    id = this.coordinator.addPeer(this.transportFor(refereeEnd));

    const handle: HostPeerHandle = {
      id,
      socket: clientEnd,
      close: () => clientEnd.close(1000, 'peer closed'),
    };
    this.handles.push(handle);
    return handle;
  }

  /**
   * Turn an observable socket into the two-method transport the referee speaks.
   *
   * Encoding happens here rather than in the referee so both transports are byte-identical: an
   * in-browser room and a Node relay put the same JSON on the wire, and `MAX_MESSAGE_BYTES` is
   * enforced once, in `RoomCoordinator.send`.
   */
  private transportFor(socket: SocketLike): RoomTransport {
    return {
      send: (message: NetMessage) => {
        const text = tryEncodeMessage(message);
        if (text === null) {
          return;
        }
        socket.send(text);
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
    };
  }
}

// -------------------------------------------------------------------------------------------
// Signaling
// -------------------------------------------------------------------------------------------

/** Bumped when a signaling frame changes shape. Peers with a different value are ignored. */
export const SIGNAL_VERSION = 1;

/** Largest signaling frame accepted. An SDP blob with gathered candidates runs to a few KiB. */
export const SIGNAL_MAX_BYTES = 16384;

/** Data channel carrying the match. One per peer connection. */
export const DATA_CHANNEL_LABEL = 'urban-reign';

/**
 * An ICE candidate in the plain, JSON-safe shape a broker can forward without understanding.
 *
 * Deliberately *not* an `RTCIceCandidate`: `JSON.stringify` of the real object drops the fields in
 * some browsers, and a broker that mangles one produces a connection that fails with no error.
 */
export interface SignalCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

export type SignalRole = 'host' | 'guest';

/**
 * Everything that crosses the broker.
 *
 * The shape is the broker's entire contract: `room` selects who hears it, `from` identifies the
 * sender, `to` (on offer/answer/ice) addresses one peer. A broker that forwards these frames without
 * reading past the room is a correct broker — which is the point, because a broker that understood
 * the game would be a server, and a server is what this mode exists to avoid.
 */
export type SignalMessage =
  | { t: 'host'; v: number; room: string; from: string }
  | { t: 'join'; v: number; room: string; from: string }
  | { t: 'offer'; v: number; room: string; from: string; to: string; sdp: string }
  | { t: 'answer'; v: number; room: string; from: string; to: string; sdp: string }
  | { t: 'ice'; v: number; room: string; from: string; to: string; candidate: SignalCandidate | null }
  | { t: 'bye'; v: number; room: string; from: string };

export type SignalType = SignalMessage['t'];

export const SIGNAL_TYPES: readonly SignalType[] = Object.freeze([
  'host',
  'join',
  'offer',
  'answer',
  'ice',
  'bye',
]);

/** Validate an untrusted signaling frame, or return `null`. Never throws. */
export function decodeSignalMessage(raw: unknown): SignalMessage | null {
  let value: unknown = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (text.length > SIGNAL_MAX_BYTES) {
      return null;
    }
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const t = obj['t'];
  if (typeof t !== 'string' || !(SIGNAL_TYPES as readonly string[]).includes(t)) {
    return null;
  }
  const v = obj['v'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v !== SIGNAL_VERSION) {
    return null;
  }
  const room = normalizeRoomCode(obj['room']);
  const from = obj['from'];
  if (room === null || typeof from !== 'string' || from.length === 0 || from.length > 32) {
    return null;
  }
  const base = { t, v, room, from } as const;

  if (t === 'host' || t === 'join' || t === 'bye') {
    return { ...base, t } as SignalMessage;
  }

  const to = obj['to'];
  if (typeof to !== 'string' || to.length === 0 || to.length > 32) {
    return null;
  }
  if (t === 'offer' || t === 'answer') {
    const sdp = obj['sdp'];
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > SIGNAL_MAX_BYTES) {
      return null;
    }
    return { ...base, t, to, sdp } as SignalMessage;
  }
  // `ice`: `null` is the end-of-candidates marker and must survive the round trip, because dropping
  // it is a classic cause of a connection that gathers fine and then never completes.
  const candidateField = obj['candidate'];
  if (candidateField === null || candidateField === undefined) {
    return { ...base, t: 'ice', to, candidate: null };
  }
  if (typeof candidateField !== 'object' || Array.isArray(candidateField)) {
    return null;
  }
  const candidate = candidateField as Record<string, unknown>;
  const sdp = candidate['candidate'];
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > 4096) {
    return null;
  }
  const mid = candidate['sdpMid'];
  const index = candidate['sdpMLineIndex'];
  return {
    ...base,
    t: 'ice',
    to,
    candidate: {
      candidate: sdp,
      sdpMid: typeof mid === 'string' ? mid : null,
      sdpMLineIndex: typeof index === 'number' && Number.isInteger(index) ? index : null,
    },
  };
}

/** Encode a signaling frame, or `null` when it will not fit. */
export function encodeSignalMessage(message: SignalMessage): string | null {
  const text = JSON.stringify(message);
  return text.length > SIGNAL_MAX_BYTES ? null : text;
}

/**
 * Default broker URL: the page's own origin, `/signal`.
 *
 * The relay that a house already runs can serve it on the same origin, so the default works with no
 * configuration and no third party in the path. `?signal=` overrides it — a public broker, a
 * different host, or `ws://127.0.0.1:8787` for testing.
 */
export function signalBrokerUrl(pageUrl?: string): string {
  const base = pageUrl ?? '';
  const override = readQueryFlag(base, 'signal');
  if (override !== null && override !== '') {
    return override;
  }
  const hashless = base.split('#')[0] ?? '';
  const queryAt = hashless.indexOf('?');
  const path = queryAt >= 0 ? hashless.slice(0, queryAt) : hashless;
  if (/^wss?:\/\//i.test(path)) {
    return `${path.replace(/\/+$/, '')}/signal`;
  }
  const scheme = path.startsWith('https://') ? 'wss://' : 'ws://';
  const rest = path.replace(/^https?:\/\//i, '');
  return rest === '' ? `${scheme}127.0.0.1/signal` : `${scheme}${rest.replace(/\/+$/, '')}/signal`;
}

function readQueryFlag(pageUrl: string, flag: string): string | null {
  const queryAt = pageUrl.indexOf('?');
  if (queryAt < 0) {
    return null;
  }
  const query = pageUrl.slice(queryAt + 1).split('#')[0] ?? '';
  for (const pair of query.split('&')) {
    if (pair.startsWith(`${flag}=`)) {
      try {
        return decodeURIComponent(pair.slice(flag.length + 1));
      } catch {
        return pair.slice(flag.length + 1);
      }
    }
  }
  return null;
}

/** Is this frame addressed to `selfId`? Broadcast frames (`host`, `join`, `bye`) have no `to`. */
function isAddressedToUs(message: SignalMessage, selfId: string): boolean {
  return !('to' in message) || message.to === selfId;
}

export type SignalingState = 'idle' | 'connecting' | 'open' | 'closed' | 'unavailable';

export type SignalingHandler = (message: SignalMessage) => void;

export interface WebRtcSignalingOptions {
  /** Room code both ends share. */
  readonly room: string;
  readonly role: SignalRole;
  /** Broker URL. Defaults to the page origin's `/signal`. */
  readonly url?: string | undefined;
  /** This peer's id on the wire. Defaults to a short random id. */
  readonly selfId?: string | undefined;
  /** Socket factory — the seam a test uses to stand in for the broker. */
  readonly createSocket?: SocketFactory | undefined;
  readonly random?: (() => number) | undefined;
  readonly log?: ((message: string) => void) | undefined;
}

/**
 * Room-based WebSocket signaling.
 *
 * Deliberately the smallest thing that can work: it opens one socket to a broker, announces the
 * room, and relays frames. It never sees gameplay, holds no peer state beyond "am I open", and
 * closes cleanly enough that a broker restart degrades to "already-connected peers keep playing",
 * which is the property that matters at 2am when someone reloads the host tab.
 *
 * Both roles share this one class. `role` only decides which announcement is sent on open (`host` or
 * `join`) and which frames are treated as commands rather than as traffic for someone else.
 */
export class WebRtcSignaling {
  readonly room: string;
  readonly role: SignalRole;
  readonly selfId: string;
  readonly url: string;

  private socket: SocketLike | null = null;
  private currentState: SignalingState = 'idle';
  private readonly factory: SocketFactory | null;
  private readonly log: (message: string) => void;
  private readonly handlers = new Map<SignalType, Set<SignalingHandler>>();
  private stateListener: ((state: SignalingState) => void) | null = null;
  private closedByUs = false;

  constructor(options: WebRtcSignalingOptions) {
    const room = normalizeRoomCode(options.room);
    if (room === null) {
      throw new RangeError(`Not a room code: ${String(options.room)}`);
    }
    this.room = room;
    this.role = options.role;
    this.url = options.url ?? signalBrokerUrl();
    this.factory =
      options.createSocket ??
      (typeof globalThis.WebSocket === 'function'
        ? (url: string) => new globalThis.WebSocket(url) as unknown as SocketLike
        : null);
    this.log = options.log ?? ((message: string) => console.log(message));

    const random = options.random ?? Math.random;
    this.selfId =
      options.selfId ??
      `p${Math.floor(Math.min(Math.max(random(), 0), 0.999999) * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`;
  }

  get state(): SignalingState {
    return this.currentState;
  }

  /** Subscribe to a frame type from *another* peer. Returns an unsubscribe function. */
  on(type: SignalType, handler: SignalingHandler): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set<SignalingHandler>();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Subscribe to connection-state changes (a broker restart is the interesting one). */
  onState(listener: (state: SignalingState) => void): () => void {
    this.stateListener = listener;
    return () => {
      if (this.stateListener === listener) {
        this.stateListener = null;
      }
    };
  }

  /**
   * Connect to the broker and announce the room.
   *
   * Returns false when the environment has no `WebSocket`, which is the "no broker configured"
   * case a caller renders as a status line rather than a crash.
   */
  open(): boolean {
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
    } catch (error) {
      this.log(`signaling socket failed: ${String(error)}`);
      this.setState('unavailable');
      return false;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setState('open');
      // The announcement is idempotent from the guest's point of view: the host treats a repeated
      // `join` from the same id as a peer that reloaded, and renegotiates rather than ignoring it.
      this.send(this.role === 'host' ? { t: 'host', v: SIGNAL_VERSION, room: this.room, from: this.selfId }
                                     : { t: 'join', v: SIGNAL_VERSION, room: this.room, from: this.selfId });
    };
    socket.onmessage = (event) => {
      this.handleRaw(event.data);
    };
    socket.onerror = (event) => {
      this.log(`signaling error: ${String(event)}`);
    };
    socket.onclose = () => {
      this.socket = null;
      this.setState(this.closedByUs ? 'closed' : 'closed');
    };

    return true;
  }

  close(): void {
    if (this.socket !== null) {
      this.send({ t: 'bye', v: SIGNAL_VERSION, room: this.room, from: this.selfId });
    }
    this.closedByUs = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'signaling closed');
    this.setState('closed');
  }

  /** Send a frame. Returns false when the broker is gone or the frame will not fit. */
  send(message: SignalMessage): boolean {
    const socket = this.socket;
    if (socket === null) {
      return false;
    }
    const text = encodeSignalMessage(message);
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

  private setState(next: SignalingState): void {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.stateListener?.(next);
  }

  private handleRaw(data: unknown): void {
    if (this.currentState === 'closed' || this.currentState === 'unavailable') {
      return;
    }
    const message = decodeSignalMessage(data);
    if (message === null) {
      return; // a malformed frame is silence, never an exception on the render thread
    }
    // Our own broadcast echoed back, a frame for somebody else in the room, or a frame addressed to
    // a specific peer that is not us.
    //
    // That last filter is load-bearing the moment there is more than one guest. The host offers to
    // each of its three guests separately, and a broker forwards to the whole room — so without it,
    // guest 2 would receive guest 3's offer, answer it, and end up with two peer connections it never
    // asked for. The broker cannot do this filtering: it does not know who anyone is.
    if (message.room !== this.room || message.from === this.selfId || !isAddressedToUs(message, this.selfId)) {
      return;
    }
    const set = this.handlers.get(message.t);
    if (set !== undefined) {
      for (const handler of set) {
        handler(message);
      }
    }
  }
}

// -------------------------------------------------------------------------------------------
// Peer connections
// -------------------------------------------------------------------------------------------

/** Plain `RTCSessionDescriptionInit`-shaped object; the browser accepts this directly. */
export interface SessionDescriptionLike {
  readonly type: string;
  readonly sdp: string;
}

export interface PeerConnectionLike {
  createDataChannel(label: string, options?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: SignalCandidate | null): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: SignalCandidate | null }) => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
}

export type PeerConnectionFactory = (config: RtcConfig) => PeerConnectionLike | null;

/**
 * The real `RTCPeerConnection`, reached only through a probe.
 *
 * Returns null when this environment has no WebRTC, which is the caller's cue to show "P2P
 * unavailable" instead of half-opening a match. Nothing here runs at module scope, so importing
 * this file into Node is safe.
 */
export function defaultPeerConnectionFactory(
  config: { iceServers: IceServerLike[] },
): PeerConnectionLike | null {
  const ctor = (globalThis as { RTCPeerConnection?: new (c: unknown) => unknown }).RTCPeerConnection;
  if (typeof ctor !== 'function') {
    return null;
  }
  return new ctor({ iceServers: config.iceServers }) as unknown as PeerConnectionLike;
}

/**
 * `RTCConfiguration` for a peer connection factory: the shape `defaultPeerConnectionFactory` takes.
 */
export type RtcConfig = { iceServers: IceServerLike[] };

/**
 * Buffer for ICE candidates that arrive before the remote description.
 *
 * A candidate crossing the broker can absolutely beat the SDP it belongs to: the offer is one
 * message, but candidates trickle out one at a time as gathering progresses, and a fast local
 * connection delivers the first candidate first. Passing a candidate to
 * `setRemoteDescription` before it has been set is an error in every implementation, and dropping it
 * instead leaves a connection that gathers perfectly and then never completes — the single most
 * common "it works on my phone" WebRTC bug. So they queue here and are replayed afterwards.
 */
class CandidateQueue {
  private pending: (SignalCandidate | null)[] = [];
  private remoteSet = false;

  get isRemoteSet(): boolean {
    return this.remoteSet;
  }

  markRemoteSet(): void {
    this.remoteSet = true;
  }

  add(candidate: SignalCandidate | null): void {
    this.pending.push(candidate);
  }

  drain(): (SignalCandidate | null)[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/** One in-flight negotiation: the peer connection plus the candidates that outran its answer. */
interface HostPeerNegotiation {
  readonly pc: PeerConnectionLike;
  readonly queue: CandidateQueue;
  /** The data channel's slot in the referee, admitted as soon as it exists. */
  readonly handle: HostPeerHandle;
}

export interface P2pHostOptions {
  /** Advertise this room code instead of generating one. */
  readonly roomCode?: string | undefined;
  /** Display name for slot 0. */
  readonly name?: string | undefined;
  /** Broker URL. Defaults to the page origin's `/signal`. */
  readonly signalUrl?: string | undefined;
  readonly stage?: string | undefined;
  readonly seed?: number | undefined;
  readonly maxPlayers?: number | undefined;
  /** Extra ICE servers — this is where a TURN relay goes. */
  readonly iceServers?: readonly IceServerLike[] | undefined;
  readonly createPeerConnection?: PeerConnectionFactory | undefined;
  readonly createSocket?: SocketFactory | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((message: string) => void) | undefined;
  /**
 * Optional notification that a guest's data channel exists.
 *
 * Deliberately optional, and worth understanding why the host needs nothing from it: a guest runs
 * its own `LanClient` against the same referee, over the far end of its own channel. The host's
 * job is to admit that channel (`attachDataChannel`, above) and let the referee broadcast; by the
 * time a handle exists there is nothing left for a caller to set up. It stays as a seam for a HUD
 * that wants to announce "a phone is negotiating" before the guest has been admitted — which is a
 * real state, and one this class deliberately does not otherwise model.
 */
  readonly onGuest?: ((handle: HostPeerHandle) => void) | undefined;
}

/**
 * The first browser, hosting the room.
 *
 * Owns the referee, one peer connection per guest, and one signaling socket. The flow is the
 * textbook one and is deliberately boring:
 *
 *   1. announce `UR-XXXX` to the broker,
 *   2. a guest answers with `join`,
 *   3. open a peer connection, create the data channel, send the offer,
 *   4. relay every ICE candidate both ways,
 *   5. when the channel opens, admit it to the referee and hand the socket to the caller.
 *
 * The host is always the offerer. "Perfect negotiation" — where either side may offer, with
 * politeness and rollback — is the right answer for a *mesh* of peers that rejoin. It is the wrong
 * answer for one host with three guests, because it adds two more states (polite peer, rollback)
 * that can only ever fire when someone reloads mid-negotiation, and a bug in those states takes the
 * whole room down. A guest that reloads simply joins again and gets a second, fresh peer connection;
 * the old one dies with the tab that owned it.
 */
export class InBrowserP2pHost {
  readonly relay: InBrowserHostRelay;
  readonly roomCode: string;

  private readonly signaling: WebRtcSignaling;
  private readonly connections = new Map<string, HostPeerNegotiation>();
  private readonly config: RtcConfig;
  private readonly factory: PeerConnectionFactory;
  private readonly log: (message: string) => void;
  private readonly onGuest: ((handle: HostPeerHandle) => void) | null;
  private closedFlag = false;

  constructor(options: P2pHostOptions) {
    this.relay = new InBrowserHostRelay({
      roomCode: options.roomCode,
      name: options.name,
      stage: options.stage,
      seed: options.seed,
      maxPlayers: options.maxPlayers,
      now: options.now,
      log: options.log,
    });
    this.roomCode = this.relay.roomCode;
    this.log = options.log ?? ((message: string) => console.log(message));
    this.onGuest = options.onGuest ?? null;
    this.config = buildRtcConfiguration(options.iceServers);
    // Null-returning on purpose: "this browser has no WebRTC" has to be a value the caller can see,
    // not an exception thrown from inside a click handler.
    this.factory = options.createPeerConnection ?? defaultPeerConnectionFactory;

    this.signaling = new WebRtcSignaling({
      room: this.roomCode,
      role: 'host',
      url: options.signalUrl,
      createSocket: options.createSocket,
      log: this.log,
    });
    this.signaling.on('join', (message) => {
      if (message.t === 'join') {
        void this.handleSignal(message);
      }
    });
    this.signaling.on('answer', (message) => {
      if (message.t === 'answer') {
        void this.handleSignal(message);
      }
    });
    this.signaling.on('ice', (message) => {
      if (message.t === 'ice') {
        void this.handleSignal(message);
      }
    });
  }

  /** One line for the HUD: the room, the signaling state and how many guests are connected. */
  get status(): string {
    const peers = this.relay.peers;
    const signaling = this.signaling.state;
    if (signaling === 'unavailable') {
      return `p2p ${this.roomCode}: no WebSocket in this browser`;
    }
    if (signaling !== 'open') {
      return `p2p ${this.roomCode}: signaling ${signaling}… (${this.signaling.url})`;
    }
    const guests = Math.max(peers.length - 1, 0);
    return `p2p ${this.roomCode}: hosting · ${guests} guest${guests === 1 ? '' : 's'} connected`;
  }

  /**
   * The hint for someone whose P2P room never opens.
   *
   * The most likely failure by far is not a bug: the page's own origin has no `/signal` endpoint,
   * because P2P still needs somebody to introduce two browsers. Naming the URL it tried and the
   * command that fixes it beats a spinner that never stops.
   */
  get brokerHint(): string {
    return (
      `no signaling broker at ${this.signaling.url} — run \`npm run signal-broker\`, ` +
      'then open this page with ?signal=ws://<this-host>:8766'
    );
  }

  /**
   * Peers currently in the room, in slot order.
   *
   * Note what is *not* here, and why it took a test to find it: no "observe the guests' traffic"
   * hook. The referee broadcasts to every peer, including this browser's own local peer, so the
   * host's ordinary `LanClient` already receives remote inputs, the roster, `ready` and `desync` —
   * exactly as a guest's does. A second seam for the same frames would feed every input to the host's
   * rollback session twice, and "the host is just another peer of its own room" is both simpler and
   * the only design where a P2P host and a LAN host run identical code.
   */
  get peers(): readonly RoomPeerSummary[] {
    return this.relay.peers;
  }

  /** Announce the room. Returns false when there is no transport to announce over. */
  start(): boolean {
    return this.signaling.open();
  }

  /** Tear down every peer connection, the signaling socket and the room. */
  close(): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    for (const state of this.connections.values()) {
      try {
        state.pc.close();
      } catch {
        // Already closed.
      }
    }
    this.connections.clear();
    this.signaling.close();
    this.relay.close('host left the room');
  }

  /**
   * Open a peer connection for a guest, create the channel, and offer.
   *
   * The guest is admitted to the referee *before* the channel is open rather than when it opens,
   * because that is what lets the tap see every frame from the first one: the slot is held, but
   * nothing is sent over a channel that is still `connecting`, so an early guest cannot inject a
   * frame into a room that has not admitted it yet — `hello` is still the only thing accepted from a
   * peer with no slot.
   */
  private async negotiate(guestId: string): Promise<void> {
    if (this.closedFlag || this.connections.has(guestId)) {
      return;
    }
    const pc = this.factory(this.config);
    if (pc === null) {
      this.log('p2p: no RTCPeerConnection in this browser — cannot host a guest');
      return;
    }

    const queue = new CandidateQueue();
    pc.onicecandidate = (event) => {
      // `null` is end-of-candidates and is forwarded: the far end needs it to finish negotiation.
      this.signaling.send({
        t: 'ice',
        v: SIGNAL_VERSION,
        room: this.roomCode,
        from: this.signaling.selfId,
        to: guestId,
        candidate: event.candidate,
      });
    };

    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    const handle = this.relay.attachDataChannel(channel);
    const state: HostPeerNegotiation = { pc, queue, handle };
    this.connections.set(guestId, state);
    this.onGuest?.(handle);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.send({
        t: 'offer',
        v: SIGNAL_VERSION,
        room: this.roomCode,
        from: this.signaling.selfId,
        to: guestId,
        sdp: offer.sdp,
      });
    } catch (error) {
      this.log(`p2p: offer to ${guestId} failed: ${String(error)}`);
      this.dropNegotiation(guestId);
    }
  }

  private dropNegotiation(guestId: string): void {
    const state = this.connections.get(guestId);
    if (state === undefined) {
      return;
    }
    this.connections.delete(guestId);
    try {
      state.pc.close();
    } catch {
      // Already closed.
    }
    state.handle.close();
  }

  /**
   * Act on one signaling frame.
   *
   * Public so a test can drive a whole negotiation with no socket and no browser, which is the only
   * way to keep the offer/answer ordering honest in CI.
   */
  async handleSignal(message: SignalMessage): Promise<void> {
    if (message.t === 'join') {
      await this.negotiate(message.from);
      return;
    }

    if (message.t === 'answer') {
      const state = this.connections.get(message.from);
      if (state === undefined || state.queue.isRemoteSet) {
        return; // a peer we already dropped, or an answer to an offer we never made
      }
      try {
        await state.pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
        state.queue.markRemoteSet();
        for (const candidate of state.queue.drain()) {
          await state.pc.addIceCandidate(candidate);
        }
      } catch (error) {
        this.log(`p2p: answer from ${message.from} failed: ${String(error)}`);
        this.dropNegotiation(message.from);
      }
      return;
    }

    if (message.t === 'ice') {
      const state = this.connections.get(message.from);
      if (state === undefined) {
        return; // a candidate for a peer we already dropped
      }
      if (!state.queue.isRemoteSet) {
        // The answer has not landed yet. Queue rather than drop — see `CandidateQueue`.
        state.queue.add(message.candidate);
        return;
      }
      try {
        await state.pc.addIceCandidate(message.candidate);
      } catch (error) {
        // A rejected candidate is normal on a lossy path and never fatal: the connection either finds
        // another path or fails at the channel level, which the caller already surfaces.
        this.log(`p2p: ice candidate from ${message.from} rejected: ${String(error)}`);
      }
    }
  }
}

export interface P2pGuestOptions {
  /** Room code from the QR code or the URL. */
  readonly roomCode: string;
  readonly name?: string | undefined;
  readonly signalUrl?: string | undefined;
  readonly iceServers?: readonly IceServerLike[] | undefined;
  readonly createPeerConnection?: PeerConnectionFactory | undefined;
  readonly createSocket?: SocketFactory | undefined;
  /** Called once, with the socket that connects this guest to the host's referee. */
  readonly onChannel: (socket: SocketLike) => void;
  readonly log?: ((message: string) => void) | undefined;
}

/**
 * A guest browser joining a hosted room.
 *
 * The mirror image of `InBrowserP2pHost` with one asymmetry: the guest never creates a channel, it
 * receives one (`ondatachannel`), because the host is always the offerer. It buffers candidates that
 * arrive before the offer — see `CandidateQueue` — and hands the finished socket to the caller, which
 * drives it with an ordinary `LanClient`.
 */
export class InBrowserP2pGuest {
  readonly roomCode: string;

  private readonly signaling: WebRtcSignaling;
  private readonly config: RtcConfig;
  private readonly factory: PeerConnectionFactory | null;
  private readonly onChannel: (socket: SocketLike) => void;
  private readonly log: (message: string) => void;
  private connection: PeerConnectionLike | null = null;
  private readonly queue = new CandidateQueue();
  /** The host's signaling id, learned from the offer. ICE candidates need an addressee. */
  private hostId: string | null = null;
  /** Candidates gathered before the offer told us who to address them to. */
  private readonly pendingOutbound: (SignalCandidate | null)[] = [];
  private closedFlag = false;

  constructor(options: P2pGuestOptions) {
    const room = normalizeRoomCode(options.roomCode);
    if (room === null) {
      throw new RangeError(`Not a room code: ${String(options.roomCode)}`);
    }
    this.roomCode = room;
    this.log = options.log ?? ((message: string) => console.log(message));
    this.onChannel = options.onChannel;
    this.config = buildRtcConfiguration(options.iceServers);
    this.factory =
      options.createPeerConnection ??
      ((config) => {
        const pc = defaultPeerConnectionFactory(config);
        return pc;
      });

    this.signaling = new WebRtcSignaling({
      room: this.roomCode,
      role: 'guest',
      url: options.signalUrl,
      createSocket: options.createSocket,
      log: this.log,
    });
    this.signaling.on('offer', (message) => {
      if (message.t === 'offer') {
        void this.onOffer(message);
      }
    });
    this.signaling.on('ice', (message) => {
      if (message.t === 'ice') {
        void this.onIce(message.candidate);
      }
    });
  }

  get status(): string {
    switch (this.signaling.state) {
      case 'unavailable':
        return `p2p ${this.roomCode}: no WebSocket in this browser`;
      case 'open':
        return this.connection === null
          ? `p2p ${this.roomCode}: joining…`
          : `p2p ${this.roomCode}: connecting…`;
      default:
        return `p2p ${this.roomCode}: signaling ${this.signaling.state}… (${this.signaling.url})`;
    }
  }

  /** The hint for a guest whose room never opens. See `InBrowserP2pHost.brokerHint`. */
  get brokerHint(): string {
    return (
      `no signaling broker at ${this.signaling.url} — run \`npm run signal-broker\`, ` +
      'then open this page with ?signal=ws://<host-running-the-broker>:8766'
    );
  }

  /** Announce `join` to the broker. Returns false when there is no transport. */
  start(): boolean {
    return this.signaling.open();
  }

  close(): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    try {
      this.connection?.close();
    } catch {
      // Already closed.
    }
    this.connection = null;
    this.signaling.close();
  }

  private ensureConnection(): PeerConnectionLike | null {
    if (this.connection !== null) {
      return this.connection;
    }
    if (this.factory === null) {
      this.log('p2p: no RTCPeerConnection in this browser — cannot join');
      return null;
    }
    const pc = this.factory(this.config);
    if (pc === null) {
      this.log('p2p: no RTCPeerConnection in this browser — cannot join');
      return null;
    }
    pc.onicecandidate = (event) => {
      // Candidates are addressed to the host id from the offer. There is nothing to address them to
      // before that frame lands, and guessing is worse than waiting: a broker routes on `to`, so a
      // frame with no recipient goes nowhere. Held here and flushed once the offer names the host —
      // the mirror image of `CandidateQueue`, which holds *inbound* candidates waiting for a
      // description.
      const to = this.hostId;
      if (to === null) {
        this.pendingOutbound.push(event.candidate);
        return;
      }
      this.signaling.send({
        t: 'ice',
        v: SIGNAL_VERSION,
        room: this.roomCode,
        from: this.signaling.selfId,
        to,
        candidate: event.candidate,
      });
    };
    pc.ondatachannel = (event) => {
      // Ordered and reliable, exactly as the host asked for: inputs are a lockstep stream and a
      // reordered packet is a rolled-back tick nobody asked for.
      this.onChannel(new WebRtcDataChannelSocket(event.channel));
    };
    this.connection = pc;
    return pc;
  }

  private async onOffer(message: Extract<SignalMessage, { t: 'offer' }>): Promise<void> {
    if (this.closedFlag) {
      return;
    }
    const pc = this.ensureConnection();
    if (pc === null) {
      return;
    }
    this.hostId = message.from;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      this.queue.markRemoteSet();
      for (const candidate of this.queue.drain()) {
        await pc.addIceCandidate(candidate);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.send({
        t: 'answer',
        v: SIGNAL_VERSION,
        room: this.roomCode,
        from: this.signaling.selfId,
        to: message.from,
        sdp: answer.sdp,
      });
    } catch (error) {
      this.log(`p2p: answer failed: ${String(error)}`);
      return;
    }

    // Anything gathered while the answer was being built can finally be addressed.
    for (const candidate of this.pendingOutbound.splice(0)) {
      this.signaling.send({
        t: 'ice',
        v: SIGNAL_VERSION,
        room: this.roomCode,
        from: this.signaling.selfId,
        to: message.from,
        candidate,
      });
    }
  }

  private async onIce(candidate: SignalCandidate | null): Promise<void> {
    if (!this.queue.isRemoteSet || this.connection === null) {
      // The offer is still in flight; replay this candidate once the description lands.
      this.queue.add(candidate);
      return;
    }
    try {
      await this.connection.addIceCandidate(candidate);
    } catch (error) {
      this.log(`p2p: ice candidate rejected: ${String(error)}`);
    }
  }
}