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
 */

import * as THREE from 'three';
import { ARENA_HALF_EXTENT, FP_SCALE, RENDER, TICK_HZ } from './config';
import { startFixedLoop } from './core/loop';
import { GamepadSource } from './input/gamepad';
import { KeyboardSource } from './input/keyboard';
import { JoinManager } from './input/join';
import { TouchController, TouchInputState } from './ui/touch';
import { encodeQr, mountQr } from './ui/qr';
import type { FrameInput } from './sim/runner';
import { MatchRunner, NEUTRAL_INPUT } from './sim/runner';
import type { Fighter } from './sim/fighter';
import { isHit, type SimEvent } from './sim/events';
import { LanClient, relayUrl } from './net/client';
import { RollbackSession } from './net/rollback';
import {
  DEFAULT_RELAY_PORT,
  MAX_PLAYERS,
  canonicalizeInput,
  inputFromWire,
} from './net/protocol';

const SLOT_COLORS = [0xd8443c, 0x7dd83c, 0x3c8fd8, 0xd8b23c] as const;

interface FighterProxy {
  group: THREE.Group;
  marker: THREE.Mesh;
  healthBar: THREE.Mesh;
}

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
 * Query flags that put the client into LAN mode: `?lan` hosts, `?join=<host>` joins a relay.
 *
 * A plain `http://192.168.1.42:5173/?lan` is what the QR code encodes, so the join path has to work
 * from a cold URL with no stored state — which is exactly what a phone scanning it has.
 */
function readLanFlags(): { enabled: boolean; relayHost: string | null } {
  if (typeof location === 'undefined') {
    return { enabled: false, relayHost: null };
  }
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  if (join !== null && join !== '') {
    return { enabled: true, relayHost: join };
  }
  return { enabled: params.has('lan'), relayHost: null };
}

function createLanMatch(onSessionReady: (session: RollbackSession) => void): LanMatch | null {
  const flags = readLanFlags();
  // No `WebSocket` global means no LAN mode. Returning null (rather than throwing) leaves the
  // client in its normal offline behaviour, which is the right outcome on an old browser.
  if (!flags.enabled || typeof WebSocket !== 'function') {
    return null;
  }

  const host = flags.relayHost ?? (typeof location === 'undefined' ? '127.0.0.1' : location.hostname);
  const client = new LanClient({
    url: relayUrl(host === '' ? '127.0.0.1' : host, DEFAULT_RELAY_PORT),
    name: 'house',
    room: 'house',
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
          return 'lan: no WebSocket in this browser';
        case 'rejected':
          return 'lan: rejected by relay (room full, or version mismatch)';
        case 'closed':
          return 'lan: relay connection closed';
        default:
          break;
      }
      if (session === null) {
        return `lan: ${client.state}…`;
      }
      const peers = client.roster.filter((entry) => entry.connected).length;
      const stats = session.stats;
      const rewind = stats.maxRewindTicks > 0 ? ` (max −${stats.maxRewindTicks})` : '';
      return (
        `lan: slot ${session.localSlot + 1}/${peers} · ${latency.rttMs.toFixed(0)}ms` +
        ` ±${latency.jitterMs.toFixed(0)} · rollbacks ${stats.rollbacks}${rewind}`
      );
    },
    joinLinks(): readonly string[] {
      return links;
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

  const camera = new THREE.PerspectiveCamera(
    RENDER.fov,
    (container.clientWidth || 1280) / (container.clientHeight || 720),
    RENDER.near,
    RENDER.far,
  );

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2018, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(6, 14, 8);
  scene.add(key);

  // Placeholder urban stage: wet asphalt, four alley walls, a couple of props to frame the arena.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF_EXTENT * 2, ARENA_HALF_EXTENT * 2),
    new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.85 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.7 });
  const wallHeight = 3.2;
  const wallThickness = 0.4;
  const span = ARENA_HALF_EXTENT * 2;
  for (const [x, z, sx, sz] of [
    [0, -ARENA_HALF_EXTENT, span + wallThickness, wallThickness],
    [0, ARENA_HALF_EXTENT, span + wallThickness, wallThickness],
    [-ARENA_HALF_EXTENT, 0, wallThickness, span],
    [ARENA_HALF_EXTENT, 0, wallThickness, span],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sx, wallHeight, sz), wallMaterial);
    wall.position.set(x, wallHeight / 2, z);
    scene.add(wall);
  }
  for (const [x, z, height] of [
    [-5.5, -5.5, 1.1],
    [6.2, 4.4, 0.9],
  ] as const) {
    const prop = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, height, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x39414c, roughness: 0.6 }),
    );
    prop.position.set(x, height / 2, z);
    scene.add(prop);
  }

  // Mutable because a LAN session brings its own world: when the relay assigns a slot, the
  // rollback session's `MatchRunner` becomes the one being rendered. Offline it never changes.
  let runner: MatchRunner = new MatchRunner();
  const proxies = new Map<number, FighterProxy>();

  /**
   * Build a scene proxy per fighter.
   *
   * Re-runnable, because the LAN session's world is a different `MatchRunner` instance from the
   * offline one. Rebuilt rather than pooled: four capsule meshes cost nothing, and a pool would
   * have to be correct about *which* fighter it is standing in for — which is precisely the kind
   * of state that rots when a world is swapped underneath it.
   */
  function buildProxies(): void {
    for (const proxy of proxies.values()) {
      scene.remove(proxy.group);
    }
    proxies.clear();

    for (const fighter of runner.fighters) {
    const color = SLOT_COLORS[fighter.slot % SLOT_COLORS.length] ?? 0xffffff;
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.38, 1.05, 4, 12),
      new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
    );
    body.position.y = 0.95;
    group.add(body);

    // Facing marker: a small wedge in front of the fighter, so left/right reads on screen.
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.42, 4),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.rotation.z = -Math.PI / 2;
    marker.position.set(0.6, 0.95, 0);
    group.add(marker);

    // Health bar floats above the head and reads straight off sim state each frame.
    const healthBar = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.12),
      new THREE.MeshBasicMaterial({ color: 0x8ef0a0 }),
    );
    healthBar.position.y = 2.1;
    group.add(healthBar);

    scene.add(group);
    proxies.set(fighter.slot, { group, marker, healthBar });
    }
  }

  buildProxies();

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;left:12px;top:12px;font:12px/1.4 ui-monospace,monospace;color:#cfd4dc;' +
    'background:rgba(12,14,18,.72);border:1px solid #2a2e35;border-radius:6px;padding:8px 10px;' +
    'white-space:pre;pointer-events:none';
  document.body.appendChild(hud);

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
  // House LAN: one socket, one rollback session, one join panel
  // -------------------------------------------------------------------------------------------

  /**
   * The LAN half of the client.
   *
   * Owns the socket, the rollback session and the join panel, and exposes exactly three things the
   * frame loop needs: the world to render, the local input to submit, and a per-frame pump. Socket
   * callbacks never run inside `fixedUpdate`, so a slow read cannot stall a tick for every fighter.
   */
  const lan = createLanMatch((session) => {
    // The rollback session owns its own `MatchRunner`. Handing the renderer that world is the only
    // change of ownership in the whole Phase 3 path — the tick still receives nothing but
    // `FrameInput[]`, and the renderer still only reads fighter records back out.
    runner = session.runner;
    buildProxies();
  });

  if (lan !== null) {
    mountLanPanel(container, lan);
  }

  const loop = startFixedLoop({
    fixedUpdate: (dt) => {
      // The tick the world is about to run. Input is sampled for *this* tick, never for the last
      // one, so a 144Hz host and a 30Hz host feed the simulation the same presses in the same order.
      const tick = runner.tick + 1;
      const joinEvents = join.poll(tick);
      const inputs = join.frameInputs(tick);

      let events: SimEvent[];
      if (lan !== null && lan.live) {
        // Online: only *this* machine's input is fed in. The other three fighters are driven by
        // their owners' inputs as they arrive, with the rollback session guessing in between.
        const localSlot = lan.session?.localSlot ?? 0;
        events = lan.step(inputs[localSlot] ?? NEUTRAL_INPUT);
        void dt; // the rollback session advances whole 1/60 ticks; it never takes a variable dt
      } else {
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

      // Presentation reads sim state; it never writes to it.
      for (const fighter of runner.fighters) {
        const proxy = proxies.get(fighter.slot);
        if (proxy === undefined) {
          continue;
        }
        proxy.group.position.set(fighter.x / FP_SCALE, 0, fighter.z / FP_SCALE);
        proxy.group.rotation.y = fighter.facing === 1 ? Math.PI / 2 : -Math.PI / 2;
        proxy.group.rotation.z = fighter.state === 'launched' ? 0.6 : 0;
        proxy.marker.position.x = 0.6 * fighter.facing;
        const ratio = Math.max(0, fighter.health / fighter.maxHealth);
        proxy.healthBar.scale.x = ratio;
        proxy.healthBar.position.x = -(1 - ratio) * 0.55;
        proxy.healthBar.visible = !fighter.eliminated;
        proxy.group.visible = !fighter.eliminated;
      }

      const centre = new THREE.Vector3();
      const living = runner.fighters.filter((fighter) => !fighter.eliminated);
      for (const fighter of living) {
        centre.add(new THREE.Vector3(fighter.x / FP_SCALE, 0, fighter.z / FP_SCALE));
      }
      if (living.length > 0) {
        centre.multiplyScalar(1 / living.length);
      }
      camera.position.set(centre.x, RENDER.cameraHeight, centre.z + RENDER.cameraDistance);
      camera.lookAt(centre.x, RENDER.cameraLookHeight, centre.z);

      renderer.render(scene, camera);

      fpsFrames += 1;
      const now = performance.now();
      if (fpsWindowStart === 0) {
        fpsWindowStart = now;
      } else if (now - fpsWindowStart >= 500) {
        fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
        fpsFrames = 0;
        fpsWindowStart = now;
      }

      const hits = lastEvents.filter(isHit).length;
      const hash = runner.stateHash();
      const roster = join.slots
        .map((slot) => `${slot.slot + 1}:${slot.kind === 'empty' ? '—' : slot.label}`)
        .join('  ');
      // Offline the HUD shows the local join roster; online the local devices are all feeding one
      // slot, so the relay's roster is the honest thing to show.
      const lanLine = lan === null ? '' : `${lan.status()}\n`;
      hud.textContent =
        `${TICK_HZ}Hz fixed  ·  tick ${runner.tick}  ·  ${fps}fps  ·  frames ${frameCount}\n` +
        `hash ${hash}  ·  events ${lastEvents.length} (${hits} hits)\n` +
        `${lanLine}${roster}${joinBanner === '' ? '' : `\n${joinBanner}`}`;
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
    lan,
    keyboard,
    gamepads,
    touch: touchState,
    touchController,
  };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}