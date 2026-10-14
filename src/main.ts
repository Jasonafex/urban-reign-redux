/**
 * Browser entry point — presentation layer only.
 *
 * AGENTS.md §3.1: this file may touch the DOM, Three.js and WebGL; it must never mutate or
 * feed back into simulation state. It reads fighter records and the event stream, and it feeds
 * *inputs* into `fixedUpdate` — that is the only permitted direction of influence. Every DOM
 * lookup is guarded so importing this module in a headless runner degrades to a no-op instead
 * of throwing.
 *
 * Phase 2 replaces the single-player key handler with a full input stack:
 *   - `GamepadSource` polls up to four Standard Gamepad devices,
 *   - `KeyboardSource` serves the two split-keyboard layouts,
 *   - `TouchController` puts a thumbstick and action buttons on a phone,
 *   - `JoinManager` decides which of those is in which of the four player slots, and
 *   - `InputHistory` turns each device's held state into one buffered `FrameInput` per slot.
 *
 * The rule that keeps this honest: the sim reads `FrameInput[]` and nothing else. It never asks
 * what a gamepad is, and every device reaches it through the same buffer.
 *
 * Phase 3 adds the house-LAN path (AGENTS.md §3.3) on top of that stack:
 *   - `LanClient` opens one socket to the local relay and reports its latency,
 *   - `RollbackSession` owns the world once a session is live, applying the local input with zero
 *     delay and correcting remote inputs by rewinding,
 *   - a corner panel shows the join link and a QR code so a phone can get in without typing an
 *     IP address.
 *
 * The direction of influence is unchanged by any of that: this file still only ever hands the
 * simulation `FrameInput[]`, and still only ever reads fighter records back out. When a LAN
 * session is live the renderer simply reads `session.runner` instead of a local `MatchRunner`,
 * which is a change of *where state comes from*, not a new channel into it.
 *
 * Phase 4 replaces the Phase 0 placeholder arena — four box walls and four capsule proxies — with
 * the real presentation stack, one module per job:
 *   - `render/stage` builds the urban arena on the sim's own `ARENA_HALF_EXTENT`,
 *   - `render/character` poses four articulated rigs from `Fighter` records,
 *   - `render/vfx` throws sparks, dust and SPA shockwaves off the event stream,
 *   - `camera/camera` frames every living fighter and shakes on impact,
 *   - `ui/hud` draws the four arcade panels, and `audio/sound` synthesises the cues.
 *
 * This file is the wiring and nothing else: it hands out fighter records, consumes the sim's
 * events, and owns no geometry, no arithmetic and no audio graph of its own. Every one of those
 * modules is headless-safe on its own, which is why the frame loop can call all of them
 * unconditionally without a single `if (typeof document === 'undefined')` in this file.
 */

import * as THREE from 'three';
import { FP_SCALE, RENDER, TICK_HZ } from './config';
import { startFixedLoop } from './core/loop';
import { GamepadSource } from './input/gamepad';
import { KeyboardSource } from './input/keyboard';
import { JoinManager } from './input/join';
import { TouchController, TouchInputState } from './ui/touch';
import { encodeQr, mountQr } from './ui/qr';
import { ArcadeHud, defaultTag } from './ui/hud';
import { SoundBoard } from './audio/sound';
import { CharacterRoster } from './render/character';
import { buildStage } from './render/stage';
import { VfxSystem } from './render/vfx';
import { createFramingCamera } from './camera/camera';
import type { FrameInput } from './sim/runner';
import { MatchRunner, NEUTRAL_INPUT } from './sim/runner';
import type { Fighter } from './sim/fighter';
import { isHit, type SimEvent } from './sim/events';
import { AiController } from './sim/ai';
import {
  GAME_MODES,
  MatchRules,
  modeDef,
  type GameModeId,
  type ModeEvent,
} from './sim/modes';
import { LanClient, relayUrl } from './net/client';
import type { SocketFactory, SocketLike } from './net/client';
import { RollbackSession } from './net/rollback';
import {
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  canonicalizeInput,
  inputFromWire,
} from './net/protocol';
import {
  InBrowserP2pGuest,
  InBrowserP2pHost,
  normalizeRoomCode,
  roomJoinUrl,
  signalBrokerUrl,
} from './net/webrtc';

/**
 * The house-LAN half of the client.
 *
 * Owns the socket and the rollback session, and exposes exactly three things the frame loop needs:
 * the world to render, a way to advance a tick with the local input, and a per-frame pump. Kept as
 * an interface so the frame loop can hold `null` and take the offline path without a branch on a
 * module-level mutable.
 */
interface LanMatch {
  readonly client: LanClient;
  /** Null until the relay assigns a slot and a `RollbackSession` can be built for it. */
  readonly session: RollbackSession | null;
  /** True once a session exists, so the world to render is the rollback world's. */
  readonly live: boolean;
  /** Advance one tick with the local player's input and publish it. */
  step(localInput: FrameInput): SimEvent[];
  /** Per-frame housekeeping: latency probes and the periodic desync-audit hash. */
  pump(): void;
  /** One line for the HUD. */
  status(): string;
  /** Join URLs to advertise, once the relay has told us which addresses work. */
  joinLinks(): readonly string[];
}

/**
 * How this page was opened, and therefore which network path it takes.
 *
 * Four ways in, and they are mutually exclusive on purpose — a QR code is one decision, not two:
 *
 *   - `?room=UR-XXXX`  join a room hosted by another browser, peer-to-peer.
 *   - `?p2p`           *become* the host: the referee runs in this tab.
 *   - `?join=<host>`   join a WebSocket relay running on another machine (the house-LAN path).
 *   - `?lan`           the relay is on this machine.
 *
 * A plain URL is none of these, and the client plays offline — which is the same thing it did before
 * any of this existed, so a mistyped flag never leaves somebody staring at a blank screen.
 */
type NetFlags =
  | { readonly kind: 'off' }
  | { readonly kind: 'lan'; readonly relayHost: string | null }
  | { readonly kind: 'p2p-host' }
  | { readonly kind: 'p2p-guest'; readonly room: string };

function readNetFlags(): NetFlags {
  if (typeof location === 'undefined') {
    return { kind: 'off' };
  }
  const params = new URLSearchParams(location.search);

  // The P2P room comes first. `?room=` is the only flag a guest ever needs, and it must win even if
  // the URL also carries a stale `?lan` from a copied join link — otherwise the guest would silently
  // try to dial a relay that is not there.
  const room = params.get('room');
  if (room !== null && room !== '') {
    return { kind: 'p2p-guest', room };
  }
  if (params.has('p2p')) {
    return { kind: 'p2p-host' };
  }

  const join = params.get('join');
  if (join !== null && join !== '') {
    return { kind: 'lan', relayHost: join };
  }
  // `?lan` with no host means "the relay is on this machine", which is the same code path as a join
  // to `location.hostname` — kept as one value rather than a flag, so the relay's own default bind
  // address stays the single source of truth for "which machine is this".
  return { kind: 'lan', relayHost: null };
}

/**
 * The game mode from `?mode=`, defaulting to the Free-For-All.
 *
 * On the join URL this is how a phone is told which match it is walking into: the QR code encodes
 * the host's full URL, so `?mode=team_battle` rides along with it and every device in the house
 * starts on the same roster. Unrecognised values fall back to the default rather than throwing —
 * a mistyped query flag should not leave someone staring at a blank screen.
 */
function readModeFromUrl(): GameModeId {
  if (typeof location === 'undefined') {
    return 'free_for_all';
  }
  const requested = new URLSearchParams(location.search).get('mode');
  return GAME_MODES.some((mode) => mode.id === requested) ? (requested as GameModeId) : 'free_for_all';
}

interface LanMatchConfig {
  /** What the HUD calls this session: `lan:` over a relay, `p2p:` over peer connections. */
  readonly label: 'lan' | 'p2p';
  /** Display name sent in `hello`, and the room both peers agree on. */
  readonly name: string;
  readonly room: string;
  /**
   * The socket factory.
   *
   * Omitted for the house LAN, where `LanClient` opens a `WebSocket` of its own. Supplied for P2P,
   * where the socket is a data channel — or, for the host's own slot 0, an in-memory pair into the
   * referee running in this very tab. That is the entire difference between "two phones on Wi-Fi"
   * and "four browsers across the internet": one function argument.
   */
  readonly createSocket?: SocketFactory | undefined;
  /** Where the transport lives, for the status line. Never dialled on the P2P path. */
  readonly url: string;
  /**
   * Extra per-frame housekeeping, run by `pump`.
   *
   * The P2P host uses it to sweep its referee. Deliberately part of the match's own frame budget
   * rather than a second timer: a sweep on its own interval keeps running after a tab is hidden,
   * which is precisely when a backgrounded host tab should be doing nothing at all.
   */
  readonly extraPump?: (() => void) | undefined;
}

function createLanMatch(
  onSessionReady: (session: RollbackSession) => void,
  config: LanMatchConfig,
): LanMatch | null {
  // No `WebSocket` global and no injected transport means no LAN mode. Returning null (rather than
  // throwing) leaves the client in its normal offline behaviour, which is the right outcome on an
  // old browser.
  if (config.createSocket === undefined && typeof WebSocket !== 'function') {
    return null;
  }

  const client = new LanClient({
    url: config.url,
    name: config.name,
    room: config.room,
    // Omitted rather than passed as `undefined`: `LanClient` reads an absent factory as "use the
    // global WebSocket", which is exactly the LAN path and exactly what a P2P path must not do.
    ...(config.createSocket === undefined ? {} : { createSocket: config.createSocket }),
  });

  let session: RollbackSession | null = null;
  let lastSyncTick = 0;
  const links: string[] = [];

  client.on('welcome', (message) => {
    if (message.t !== 'welcome') {
      return;
    }
    session = new RollbackSession({ localSlot: message.slot });
    client.sendReady(true);
    onSessionReady(session);
  });

  client.on('input', (message) => {
    if (message.t !== 'input' || session === null) {
      return;
    }
    // `decodeMessage` validated this payload already; it is the only path by which anything another
    // player did is allowed to reach the simulation. The wire shape is projected to the shape the
    // simulation reads, so the engine never has to know what a socket is.
    session.receiveRemoteInput(message.slot, message.tick, inputFromWire(message.input));
  });

  client.on('roster', (message) => {
    if (message.t !== 'roster' || session === null) {
      return;
    }
    // A slot that just went unconnected goes neutral from the tick about to be simulated. The
    // roster broadcast is the shared clock: every peer learns the departure in the same message,
    // so all four sessions agree on the tick without negotiating it.
    const present = new Set(message.entries.filter((entry) => entry.connected).map((e) => e.slot));
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      if (!present.has(slot) && slot !== session.localSlot && !session.isDeparted(slot)) {
        session.markDeparted(slot, session.tick + 1);
      }
    }
  });

  client.on('lan-ip-reply', (message) => {
    if (message.t === 'lan-ip-reply') {
      links.length = 0;
      links.push(...message.urls);
    }
  });
  client.requestLanIp();

  if (!client.connect()) {
    return null;
  }

  return {
    client,
    get session() {
      return session;
    },
    get live() {
      return session !== null;
    },
    step(localInput: FrameInput): SimEvent[] {
      if (session === null) {
        return [];
      }
      // 0 input delay: the input sampled this frame is consumed by the tick that runs right now.
      const result = session.advance(localInput);
      client.sendInput(result.tick, canonicalizeInput(localInput));
      return [...result.events];
    },
    pump(): void {
      config.extraPump?.();
      client.poll();
      if (session === null) {
        return;
      }
      // A hash every 30 ticks — twice a second — localises a divergence without flooding a phone's
      // socket four times per tick.
      if (session.tick - lastSyncTick >= 30) {
        lastSyncTick = session.tick;
        client.sendSync(session.tick, session.hash());
      }
    },
    status(): string {
      const latency = client.latency;
      switch (client.state) {
        case 'unavailable':
          return `${config.label}: no transport in this browser`;
        case 'rejected':
          return `${config.label}: rejected by the room (all four slots taken, or version mismatch)`;
        case 'closed':
          return `${config.label}: connection closed`;
        default:
          break;
      }
      if (session === null) {
        return `${config.label}: ${client.state}…`;
      }
      const peers = client.roster.filter((entry) => entry.connected).length;
      const stats = session.stats;
      const rewind = stats.maxRewindTicks > 0 ? ` (max −${stats.maxRewindTicks})` : '';
      return (
        `${config.label}: slot ${session.localSlot + 1}/${peers} · ${latency.rttMs.toFixed(0)}ms` +
        ` ±${latency.jitterMs.toFixed(0)} · rollbacks ${stats.rollbacks}${rewind}`
      );
    },
    joinLinks(): readonly string[] {
      return links;
    },
  };
}

// -------------------------------------------------------------------------------------------
// Peer-to-peer (Phase 6): the first browser hosts the room, in this tab
// -------------------------------------------------------------------------------------------

/**
 * The P2P half of the client, as the panel sees it.
 *
 * Deliberately narrower than `LanMatch`: this is the *room*, not the match. The match is an ordinary
 * `LanMatch` built over a socket this layer hands it, which is what keeps a P2P session and a LAN
 * session on the same netcode path — the rollback engine, the wire protocol and the referee cannot
 * tell them apart.
 */
interface P2pRoom {
  readonly kind: 'host' | 'guest';
  /** `UR-XXXX`, or null when the page was handed a room code it could not parse. */
  readonly roomCode: string | null;
  /** One line for the panel: what the broker is doing, and how many guests have arrived. */
  status(): string;
  /**
   * What to do when the room exists but has not opened.
   *
   * A P2P room with no broker is the *expected* failure on a fresh checkout — the page's own origin
   * serves no `/signal` endpoint — so the panel says which URL it tried and the command that fixes
   * it, instead of showing a status line that never changes.
   */
  hint(): string;
  /** The URL a guest scans. */
  joinLinks(): readonly string[];
  close(): void;
}

/** This page's own URL, or an empty string where there is no `location` (headless import). */
function pageUrl(): string {
  return typeof location === 'undefined' ? '' : location.href;
}

/**
 * How often the in-browser referee sweeps for silent peers.
 *
 * Matches `LanRelayServer`'s default sweep period. A peer that has gone quiet for longer than the
 * handshake window is dropped; anything shorter would reap a phone whose screen merely locked.
 */
const RELAY_SWEEP_INTERVAL_MS = 2000;

/**
 * Host the room in this tab, and play slot 0 in it.
 *
 * The host is not a special case anywhere below this function: `attachLocal()` hands back an
 * in-memory socket, the same kind of socket a guest gets from a data channel, and the *same*
 * `createLanMatch` builds the session on it. Everything the host does for its guests — answering a
 * `join`, relaying their inputs, arbitrating hashes — happens inside the referee that
 * `InBrowserP2pHost` already owns.
 *
 * Returns null when the browser cannot host at all (no `WebSocket` for the broker, no
 * `RTCPeerConnection`), which the caller renders as a status line rather than a dead button.
 */
function createP2pHostRoom(onSessionReady: (session: RollbackSession) => void): {
  room: P2pRoom;
  match: LanMatch;
} | null {
  if (typeof WebSocket !== 'function' || typeof RTCPeerConnection !== 'function') {
    return null;
  }
  const host = new InBrowserP2pHost({
    name: 'host',
    signalUrl: signalBrokerUrl(pageUrl()),
  });
  // Slot 0 is this browser, wired into the referee in this same tab.
  const local = host.relay.attachLocal();

  // The referee's idle sweep, throttled to the relay's own cadence.
  //
  // `pump` runs once per rendered frame, and an unthrottled sweep would walk the peer table 60 times
  // a second to do what the Node relay does every two seconds. It also has to be *driven* rather than
  // self-timed: a `setInterval` keeps running in a backgrounded tab, which is exactly when a host tab
  // should be doing nothing.
  let lastSweepMs = 0;
  host.relay.sweep();

  const match = createLanMatch(onSessionReady, {
    label: 'p2p',
    name: host.relay.localName,
    room: host.roomCode,
    createSocket: () => local.socket,
    url: `p2p://${host.roomCode}`,
    extraPump: () => {
      const now = performance.now();
      if (now - lastSweepMs < RELAY_SWEEP_INTERVAL_MS) {
        return;
      }
      lastSweepMs = now;
      host.relay.sweep();
    },
  });
  if (match === null) {
    host.close();
    return null;
  }
  host.start();

  return {
    match,
    room: {
      kind: 'host',
      roomCode: host.roomCode,
      status: () => host.status,
      hint: () => host.brokerHint,
      joinLinks: () => [roomJoinUrl(host.roomCode, pageUrl())],
      close: () => {
        host.close();
        match.client.close();
      },
    },
  };
}

/**
 * Join a room hosted by another browser.
 *
 * Nothing exists yet when this returns: the socket arrives when the data channel opens, and only then
 * is there a `LanMatch` to install. That is why `install` is a callback rather than a return value —
 * the frame loop has to be able to start offline and pick up the session when it lands, exactly as it
 * does on the LAN path while a relay is still assigning a slot.
 *
 * `invalidReason` is returned instead of throwing when `?room=` is not a room code: somebody reading
 * a code aloud off a screen mistyped it, and the useful response is "that is not a room code", not a
 * stack trace.
 */
function createP2pGuestRoom(
  onSessionReady: (session: RollbackSession) => void,
  install: (match: LanMatch) => void,
  rawRoom: string,
): { room: P2pRoom; match: null } | { invalidReason: string } {
  const room = normalizeRoomCode(rawRoom);
  if (room === null) {
    return { invalidReason: `"${rawRoom}" is not a room code — expected UR-XXXX` };
  }
  if (typeof WebSocket !== 'function' || typeof RTCPeerConnection !== 'function') {
    return { invalidReason: 'this browser cannot do peer-to-peer (no WebRTC or no WebSocket)' };
  }

  let guest: InBrowserP2pGuest;
  try {
    guest = new InBrowserP2pGuest({
      roomCode: room,
      name: 'guest',
      signalUrl: signalBrokerUrl(pageUrl()),
      // The client is built here, inside the callback, and that is load-bearing: by the time
      // negotiation finishes the channel is already open, and `WebRtcDataChannelSocket` replays its
      // `open` on a microtask. A client created a turn later would never hear it, and would sit in
      // "connecting" forever having never sent its `hello`.
      onChannel: (socket: SocketLike) => {
        const match = createLanMatch(onSessionReady, {
          label: 'p2p',
          name: 'guest',
          room,
          createSocket: () => socket,
          url: `p2p://${room}`,
        });
        if (match !== null) {
          install(match);
        }
      },
    });
  } catch (error) {
    return { invalidReason: `could not start: ${String(error)}` };
  }
  guest.start();

  return {
    match: null,
    room: {
      kind: 'guest',
      roomCode: room,
      status: () => guest.status,
      hint: () => guest.brokerHint,
      joinLinks: () => [roomJoinUrl(room, pageUrl())],
      close: () => guest.close(),
    },
  };
}

/**
 * The corner panel: join link, QR code, and a copy button.
 *
 * DOM only, and entirely best-effort — a phone that has no clipboard still sees the URL, which is
 * the part that actually matters. Returns false when there is no document to mount into.
 */
function mountLanPanel(root: HTMLElement, lan: LanMatch): boolean {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:12px;top:12px;font:11px/1.5 ui-monospace,monospace;color:#cfd4dc;' +
    'background:rgba(12,14,18,.82);border:1px solid #2a2e35;border-radius:8px;padding:10px;' +
    'max-width:220px;z-index:10';

  const title = document.createElement('div');
  title.textContent = 'HOUSE LAN';
  title.style.cssText = 'letter-spacing:.22em;color:#7dd83c;margin-bottom:6px';

  const status = document.createElement('div');
  status.style.whiteSpace = 'pre';

  const link = document.createElement('div');
  link.style.cssText = 'margin-top:6px;word-break:break-all;color:#8b9099';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'margin-top:8px;width:168px;height:168px;background:#fff;border-radius:4px';

  const copy = document.createElement('button');
  copy.textContent = 'copy join link';
  copy.style.cssText =
    'margin-top:8px;width:100%;font:inherit;padding:4px 6px;background:#20242b;color:#cfd4dc;' +
    'border:1px solid #2a2e35;border-radius:4px;cursor:pointer';

  panel.append(title, status, link, canvas, copy);
  root.appendChild(panel);

  let renderedFor: string | null = null;
  let lastStatus = '';

  copy.addEventListener('click', () => {
    const url = lan.joinLinks()[0] ?? location.href;
    // `navigator.clipboard` is absent on plain http origins in some browsers, so failure is
    // expected and simply leaves the visible URL as the fallback.
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  });

  const refresh = (): void => {
    const next = lan.status();
    if (next !== lastStatus) {
      status.textContent = next;
      lastStatus = next;
    }

    const advertised = lan.joinLinks()[0];
    // Fall back to this page's own origin: on the machine hosting the game that is already a URL a
    // phone on the same Wi-Fi can open, and it costs one request to ask the relay for better ones.
    const url = advertised ?? location.href;
    if (url !== renderedFor) {
      renderedFor = url;
      link.textContent = url;
      const code = encodeQr(url, { errorCorrection: 'M' });
      if (!mountQr(canvas, code)) {
        canvas.style.display = 'none';
      }
    }
  };

  // `refresh` is idempotent and cheap, so the frame loop drives it rather than owning a timer.
  (lan as { panelRefresh?: () => void }).panelRefresh = refresh;
  refresh();
  return true;
}

/**
 * The peer-to-peer panel: host a room, or type a code into somebody else's.
 *
 * Always mounted, because the two questions a new player asks — "how do I get three other people in
 * here" and "is there anything to run" — have to be answerable from a cold page load with no query
 * flags and no server. A panel that only appears once a room exists cannot answer either.
 *
 * While hosting it shows the room code, a QR of `?room=UR-XXXX`, and a copy button, which is the same
 * three-part affordance the LAN panel uses for an IP address — the difference is that this one needs
 * nothing installed on the guest's machine.
 *
 * Returns a refresh function rather than owning a timer, like the mode panel: the frame loop already
 * runs, and a panel that polls on its own keeps updating on a tab nobody is looking at.
 */
function mountP2pPanel(
  root: HTMLElement,
  api: {
    onHost: () => void;
    onJoin: (room: string) => void;
    /** Current room state. `roomCode` is null until there is a room to advertise. */
    describe: () => {
      status: string;
      roomCode: string | null;
      joinUrl: string | null;
      /** Shown under the status while the room has not opened yet. */
      hint: string;
    };
  },
): () => void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:12px;bottom:12px;font:11px/1.5 ui-monospace,monospace;color:#cfd4dc;' +
    'background:rgba(12,14,18,.82);border:1px solid #2a2e35;border-radius:8px;padding:10px;' +
    'max-width:220px;z-index:10';

  const title = document.createElement('div');
  title.textContent = 'PEER-TO-PEER';
  title.style.cssText = 'letter-spacing:.22em;color:#7dd83c;margin-bottom:6px';

  const status = document.createElement('div');
  status.style.cssText = 'white-space:pre;color:#8b9099';

  // The "you probably need a broker" line. Kept visually subordinate to the status so a room that is
  // merely still negotiating does not look like an error.
  const hint = document.createElement('div');
  hint.style.cssText = 'white-space:pre-wrap;margin-top:4px;color:#6b7078';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-top:8px';

  const style =
    'font:inherit;padding:5px 8px;background:#20242b;color:#cfd4dc;border:1px solid #2a2e35;' +
    'border-radius:4px;cursor:pointer';

  const host = document.createElement('button');
  host.textContent = 'Host P2P';
  host.title = 'Run the room in this tab — nobody has to install or run a server';
  host.style.cssText = style;
  host.addEventListener('click', () => api.onHost());

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'UR-XXXX';
  input.spellcheck = false;
  input.autocapitalize = 'characters';
  input.style.cssText =
    'font:inherit;padding:4px 6px;width:82px;background:#161a20;color:#cfd4dc;' +
    'border:1px solid #2a2e35;border-radius:4px';

  const join = document.createElement('button');
  join.textContent = 'Join';
  join.title = 'Connect straight to the browser hosting that room';
  join.style.cssText = style;
  const attemptJoin = (): void => {
    const room = input.value;
    input.value = '';
    api.onJoin(room);
  };
  join.addEventListener('click', attemptJoin);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      attemptJoin();
    }
  });

  row.append(host, input, join);

  const code = document.createElement('div');
  code.style.cssText = 'margin-top:8px;font-size:16px;letter-spacing:.18em;color:#7dd83c';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'margin-top:6px;width:168px;height:168px;background:#fff;border-radius:4px';

  const copy = document.createElement('button');
  copy.textContent = 'copy join link';
  copy.style.cssText = `${style};width:100%;margin-top:6px`;

  panel.append(title, status, hint, row, code, canvas, copy);
  root.appendChild(panel);

  copy.addEventListener('click', () => {
    const url = api.describe().joinUrl ?? pageUrl();
    // `navigator.clipboard` is absent on plain http origins in some browsers, so failure is expected
    // and simply leaves the visible code as the fallback.
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  });

  let lastStatus = '';
  let renderedFor: string | null = null;
  let lastCode = '';
  let lastHint = '';

  return (): void => {
    const { status: next, roomCode, joinUrl, hint: nextHint } = api.describe();
    if (next !== lastStatus) {
      status.textContent = next;
      lastStatus = next;
    }
    // The hint disappears the moment the room opens, so a live session is not cluttered by advice
    // about a problem it no longer has.
    if (nextHint !== lastHint) {
      lastHint = nextHint;
      hint.textContent = nextHint;
    }
    if (roomCode !== lastCode) {
      lastCode = roomCode ?? '';
      code.textContent = roomCode ?? '';
      // Nothing to scan before there is a room: an empty QR canvas would read as "broken" rather than
      // "not hosting yet".
      canvas.style.display = roomCode === null ? 'none' : '';
      copy.style.display = roomCode === null ? 'none' : '';
      row.style.display = roomCode === null ? 'flex' : 'none';
    }
    if (joinUrl !== renderedFor) {
      renderedFor = joinUrl;
      if (joinUrl !== null) {
        if (!mountQr(canvas, encodeQr(joinUrl, { errorCorrection: 'M' }))) {
          canvas.style.display = 'none';
        }
      }
    }
  };
}

/**
 * The mode / CPU-fill control strip.
 *
 * A DOM control rather than keys alone, because the two things it does — "which match am I in"
 * and "am I playing against people or machines" — are the first two questions a new player asks,
 * and neither is discoverable from a key nobody has pressed yet. Every button is labelled with its
 * own shortcut so the keys stay findable.
 */
function mountModePanel(root: HTMLElement, actions: {
  onMode: (mode: GameModeId) => void;
  onCpuFill: (count: number) => void;
  onRematch: () => void;
  describe: () => string;
}): () => void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:12px;bottom:12px;font:11px/1.5 ui-monospace,monospace;color:#cfd4dc;' +
    'background:rgba(12,14,18,.82);border:1px solid #2a2e35;border-radius:8px;padding:10px;' +
    'min-width:210px;z-index:10';

  const status = document.createElement('div');
  status.style.cssText = 'white-space:pre;margin-bottom:8px;color:#8b9099';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

  const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const node = document.createElement('button');
    node.textContent = label;
    node.title = title;
    node.style.cssText =
      'font:inherit;padding:5px 8px;background:#20242b;color:#cfd4dc;border:1px solid #2a2e35;' +
      'border-radius:4px;cursor:pointer;flex:1 1 auto';
    node.addEventListener('click', onClick);
    return node;
  };

  const ffa = button('Free-For-All [M]', 'Switch to 4-player free-for-all', () =>
    actions.onMode('free_for_all'),
  );
  const team = button('2v2 Team [M]', 'Switch to 2v2 — P1+P3 against P2+P4', () =>
    actions.onMode('team_battle'),
  );
  const cpu = button('CPU fill [B]', 'Seat a CPU in every unclaimed slot, or clear them all', () =>
    actions.onCpuFill(0),
  );
  const again = button('Rematch [R]', 'Call a rematch on the victory screen', () => actions.onRematch());

  row.append(ffa, team, cpu, again);
  panel.append(status, row);
  root.appendChild(panel);

  let lastStatus = '';
  const refresh = (): void => {
    const next = actions.describe();
    if (next !== lastStatus) {
      status.textContent = next;
      lastStatus = next;
    }
  };
  refresh();
  return refresh;
}

function boot(): void {
  const container = document.getElementById('app');
  const status = document.getElementById('boot-status');
  const bootScreen = document.getElementById('boot');

  if (container === null) {
    return;
  }

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    if (status !== null) {
      status.textContent = 'WebGL unavailable — cannot start the arena.';
    }
    bootScreen?.setAttribute('data-state', 'failed');
    return;
  }
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, RENDER.maxPixelRatio));
  renderer.setSize(container.clientWidth || 1280, container.clientHeight || 720);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f13);
  scene.fog = new THREE.Fog(0x0d0f13, 18, 46);

  const { camera, framing } = createFramingCamera(
    (container.clientWidth || 1280) / (container.clientHeight || 720),
  );

  // Phase 4: the arena, the fighters, the impacts and the framing are each owned by one module.
  // `main.ts` is the wiring: it hands out sim records and consumes the event stream, and owns no
  // geometry, no audio graph and no HUD arithmetic of its own.
  const stage = buildStage();
  scene.add(stage.group);

  const vfx = new VfxSystem();
  scene.add(vfx.group);

  const sound = new SoundBoard();
  const hud = new ArcadeHud();
  hud.mount(container);

  // Phase 5: the match rules and the CPU fill.
  //
  // `MatchRules` is a pure function of the world — it never writes to a fighter — so the local
  // instance is a valid view of a match even when a LAN peer owns the authoritative world. The
  // roster, however, is chosen here, so `?mode=` rides the join URL and both ends start alike.
  let rules = new MatchRules({ mode: readModeFromUrl() });
  const ai = new AiController();

  // Mutable because a LAN session brings its own world: when the relay assigns a slot, the
  // rollback session's `MatchRunner` becomes the one being rendered. Offline it never changes.
  let runner: MatchRunner = new MatchRunner(rules.spawns);
  const roster = new CharacterRoster(scene);

  /**
   * Build one articulated rig per fighter.
   *
   * Re-runnable, because the LAN session's world is a different `MatchRunner` instance from the
   * offline one. Rebuilt rather than pooled: a rig is four dozen meshes with a per-archetype
   * skeleton, and a pool would have to be correct about *which* fighter it is standing in for —
   * precisely the kind of state that rots when a world is swapped underneath it.
   */
  function buildProxies(): void {
    roster.dispose();
    roster.build(runner.fighters);
    hud.reset();
  }

  buildProxies();

  // The developer readout. Separate from the arcade HUD on purpose: this is a diagnostic strip
  // (tick, hash, fps, roster) that a player should never have to look at, and the HUD in
  // `src/ui/hud.ts` is the thing they are actually playing against.
  const debug = document.createElement('div');
  debug.style.cssText =
    'position:fixed;left:12px;top:12px;font:12px/1.4 ui-monospace,monospace;color:#cfd4dc;' +
    'background:rgba(12,14,18,.72);border:1px solid #2a2e35;border-radius:6px;padding:8px 10px;' +
    'white-space:pre;pointer-events:none;z-index:6';
  document.body.appendChild(debug);

  // -------------------------------------------------------------------------------------------
  // Input stack: four pads, two keyboards, one touch overlay, four slots
  // -------------------------------------------------------------------------------------------

  const keyboard = new KeyboardSource();
  const gamepads = new GamepadSource();
  // The touch state is pure and lives in `src/ui/touch.ts`; the controller is the DOM half. A phone
  // gets the overlay, and a desktop with a touchscreen gets one on first touch — either way the
  // `JoinManager` sees the same pure state object.
  const touchState = new TouchInputState();
  const touchController = new TouchController({ state: touchState });
  touchController.attach();

  const join = new JoinManager({
    gamepads: gamepads.available ? gamepads : null,
    keyboard,
    touch: touchState,
  });

  // -------------------------------------------------------------------------------------------
  // Phase 5: match mode, the CPU fill and the round lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * Start a fresh match in `mode`: new roster, new world, new rules.
   *
   * Switching teams means the *fighters themselves* change (a fighter's team is world state, so it
   * is in the state hash), which is why this rebuilds the runner rather than reassigning a field.
   * Everything downstream — the rigs, the HUD's ghost bars, the lifecycle clock — is reset with it,
   * because a 2v2 must not open on a board that still has a half-healed Free-For-All on it.
   */
  function startMatch(mode: GameModeId): void {
    // On a LAN session the world belongs to the rollback session, and replacing it here would swap
    // a peer-owned world out from under the renderer and the netcode both. The mode rides the join
    // URL instead — that is how everyone in the house ends up on the same roster.
    if (lan !== null && lan.live) {
      matchBanner = 'mode is fixed once a LAN session is live — reload with ?mode= to change it';
      return;
    }
    rules = new MatchRules({ mode });
    runner = new MatchRunner(rules.spawns);
    buildProxies();
    matchBanner = `${modeDef(mode).label} — press start`;
  }

  /**
   * The CPU fill toggle.
   *
   * `0` is the default and is the honest one: with no devices connected a four-player board is
   * four fighters standing in a ring doing nothing. Turning it on seats a CPU in every slot nobody
   * has claimed, and `JoinManager` hands a CPU's slot straight back the moment a real device
   * appears — so this never locks a second player out.
   */
  function setCpuFill(count: number): void {
    cpuFill = Math.max(0, Math.min(count, join.maxSlots));
    join.setBotFill(cpuFill);
    if (cpuFill > 0) {
      matchBanner = `CPU fill: ${cpuFill} slot${cpuFill === 1 ? '' : 's'}`;
    }
  }

  /** Slots a CPU is currently driving. Recomputed each tick from the join table, never cached. */
  function botSlots(): number[] {
    const slots: number[] = [];
    for (const entry of join.slots) {
      if (entry.kind === 'bot') {
        slots.push(entry.slot);
      }
    }
    return slots;
  }

  /**
   * React to the match clock.
   *
   * A new round and a rematch both mean "rebuild the world", and the host owns that because the
   * world is its object — the rules decide *when*, the client decides *how*. Round timers are
   * carried across a reset deliberately: the AI hashes on the tick, and a timer that restarted at
   * zero every round would give every fighter the same opening string forever.
   *
   * On a LAN session the world belongs to the rollback engine instead, and it must not be reset
   * here: `MatchRunner.reset()` zeroes the tick counter, and the session's snapshot and confirmed
   * input rings are both indexed by it. Rewinding the tick to zero mid-session would leave those
   * rings describing a different fight than the one being played. The lifecycle still runs — it is
   * a pure function of the world, so the announcement is a correct local view — but the peer-owned
   * world is left alone.
   */
  function applyModeEvents(events: readonly ModeEvent[]): void {
    const worldIsOurs = !(lan !== null && lan.live);
    for (const event of events) {
      switch (event.type) {
        case 'ko':
          matchBanner = `P${event.slot + 1} K.O. — ${event.team === null ? 'free-for-all' : `team ${event.team}`}`;
          break;
        case 'timeout':
          matchBanner = `TIME — ${event.winner.label}`;
          break;
        case 'match_over':
          matchBanner = `VICTORY — ${event.winner.label}`;
          sound.spaCharge(2);
          break;
        case 'round_won':
        case 'rematch':
          if (worldIsOurs) {
            // A new round (and a new match) start from the spawn table, not from the old board.
            runner.reset();
            buildProxies();
          }
          break;
        default:
          break;
      }
    }
  }

  // Mode, CPU fill and rematch on keys that no keyboard layout claims. `M`, `B` and `R` are absent
  // from both `P1_KEYBOARD` (WASD + JKL + UCI O + Shift + C) and `P2_KEYBOARD` (arrows + numpad),
  // so a global shortcut here can never eat a player's attack press.
  const onGlobalKey = (event: KeyboardEvent): void => {
    if (event.repeat === true) {
      return;
    }
    switch (event.code) {
      case 'KeyM':
        startMatch(rules.mode === 'free_for_all' ? 'team_battle' : 'free_for_all');
        break;
      case 'KeyB':
        // 0 → 4 → 0: one key that walks the fill up and back off again.
        setCpuFill(cpuFill >= join.maxSlots ? 0 : cpuFill + 1);
        break;
      case 'KeyR':
        if (!rules.requestRematch(0)) {
          matchBanner = 'not on the victory screen yet';
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  globalThis.addEventListener?.('keydown', onGlobalKey);

  const onKeyDown = (event: KeyboardEvent): void => {
    // `repeat` is filtered inside the source: an OS auto-repeat is not a new press, and holding
    // J must not machine-gun the chain opener.
    keyboard.keyDown(event.code, event.repeat === true);
    if (keyboard.bindsKey(event.code)) {
      // Keys the game owns do not reach the browser: P2's arrows would scroll the page and the
      // arrow keys would move focus off the canvas mid-string.
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    keyboard.keyUp(event.code);
  };
  globalThis.addEventListener?.('keydown', onKeyDown);
  globalThis.addEventListener?.('keyup', onKeyUp);
  globalThis.addEventListener?.('blur', () => {
    keyboard.releaseAll();
    touchState.releaseAll();
  });

  let lastEvents: SimEvent[] = [];
  let fpsWindowStart = 0;
  let fpsFrames = 0;
  let fps = 0;
  let joinBanner = '';
  /** Mode announcements, kept to the last one. The lifecycle itself is in `rules`. */
  let matchBanner = '';
  /** How many empty slots the CPU fill is currently holding open. */
  let cpuFill = 0;

  /**
   * Did the simulation take the press this slot was handed?
   *
   * A move that starts on this tick reports `movePhaseFrame === 1` (the sim counts it up once, in
   * the same tick it began), and a dodge that started reports `stateFrame === 1`. Anything else
   * means the fighter was in recovery, stun or hitstop — in which case the buffer keeps the press
   * and re-offers it, which is what makes a confirm-press land.
   */
  function pressAccepted(fighter: Fighter, input: FrameInput): boolean {
    if (input.dodge !== 'none') {
      return (
        (fighter.state === 'dodge_high' || fighter.state === 'dodge_low') &&
        fighter.stateFrame <= 1
      );
    }
    if (input.attack !== null) {
      return fighter.currentMove !== null && fighter.movePhaseFrame === 1;
    }
    return false;
  }

  const resize = (): void => {
    const width = container.clientWidth || 1280;
    const height = container.clientHeight || 720;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  globalThis.addEventListener?.('resize', resize);

  // -------------------------------------------------------------------------------------------
  // Online: one socket, one rollback session — over a relay, or straight to another browser
  // -------------------------------------------------------------------------------------------

  /**
   * Take ownership of the world when a session lands.
   *
   * Shared by every online path. The rollback session owns its own `MatchRunner`, and handing the
   * renderer that world is the only change of ownership in the whole online path — the tick still
   * receives nothing but `FrameInput[]`, and the renderer still only reads fighter records back out.
   *
   * Refuses to swap a world out from under a live session: a P2P guest that re-negotiates, or a LAN
   * relay that restarts, would otherwise leave the renderer pointing at an abandoned match whose
   * tick counter no longer lines up with the session's snapshot rings.
   */
  const onSessionReady = (session: RollbackSession): void => {
    if (lan !== null && lan.live) {
      return;
    }
    runner = session.runner;
    buildProxies();
  };

  /**
   * The online half of the client, or null while playing offline.
   *
   * Mutable because a P2P guest has no transport until its data channel opens: the page boots and
   * plays offline, then picks up the session when negotiation lands — the same way the LAN path waits
   * for a relay to assign a slot. Both the frame loop and the mode logic read this variable, and
   * neither caches it.
   */
  let lan: LanMatch | null = null;

  /**
   * The P2P room this page is running, if any.
   *
   * Separate from `lan` because a guest's room exists long before (and survives past) its session,
   * and because the panel needs to show a room code that has nothing to do with a socket.
   */
  let p2p: P2pRoom | null = null;

  /** Why the page is not in a P2P room, when the URL asked for one and it could not be started. */
  let p2pProblem = '';

  const netFlags = readNetFlags();
  const panelFor = (match: LanMatch): void => {
    mountLanPanel(container, match);
  };

  // `netFlags.kind === 'off'` has no branch below on purpose: a page with no network flag plays
  // offline, exactly as it did before any of this existed.
  if (netFlags.kind === 'lan') {
    const host = netFlags.relayHost ?? (typeof location === 'undefined' ? '127.0.0.1' : location.hostname);
    lan = createLanMatch(onSessionReady, {
      label: 'lan',
      name: 'house',
      room: 'house',
      url: relayUrl(host === '' ? '127.0.0.1' : host, DEFAULT_RELAY_PORT),
    });
    if (lan !== null) {
      panelFor(lan);
    }
  }

  if (netFlags.kind === 'p2p-host') {
    const hosted = createP2pHostRoom(onSessionReady);
    if (hosted === null) {
      p2pProblem = 'this browser cannot host peer-to-peer (no WebRTC or no WebSocket)';
    } else {
      p2p = hosted.room;
      lan = hosted.match;
      panelFor(hosted.match);
    }
  }

  if (netFlags.kind === 'p2p-guest') {
    const joined = createP2pGuestRoom(
      onSessionReady,
      (match) => {
        lan = match;
        panelFor(match);
      },
      netFlags.room,
    );
    if ('invalidReason' in joined) {
      p2pProblem = joined.invalidReason;
    } else {
      p2p = joined.room;
    }
  }

  /**
   * Drop whatever room this tab was in.
   *
   * Both panel actions go through here, because two rooms in one tab means two rollback sessions
   * driving one world: the second would win silently, and the first would keep publishing inputs for
   * a fighter the renderer has already thrown away.
   */
  const leaveRoom = (): void => {
    p2p?.close();
    p2p = null;
    lan?.client.close();
    lan = null;
  };

  /**
   * The P2P panel.
   *
   * Mounted on every page, not only when a room exists, so the "Host P2P" button is where the panel
   * it is on rather than behind a query flag. Its two actions both end up in exactly one place —
   * `createP2pHostRoom` / `createP2pGuestRoom` — so the `?p2p` and `?room=` cold-start paths and the
   * button path cannot drift apart.
   */
  const refreshP2pPanel = mountP2pPanel(container, {
    onHost: () => {
      if (p2p !== null) {
        return;
      }
      leaveRoom();
      const hosted = createP2pHostRoom(onSessionReady);
      if (hosted === null) {
        p2pProblem = 'this browser cannot host peer-to-peer (no WebRTC or no WebSocket)';
        return;
      }
      p2p = hosted.room;
      p2pProblem = '';
      lan = hosted.match;
      panelFor(hosted.match);
    },
    onJoin: (room) => {
      if (room.trim() === '') {
        return;
      }
      leaveRoom();
      const joined = createP2pGuestRoom(
        onSessionReady,
        (match) => {
          lan = match;
          panelFor(match);
        },
        room,
      );
      if ('invalidReason' in joined) {
        p2pProblem = joined.invalidReason;
        return;
      }
      p2p = joined.room;
      p2pProblem = '';
    },
    describe: () => ({
      status:
        p2pProblem !== ''
          ? p2pProblem
          : (p2p?.status() ?? 'no server needed — host, or type a room code'),
      roomCode: p2p?.roomCode ?? null,
      joinUrl: p2p?.joinLinks()[0] ?? null,
      // Advice, not error: shown while a room exists but has no session yet, and dropped as soon as
      // one lands.
      hint: p2p !== null && (lan === null || !lan.live) ? p2p.hint() : '',
    }),
  });

  const refreshModePanel = mountModePanel(container, {
    onMode: (mode) => startMatch(mode),
    // `0` means "toggle": filled goes empty, empty goes full. One button for both, matching what
    // its own label promises.
    onCpuFill: (count) => setCpuFill(cpuFill > 0 ? count : join.maxSlots),
    onRematch: () => {
      if (!rules.requestRematch(0)) {
        matchBanner = 'not on the victory screen yet';
      }
    },
    describe: () => `${rules.describe()}\nCPU fill ${cpuFill}/${join.maxSlots}`,
  });

  // -------------------------------------------------------------------------------------------
  // Event stream -> presentation
  // -------------------------------------------------------------------------------------------

  /** World position of a fighter's chest, in world units. */
  function chestOf(fighter: Fighter | undefined, out: THREE.Vector3): THREE.Vector3 {
    if (fighter === undefined) {
      return out.set(0, 1.2, 0);
    }
    return out.set(fighter.x / FP_SCALE, fighter.y / FP_SCALE + 1.15, fighter.z / FP_SCALE);
  }

  const scratchA = new THREE.Vector3();
  const scratchB = new THREE.Vector3();
  const contactPoint = new THREE.Vector3();

  /**
   * Turn one tick of sim events into sparks, dust, rings, shake and sound.
   *
   * Every decision here is read out of the event rather than re-derived: a block event throws
   * block sparks and not a hit, a knockdown throws dust at the floor, an SPA event throws a ring
   * sized by its tier, and the camera shake scales off the damage the simulation actually dealt.
   * The renderer never decides *whether* something connected — only how it looks.
   */
  function present(events: readonly SimEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'hit': {
          const attacker = runner.fighterAt(event.attackerSlot);
          const defender = runner.fighterAt(event.defenderSlot);
          // Contact sits between the two fighters, on the defender's side: a spark at the
          // attacker's fist reads as a miss.
          chestOf(attacker, scratchA);
          chestOf(defender, scratchB);
          contactPoint.copy(scratchA).lerp(scratchB, 0.68);

          const power = Math.min(Math.max(event.damage / 60, 0.2), 1.4);
          if (event.guarded) {
            vfx.block({ position: contactPoint, power });
            framing.shake(0.12);
          } else {
            vfx.hit({ position: contactPoint, power });
            if (event.knockdown) {
              vfx.knockdownDust({
                position: scratchB.setY(defender === undefined ? 0.1 : defender.y / FP_SCALE + 0.05),
                power,
              });
            }
            // A launcher or a heavy hit gets a real kick; a jab gets a nudge. Trauma is squared
            // by the camera, so these numbers are the square root of what the player feels.
            framing.shake(event.launcher || event.damage >= 45 ? 0.5 : 0.16 * power);
          }
          break;
        }

        case 'dodge': {
          const dodger = runner.fighterAt(event.slot);
          chestOf(dodger, contactPoint);
          if (event.outcome === 'reversal') {
            vfx.shockwave({ position: contactPoint, power: 0.6 }, 1);
            framing.shake(0.35);
          } else {
            vfx.slip({ position: contactPoint });
            sound.spaCharge(1);
          }
          break;
        }

        case 'wallImpact': {
          const fighter = runner.fighterAt(event.slot);
          chestOf(fighter, contactPoint);
          vfx.knockdownDust({ position: contactPoint, power: 0.8 });
          vfx.hit({ position: contactPoint, power: 0.6 });
          framing.shake(0.3);
          break;
        }

        case 'spa': {
          const caster = runner.fighterAt(event.slot);
          chestOf(caster, contactPoint);
          vfx.shockwave({ position: contactPoint, power: 0.8 }, event.tier);
          framing.shake(0.4);
          break;
        }

        default:
          break;
      }
    }

    // Audio is handed the same stream the VFX just consumed: the sound board makes its own
    // mapping from `damage`, `guarded`, `launcher` and `tier`, so the two never drift apart.
    sound.consume(events);
  }

  /**
   * Air-move on a strike starting.
   *
   * The sim emits no "move began" event — it emits contact — so this watches each fighter's
   * `currentMove` for a change instead. A move that whiffs still makes its sound, which is what
   * the player needs: a whiffed swing is information.
   */
  const announcedMove = new Map<number, string | null>();

  function announceStrikes(): void {
    for (const fighter of runner.fighters) {
      const previous = announcedMove.get(fighter.slot) ?? null;
      if (fighter.currentMove !== previous) {
        announcedMove.set(fighter.slot, fighter.currentMove);
        if (fighter.currentMove !== null && fighter.state === 'startup') {
          sound.whoosh(0.5);
        }
      }
      if (fighter.state === 'getup') {
        sound.getup();
      }
    }
  }

  /** Seconds since the previous rendered frame, for the display-clock-driven layers. */
  let lastFrameMs = 0;

  const loop = startFixedLoop({
    fixedUpdate: (dt) => {
      // The tick the world is about to run. Input is sampled for *this* tick, never for the last
      // one, so a 144Hz host and a 30Hz host feed the simulation the same presses in the same order.
      const tick = runner.tick + 1;
      const joinEvents = join.poll(tick);
      let inputs = join.frameInputs(tick);

      let events: SimEvent[];
      if (lan !== null && lan.live) {
        // Online: only *this* machine's input is fed in. The other three fighters are driven by
        // their owners' inputs as they arrive, with the rollback session guessing in between.
        const localSlot = lan.session?.localSlot ?? 0;
        events = lan.step(inputs[localSlot] ?? NEUTRAL_INPUT);
        void dt; // the rollback session advances whole 1/60 ticks; it never takes a variable dt
      } else {
        // The CPU fill goes in *after* the humans and *before* the sim, and it only ever replaces
        // slots the join table says are CPU-held. A bot is a source of `FrameInput` like any other
        // device — it never touches a fighter record.
        const bots = botSlots();
        if (bots.length > 0) {
          inputs = ai.fill(runner, inputs, bots);
        }
        // Outside the fight — countdown, knockout hold, victory, rematch — every fighter's input is
        // discarded. Without this a buffered press made during the countdown would land on the
        // first tick of the fight, which is a free head start nobody agreed to.
        if (rules.blocksInput) {
          inputs = runner.fighters.map(() => ({ ...NEUTRAL_INPUT }));
        }

        events = runner.fixedUpdate(dt, inputs);

        // Feed the result back so the buffer knows whether each press was taken: an accepted press
        // is done, a rejected one stays queued for the next tick until the 8-tick window closes.
        //
        // Skipped online on purpose: a rollback can invalidate the very state that would have
        // accepted or rejected the press, so settling against it would let a buffered confirm
        // commit on a state that never existed. The input layer re-offers the press instead.
        join.settle(
          tick,
          runner.fighters.map((fighter, slot) =>
            pressAccepted(fighter, inputs[slot] ?? { ...NEUTRAL_INPUT }),
          ),
        );
      }

      // The lifecycle advances on every path, online included: `MatchRules` is a pure function of
      // the world, so a local instance is always a correct view of a peer-owned match. It never
      // writes to a fighter — the reset it requests is applied below, by whoever owns the world.
      applyModeEvents(rules.step(runner, events));

      for (const event of joinEvents) {
        joinBanner =
          event.type === 'join'
            ? `slot ${event.slot + 1} · ${event.label} joined`
            : event.type === 'leave'
              ? `slot ${event.slot + 1} · ${event.label} left`
              : joinBanner;
      }
      if (events.length > 0) {
        lastEvents = events;
      }
    },
    render: (frameCount) => {
      lan?.pump();
      (lan as { panelRefresh?: () => void } | null)?.panelRefresh?.();
      refreshModePanel();
      refreshP2pPanel();

      // Seconds since the last rendered frame. The VFX and the HUD's damage ghost are the two
      // things in this client that run on the display clock rather than the sim clock — both are
      // smoothing cues for the eye, and both would look wrong if they ticked at 60Hz on a 240Hz
      // screen. Clamped so a backgrounded tab does not dump four seconds of decay into one frame.
      const now = performance.now();
      const dt = lastFrameMs === 0 ? 1 / 60 : Math.min((now - lastFrameMs) / 1000, 0.1);
      lastFrameMs = now;

      // Presentation reads sim state; it never writes to it.
      roster.update(runner.fighters);
      announceStrikes();
      present(lastEvents);
      vfx.update(dt);
      framing.update(runner.fighters, dt);

      hud.sync({
        fighters: runner.fighters,
        events: lastEvents,
        dt,
        tick: runner.tick,
        // The joined device's label is more useful in a corner than "1P" once one exists.
        tags: join.slots.map((entry) =>
          entry.kind === 'empty' ? defaultTag(entry.slot) : entry.label,
        ),
        // The announcement ladder comes straight from the lifecycle; the HUD only draws it.
        banner: rules.banner(),
      });

      renderer.render(scene, camera);

      fpsFrames += 1;
      const clock = performance.now();
      if (fpsWindowStart === 0) {
        fpsWindowStart = clock;
      } else if (clock - fpsWindowStart >= 500) {
        fps = Math.round((fpsFrames * 1000) / (clock - fpsWindowStart));
        fpsFrames = 0;
        fpsWindowStart = clock;
      }

      const hits = lastEvents.filter(isHit).length;
      const hash = runner.stateHash();
      const devices = join.slots
        .map((slot) => `${slot.slot + 1}:${slot.kind === 'empty' ? '—' : slot.label}`)
        .join('  ');
      const roundClock = rules.roundTimeLeft;
      const clockLine = roundClock === null ? '' : `  ·  ${(roundClock / 60).toFixed(1)}s`;
      // Offline the readout shows the local join roster; online the local devices are all feeding
      // one slot, so the relay's roster is the honest thing to show.
      const lanLine = lan === null ? '' : `${lan.status()}\n`;
      // The room state sits beside the session state: "p2p UR-AB12: hosting · 2 guests connected" is
      // the answer to "is anybody actually in here", which the slot line alone cannot give.
      const p2pLine =
        p2pProblem !== '' ? `${p2pProblem}\n` : p2p === null ? '' : `${p2p.status()}\n`;
      debug.textContent =
        `${TICK_HZ}Hz fixed  ·  tick ${runner.tick}  ·  ${fps}fps  ·  frames ${frameCount}\n` +
        `hash ${hash}  ·  events ${lastEvents.length} (${hits} hits)\n` +
        `cam ${framing.boom.toFixed(1)}m  ·  ${framing.framing.count} in frame${clockLine}` +
        `${sound.enabled ? '' : '  ·  audio off'}\n` +
        `${rules.describe()}${matchBanner === '' ? '' : `\n${matchBanner}`}\n` +
        `${lanLine}${p2pLine}${devices}${joinBanner === '' ? '' : `\n${joinBanner}`}`;
    },
  });

  loop.start();
  bootScreen?.setAttribute('data-state', 'running');

  // Debug handle for the browser console, replay tools and manual netcode checks.
  // `runner` is a getter rather than a captured value because a LAN session swaps the world out
  // from under it; a captured reference would point at the abandoned offline match.
  (globalThis as unknown as { __UR__?: unknown }).__UR__ = {
    get runner() {
      return runner;
    },
    scene,
    renderer,
    loop,
    join,
    // Phase 6: `lan` is a `let` (a P2P guest's session lands after boot) and `p2p` may be null, so
    // both are exposed as getters — a snapshot here would be stale by the time anybody looked.
    get lan() {
      return lan;
    },
    get p2p() {
      return p2p;
    },
    keyboard,
    gamepads,
    touch: touchState,
    touchController,
    stage,
    roster,
    vfx,
    framing,
    hud,
    sound,
    // Phase 5 handles. `rules` and `ai` are exposed by reference — unlike `runner`, they are
    // reassigned when the mode changes, and a console poking at the abandoned first match would be
    // a genuinely confusing thing to debug.
    get rules() {
      return rules;
    },
    ai,
    startMatch,
    setCpuFill,
    botSlots,
  };

  // Release every GPU and audio resource this client owns. A reload that leaks four articulated
  // rigs and an open `AudioContext` is how a long LAN session ends up running at half speed.
  globalThis.addEventListener?.('beforeunload', () => {
    globalThis.removeEventListener?.('keydown', onGlobalKey);
    // Tear the room down before the peer connections: a host tab that unloads without telling its
    // referee leaves every guest waiting out a channel that will never answer.
    p2p?.close();
    lan?.client.close();
    loop.stop();
    roster.dispose();
    stage.dispose();
    vfx.dispose();
    hud.dispose();
    sound.dispose();
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}