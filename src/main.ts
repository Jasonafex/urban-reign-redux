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
 */

import * as THREE from 'three';
import { ARENA_HALF_EXTENT, FP_SCALE, RENDER, TICK_HZ } from './config';
import { startFixedLoop } from './core/loop';
import { GamepadSource } from './input/gamepad';
import { KeyboardSource } from './input/keyboard';
import { JoinManager } from './input/join';
import { TouchController, TouchInputState } from './ui/touch';
import type { FrameInput } from './sim/runner';
import { MatchRunner, NEUTRAL_INPUT } from './sim/runner';
import type { Fighter } from './sim/fighter';
import { isHit, type SimEvent } from './sim/events';

const SLOT_COLORS = [0xd8443c, 0x7dd83c, 0x3c8fd8, 0xd8b23c] as const;

interface FighterProxy {
  group: THREE.Group;
  marker: THREE.Mesh;
  healthBar: THREE.Mesh;
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

  const runner = new MatchRunner();
  const proxies = new Map<number, FighterProxy>();

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

  const loop = startFixedLoop({
    fixedUpdate: (dt) => {
      // The tick the world is about to run. Input is sampled for *this* tick, never for the last
      // one, so a 144Hz host and a 30Hz host feed the simulation the same presses in the same order.
      const tick = runner.tick + 1;
      const joinEvents = join.poll(tick);
      const inputs = join.frameInputs(tick);

      const events = runner.fixedUpdate(dt, inputs);

      // Feed the result back so the buffer knows whether each press was taken: an accepted press is
      // done, a rejected one stays queued for the next tick until the 8-tick window closes.
      join.settle(
        tick,
        runner.fighters.map((fighter, slot) =>
          pressAccepted(fighter, inputs[slot] ?? { ...NEUTRAL_INPUT }),
        ),
      );

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
      hud.textContent =
        `${TICK_HZ}Hz fixed  ·  tick ${runner.tick}  ·  ${fps}fps  ·  frames ${frameCount}\n` +
        `hash ${hash}  ·  events ${lastEvents.length} (${hits} hits)\n` +
        `${roster}${joinBanner === '' ? '' : `\n${joinBanner}`}`;
    },
  });

  loop.start();
  bootScreen?.setAttribute('data-state', 'running');

  // Debug handle for the browser console, replay tools and manual netcode checks.
  (globalThis as unknown as { __UR__?: unknown }).__UR__ = {
    runner,
    scene,
    renderer,
    loop,
    join,
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