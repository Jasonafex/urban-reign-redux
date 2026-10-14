/**
 * House-LAN relay server (AGENTS.md §3.3).
 *
 * One process per house, listening on `8765`. It binds a port, hands each connection to the room
 * referee, and tells the house which addresses it is reachable on. The *decisions* — which slot a
 * peer gets, when the roster changes, who hears which input, who disagreed about a tick — live in
 * `src/net/room.ts`, because the same referee has to run inside the first browser's tab for the
 * WebRTC path (`src/net/webrtc.ts`). One implementation, two transports, identical room semantics.
 *
 * ## What is left here, and why
 *
 *   1. **Socket lifecycle** — `ws` server, connection bookkeeping, the idle sweep timer, and
 *      shutdown. Everything socket-shaped lives in this file and nowhere else.
 *   2. **Address discovery** — enumerating the LAN IPv4 addresses a phone can dial and formatting
 *      join URLs, because only a process with a real network stack knows them.
 *
 * The relay is deliberately *not* part of the simulation's trust boundary. `src/net/rollback.ts`
 * and `src/net/protocol.ts` are pure and headless; nothing in `src/sim`, `src/combat` or `src/core`
 * imports this file.
 *
 * ## Wall-clock use is allowed here
 *
 * This is a transport and a lobby, not a tick. It reads a clock for peer timeouts and ping probes,
 * which is exactly the wall-clock use AGENTS.md §3.2 forbids *inside physics, combat and input
 * buffering*. No hash, no input and no state in this file depends on when a packet arrived.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  tryEncodeMessage,
  joinUrls,
  selectLanIPv4,
  type NetworkInterfaces,
} from './protocol';
import { RoomCoordinator, type RoomPeerSummary, type RoomTransport } from './room';

export { AUDIT_WINDOW_TICKS, HANDSHAKE_TIMEOUT_MS } from './room';
export type { RoomPeerSummary as RelayPeerSummary } from './room';

export interface RelayAddress {
  readonly port: number;
  readonly host: string;
  /** LAN IPv4 addresses other devices in the house can dial. */
  readonly ips: readonly string[];
  /** Join URLs encoding the *web client* (not the relay) — these are what the QR code shows. */
  readonly joinUrls: readonly string[];
}

/** Default port the *web client* is served on (see `vite.config.ts`). */
export const DEFAULT_WEB_PORT = 5173;

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

/**
 * Valid close codes for `WebSocket.close`. `ws` throws on anything outside 1000–4999, and a
 * throw inside a transport's own `close` would escape into the referee's shutdown loop.
 */
function normaliseCloseCode(code: number | undefined): number {
  return typeof code === 'number' && code >= 1000 && code <= 4999 ? code : 1000;
}

export class LanRelayServer {
  private readonly wss: WebSocketServer;
  private readonly host: string;
  private readonly port: number;
  private readonly webPort: number;
  private readonly sweepMs: number;
  private readonly log: (message: string) => void;
  private readonly coordinator: RoomCoordinator;

  /** Socket → peer id, the only per-connection state this transport owns. */
  private readonly bySocket = new Map<WebSocket, string>();

  private listening = false;
  private stopped = false;
  private sweepHandle: ReturnType<typeof setInterval> | null = null;
  private boundAddress: RelayAddress | null = null;

  constructor(options: RelayServerOptions = {}) {
    this.port = options.port ?? DEFAULT_RELAY_PORT;
    this.host = options.host ?? '0.0.0.0';
    this.webPort = options.webPort ?? DEFAULT_WEB_PORT;
    this.sweepMs = options.sweepIntervalMs ?? 2000;
    this.log = options.log ?? ((message: string) => console.log(message));

    this.coordinator = new RoomCoordinator({
      maxPlayers: options.maxPlayers ?? MAX_PLAYERS,
      stage: options.stage,
      seed: options.seed,
      now: options.now,
      log: this.log,
      // Read lazily: the bound port is not known until `start()`, and a peer may ask before then.
      lanAddress: () => ({
        port: this.boundAddress?.port ?? this.port,
        urls: this.joinUrls,
      }),
    });

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
    // The referee refuses every remaining peer and closes their sockets; the `close` events that
    // follow land in `onSocketClose`, find nothing left to do, and are ignored.
    this.coordinator.close('relay shutting down');
    this.bySocket.clear();
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

  get peers(): readonly RoomPeerSummary[] {
    return this.coordinator.peersList;
  }

  /** Highest tick any peer has claimed. Used to prune the audit window. */
  get currentTick(): number {
    return this.coordinator.currentTick;
  }

  /**
   * Drop peers that went quiet, and prune audit history.
   *
   * Public so `server-cli.ts` can drive it on its own timer, and so `test/lan.test.mjs` can force a
   * sweep with a fake clock instead of sleeping.
   */
  sweep(): void {
    this.coordinator.sweep();
  }

  /** Broadcast the current roster to everyone. */
  broadcastRoster(): void {
    this.coordinator.broadcastRoster();
  }

  // -----------------------------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const transport: RoomTransport = {
      send: (message) => {
        const text = tryEncodeMessage(message);
        if (text === null) {
          return;
        }
        try {
          socket.send(text);
        } catch {
          // The socket is going away; `close` will clean up.
        }
      },
      close: (code, reason) => {
        try {
          socket.close(normaliseCloseCode(code), reason ?? '');
        } catch {
          // Already closing or destroyed; nothing left to do.
        }
      },
    };

    const id = this.coordinator.addPeer(transport);
    this.bySocket.set(socket, id);

    socket.on('message', (data: unknown) => this.coordinator.handleMessage(id, data));
    socket.on('close', () => this.onSocketClose(socket, 'closed'));
    socket.on('error', () => this.onSocketClose(socket, 'socket error'));
  }

  private onSocketClose(socket: WebSocket, reason: string): void {
    const id = this.bySocket.get(socket);
    if (id === undefined) {
      return;
    }
    this.bySocket.delete(socket);
    this.coordinator.disconnectPeer(id, reason);
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