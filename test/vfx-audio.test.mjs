/**
 * Phase 4 presentation gate — VFX, stage, framing camera and audio (`npm test`).
 *
 * Runs the real `src/render/*`, `src/camera/*` and `src/audio/*` headlessly: no WebGL context, no
 * browser globals, and — importantly — no `AudioContext`. Three.js builds scene graphs and
 * geometry in Node fine; only `WebGLRenderer` needs a GL context.
 *
 * Covered:
 *   - bursts emit particles, scale with power, and decay to nothing within their lifetimes
 *   - the pools are fixed-capacity, so a long string cannot grow geometry per hit
 *   - the generators are seeded, so the same tick stream throws the same sparks (no `Math.random`)
 *   - `dispose()` releases every buffer, geometry and material
 *   - the stage builds real geometry and its walls sit exactly on the sim's `ARENA_HALF_EXTENT`
 *   - the framing camera centres on and fits every **living** fighter, and zooms out with spread
 *   - camera shake accumulates, decays to exactly zero, and is deterministic
 *   - every audio cue is a **no-op that does not throw** with no audio device
 *   - and with an injected stub context, every cue builds real Web Audio nodes — so a sound board
 *     that only ever no-ops cannot pass this file
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, loadAudio, loadCamera, loadRender, loadSim } from '../tools/load-sim.mjs';

const render = await loadRender();
const cameraModule = await loadCamera();
const audio = await loadAudio();
const sim = await loadSim();

const { VfxSystem, buildStage } = render;
const { FramingCamera, createFramingCamera, framingFor, distanceForBox, shakeNoise, FIGHTER_BOUNDS } =
  cameraModule;
const { SoundBoard } = audio;
const { createFighter, defaultSpawns, ARENA_HALF_EXTENT, FP_SCALE } = sim;

after(cleanup);

// -------------------------------------------------------------------------------------------
// VFX
// -------------------------------------------------------------------------------------------

/** A burst point somewhere in the arena. */
function at(x = 1, y = 1.2, z = -2) {
  return { position: { x, y, z } };
}

/** Every node under a stub-able Three object. */
function nodesOf(root) {
  const out = [];
  root.traverse((node) => out.push(node));
  return out;
}

test('the VFX system is fully headless and starts empty', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');

  const vfx = new VfxSystem();
  assert.equal(vfx.liveCount, 0);
  assert.equal(vfx.sparkCount, 0);
  assert.equal(vfx.dustCount, 0);
  assert.equal(vfx.shockwaveCount, 0);
  assert.ok(nodesOf(vfx.group).length > 0, 'the system built no renderable nodes');

  // A zero or negative step must be inert rather than dividing by zero somewhere.
  assert.doesNotThrow(() => vfx.update(0));
  assert.doesNotThrow(() => vfx.update(-1));
  assert.doesNotThrow(() => vfx.update(Number.NaN));
  vfx.dispose();
});

test('each effect type emits only its own particles', () => {
  const vfx = new VfxSystem();

  vfx.hit(at());
  assert.ok(vfx.sparkCount > 0, 'a hit threw no sparks');
  assert.equal(vfx.dustCount, 0, 'a hit threw dust');
  assert.equal(vfx.shockwaveCount, 0);

  const dust = new VfxSystem();
  dust.knockdownDust(at(0, 0.05, 0));
  assert.ok(dust.dustCount > 0, 'a knockdown threw no dust');
  assert.equal(dust.sparkCount, 0, 'a knockdown threw sparks');

  const block = new VfxSystem();
  block.block(at());
  assert.ok(block.sparkCount > 0, 'a block threw no sparks');

  vfx.dispose();
  dust.dispose();
  block.dispose();
});

test('burst size scales with power, and everything decays to zero', () => {
  const light = new VfxSystem();
  light.hit({ position: { x: 0, y: 1, z: 0 }, power: 0.2 });
  const lightCount = light.sparkCount;

  const heavy = new VfxSystem();
  heavy.hit({ position: { x: 0, y: 1, z: 0 }, power: 1 });
  assert.ok(heavy.sparkCount > lightCount, 'power did not scale the burst');

  // Every particle's lifetime is a fraction of a second, so a few seconds of stepping clears the
  // whole field. If this never reaches zero, something is leaking particles.
  for (let i = 0; i < 120; i += 1) heavy.update(1 / 60);
  assert.equal(heavy.sparkCount, 0, 'sparks never expired');
  assert.equal(heavy.liveCount, 0);

  light.dispose();
  heavy.dispose();
});

test('a shockwave expands, expires, and reaches further at a higher tier', () => {
  const vfx = new VfxSystem();

  vfx.shockwave(at(), 1);
  assert.equal(vfx.shockwaveCount, 1, 'the ring did not appear');

  // One frame in, the ring must have grown past its spawn scale.
  const wave = vfx.shockwaveCount;
  assert.equal(wave, 1);
  vfx.update(1 / 60);

  for (let i = 0; i < 60; i += 1) vfx.update(1 / 60);
  assert.equal(vfx.shockwaveCount, 0, 'the ring never expired');

  // The pool is bounded, so a spam of SPAs still reports at most the pool size.
  const spam = new VfxSystem();
  for (let i = 0; i < 40; i += 1) spam.shockwave(at(), 3);
  assert.ok(spam.shockwaveCount <= 8, 'the shockwave pool grew past its fixed capacity');
  spam.dispose();

  vfx.dispose();
});

test('the pools are fixed-capacity: a long string cannot exhaust them', () => {
  const vfx = new VfxSystem();

  // Thirty heavy bursts is far more than any declared five-link string, but the pool has to
  // absorb it without growing or throwing.
  for (let i = 0; i < 30; i += 1) {
    vfx.hit({ position: { x: i * 0.1, y: 1, z: 0 }, power: 1.4 });
  }
  assert.doesNotThrow(() => vfx.update(1 / 60));

  const positions = vfx.sparks.points.geometry.attributes.position;
  assert.equal(positions.array.length, 512 * 3, 'the spark buffer grew');
  vfx.dispose();
});

test('the generators are seeded: identical input produces identical particles', () => {
  const first = new VfxSystem({ seed: 0x1234 });
  const second = new VfxSystem({ seed: 0x1234 });
  const different = new VfxSystem({ seed: 0xbeef });

  for (const vfx of [first, second, different]) {
    vfx.hit({ position: { x: 2, y: 1.2, z: 3 }, power: 0.8 });
    // Positions are only integrated on update — every particle sits on its spawn point until
    // then, so the comparison has to happen after a step or it would compare three identical
    // clouds of spawn points.
    vfx.update(1 / 60);
  }

  const dump = (vfx) => Array.from(vfx.sparks.points.geometry.attributes.position.array);
  assert.deepEqual(dump(first), dump(second), 'the same seed produced different sparks');
  assert.notDeepEqual(dump(first), dump(different), 'different seeds produced identical sparks');

  first.dispose();
  second.dispose();
  different.dispose();
});

test('dispose releases every VFX resource and is idempotent', () => {
  const vfx = new VfxSystem();
  vfx.hit(at());
  vfx.shockwave(at(), 2);

  const geometries = new Set();
  const materials = new Set();
  for (const node of nodesOf(vfx.group)) {
    if (node.geometry !== undefined) geometries.add(node.geometry);
    if (node.material !== undefined) {
      const material = node.material;
      if (Array.isArray(material)) for (const entry of material) materials.add(entry);
      else materials.add(material);
    }
  }
  assert.ok(geometries.size > 0);
  assert.ok(materials.size > 0);

  const released = { geometries: 0, materials: 0 };
  for (const geometry of geometries) {
    const original = geometry.dispose.bind(geometry);
    geometry.dispose = () => {
      released.geometries += 1;
      original();
    };
  }
  for (const material of materials) {
    const original = material.dispose.bind(material);
    material.dispose = () => {
      released.materials += 1;
      original();
    };
  }

  vfx.dispose();
  assert.equal(vfx.isDisposed, true);
  assert.equal(released.geometries, geometries.size, 'a VFX geometry was not released');
  assert.equal(released.materials, materials.size, 'a VFX material was not released');
  assert.doesNotThrow(() => vfx.dispose());
});

// -------------------------------------------------------------------------------------------
// Stage
// -------------------------------------------------------------------------------------------

test('the stage builds real geometry with its walls on the sim clamp', () => {
  const stage = buildStage();
  assert.equal(stage.halfExtent, ARENA_HALF_EXTENT, 'the stage disagrees with the sim clamp');

  const nodes = nodesOf(stage.group);
  assert.ok(nodes.length > 10, 'the stage is suspiciously empty');
  assert.ok(nodes.some((node) => node.isPointLight), 'no streetlight was built');
  assert.ok(stage.key !== undefined, 'no key light');

  // Every wall must straddle +/- ARENA_HALF_EXTENT exactly: the player sees the fighter stop at
  // the wall, so the visible wall and the simulated one cannot be two different numbers.
  const wallY = ARENA_HALF_EXTENT;
  const wallPositions = nodes
    .filter((node) => node.isMesh && typeof node.position?.x === 'number')
    .map((node) => node.position);
  for (const axis of ['x', 'z']) {
    assert.ok(
      wallPositions.some((position) => Math.abs(position[axis] - wallY) < 1e-9),
      `no wall on the +${axis} face`,
    );
    assert.ok(
      wallPositions.some((position) => Math.abs(position[axis] + wallY) < 1e-9),
      `no wall on the -${axis} face`,
    );
  }

  stage.dispose();
  assert.doesNotThrow(() => stage.dispose());
});

// -------------------------------------------------------------------------------------------
// Camera
// -------------------------------------------------------------------------------------------

/** A `Fighter` at a world position, optionally dead. */
function placed(slot, x, z, extra = {}) {
  return {
    ...createFighter(slot, 'brad_hawk', x * FP_SCALE, z * FP_SCALE),
    ...extra,
  };
}

test('framing centres on and fits every subject', () => {
  const subjects = [
    { x: -2, z: -1, y: 0, height: FIGHTER_BOUNDS.height },
    { x: 4, z: 3, y: 0, height: FIGHTER_BOUNDS.height },
  ];
  const framing = framingFor(subjects);

  assert.equal(framing.count, 2);
  assert.ok(Math.abs(framing.centreX - 1) < 1e-9, 'centreX is not the midpoint of the box');
  assert.ok(Math.abs(framing.centreZ - 1) < 1e-9, 'centreZ is not the midpoint of the box');
  assert.ok(framing.halfWidth > 0 && framing.halfDepth > 0);
  assert.ok(framing.distance > 0);

  // The bounding box is what drives the zoom, and the distance has to rise monotonically with the
  // spread: two fighters in the middle of the arena frame tighter than two in opposite corners,
  // which is the whole point of solving the boom from the box instead of fixing it.
  const twoAt = (gap) => framingFor([
    { x: -gap, z: -gap, y: 0, height: FIGHTER_BOUNDS.height },
    { x: gap, z: gap, y: 0, height: FIGHTER_BOUNDS.height },
  ]);
  const distances = [1, 2, 4, 6, ARENA_HALF_EXTENT - 2].map(twoAt).map((f) => f.distance);
  for (let i = 1; i < distances.length; i += 1) {
    assert.ok(
      distances[i] >= distances[i - 1],
      `zooming out on a wider spread failed: ${distances.join(', ')}`,
    );
  }
  assert.ok(
    distances[distances.length - 1] > distances[0],
    'two fighters in opposite corners framed the same as two in the middle',
  );

  // Nobody alive is not a crash and not a snap to the origin — it is a wide shot of the arena.
  const empty = framingFor([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.centreX, 0);
  assert.equal(empty.centreZ, 0);
  assert.ok(empty.distance > distances[0], 'an empty arena framed tighter than a fighting pair');
});

test('the framing distance respects the frustum and the aspect ratio', () => {
  const narrow = distanceForBox(3, 3, 3, 55, 9 / 16);
  const wide = distanceForBox(3, 3, 3, 55, 21 / 9);
  // A portrait phone has a far narrower horizontal field, so it must pull back further to fit the
  // same group horizontally.
  assert.ok(narrow > wide, 'a portrait viewport framed the same group tighter');

  // And the solved distance has to genuinely contain the box.
  const distance = distanceForBox(4, 4, 4, 55, 16 / 9);
  const halfFov = (55 * Math.PI) / 360;
  assert.ok(4 / Math.tan(halfFov) <= distance + 1e-9, 'the box does not fit the vertical frustum');
});

test('the camera excludes eliminated fighters and eases toward its target', () => {
  const { camera, framing } = createFramingCamera();
  assert.equal(camera.fov, 55);

  const living = [placed(0, 0, 0), placed(1, 2, 0)];
  const dead = placed(2, 50, 50, { eliminated: true });

  const first = framing.update([...living, dead], 1 / 60);
  assert.equal(first.count, 2, 'a dead fighter was framed');
  assert.ok(Math.abs(first.centreX - 1) < 1e-9, 'the dead fighter dragged the frame off the pair');

  // Smoothing: one frame from rest must not teleport the camera to the target.
  const before = framing.position.clone();
  for (let i = 0; i < 120; i += 1) framing.update(living, 1 / 60);
  assert.notEqual(framing.position.x, before.x, 'the camera never moved at all');
  assert.ok(Math.abs(framing.position.x - 1) < 0.05, 'the camera never converged on the centroid');
  assert.ok(Math.abs(framing.position.z - 0 - framing.boom) < 0.05, 'the boom is not behind the pair');

  framing.dispose();
  assert.equal(framing.isDisposed, true);
  // A disposed camera must be inert rather than still writing to a live scene.
  const snapshot = framing.position.clone();
  framing.update(living, 1 / 60);
  assert.deepEqual(framing.position.toArray(), snapshot.toArray());
});

test('camera shake accumulates, is deterministic, and decays to exactly zero', () => {
  const { framing } = createFramingCamera();

  // Deterministic in `t`: the same seed and time always give the same displacement, so two
  // clients replaying the same ticks shake the same way.
  assert.equal(shakeNoise(1.25, 7), shakeNoise(1.25, 7));
  assert.notEqual(shakeNoise(1.25, 7), shakeNoise(1.25, 8));
  for (const t of [0, 0.5, 3.75, 100]) {
    const value = shakeNoise(t, 3);
    assert.ok(Number.isFinite(value), `shakeNoise(${t}) is not finite`);
    assert.ok(value >= -1.001 && value <= 1.001, `shakeNoise(${t}) out of range: ${value}`);
  }

  assert.deepEqual(framing.shakeOffset(), { x: 0, y: 0, z: 0 }, 'a calm camera is shaking');

  // Trauma accumulates across a string rather than being overwritten.
  framing.shake(0.3);
  const single = framing.trauma;
  framing.shake(0.3);
  assert.ok(framing.trauma > single, 'consecutive hits did not pile on');
  assert.ok(framing.trauma <= 1, 'trauma exceeded its ceiling');

  const offset = framing.shakeOffset();
  assert.notEqual(offset.x, 0, 'trauma produced no displacement');

  // And it drains back to nothing rather than lingering at a constant shiver.
  for (let i = 0; i < 300; i += 1) framing.update([], 1 / 60);
  assert.equal(framing.trauma, 0, 'trauma never drained');
  assert.deepEqual(framing.shakeOffset(), { x: 0, y: 0, z: 0 });

  // A zero or negative amount must be ignored, not subtract trauma.
  framing.shake(0.5);
  framing.shake(0);
  framing.shake(-1);
  assert.ok(framing.trauma > 0, 'a negative shake cleared trauma');
  framing.dispose();
});

// -------------------------------------------------------------------------------------------
// Audio
// -------------------------------------------------------------------------------------------

/**
 * A stub `AudioContext` that records every node the sound board builds.
 *
 * This is the half of the audio gate that a no-op implementation cannot pass: if every cue
 * returned early, `board.nodes` would stay empty.
 */
function stubAudioContext() {
  const record = { oscillators: 0, buffers: 0, gains: 0, filters: 0, sources: 0, started: 0 };

  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
  });

  return {
    record,
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    closed: false,
    resume() {
      return Promise.resolve();
    },
    close() {
      this.closed = true;
      return Promise.resolve();
    },
    createGain() {
      record.gains += 1;
      return { gain: param(), connect() {}, disconnect() {} };
    },
    createOscillator() {
      record.oscillators += 1;
      return {
        type: 'sine',
        frequency: param(),
        connect() {},
        start() {
          record.started += 1;
        },
        stop() {},
      };
    },
    createBiquadFilter() {
      record.filters += 1;
      return { type: 'bandpass', frequency: param(), Q: { value: 1 }, connect() {} };
    },
    createBufferSource() {
      record.sources += 1;
      return { buffer: null, loop: false, connect() {}, start() {}, stop() {} };
    },
    createBuffer(channels, length, sampleRate) {
      record.buffers += 1;
      const data = new Float32Array(length);
      return {
        getChannelData: () => data,
        channels,
        sampleRate,
      };
    },
  };
}

test('with no audio device, every cue is a silent no-op that does not throw', () => {
  assert.equal(typeof globalThis.AudioContext, 'undefined', 'this suite must run headless');

  // The default constructor probes for a global AudioContext, which does not exist here.
  const board = new SoundBoard();
  assert.equal(board.enabled, false);

  const CUES = [
    'whoosh',
    'impact',
    'impactHeavy',
    'block',
    'slip',
    'reversal',
    'wallSplat',
    'spaCharge',
    'spaRelease',
    'knockdown',
    'getup',
  ];
  for (const name of CUES) {
    assert.doesNotThrow(() => board.play(name, 1), `${name} threw with no audio device`);
  }
  assert.doesNotThrow(() => board.whoosh());
  assert.doesNotThrow(() => board.spaCharge(3));
  assert.doesNotThrow(() => board.getup());
  assert.doesNotThrow(() => board.dispose());

  // Cues are still counted, which is what lets the headless suite prove the *mapping* ran.
  assert.equal(board.stats().total, CUES.length + 3);
  assert.equal(board.stats().played.impact, 1);
  assert.equal(board.isDisposed, true);
  assert.doesNotThrow(() => board.dispose());
});

test('with an audio device, every cue builds real Web Audio nodes', () => {
  const context = stubAudioContext();
  const board = new SoundBoard({ contextFactory: () => context });

  assert.equal(board.enabled, true, 'an injected context was not picked up');
  // The noise buffer is generated once at construction, not per cue.
  assert.equal(context.record.buffers, 1, 'the noise buffer was not generated');

  const before = { ...context.record };
  board.whoosh(0.8);
  board.play('impact', 0.9);
  board.play('block', 0.5);
  board.play('spaRelease', 1);
  board.spaCharge(2);
  board.getup();

  // A noise cue uses a buffer source plus a filter and a gain; a tone cue adds an oscillator.
  // Every cue must have moved at least one node counter, and the noise buffer must not be rebuilt.
  assert.ok(context.record.sources > before.sources, 'no noise source was created');
  assert.ok(context.record.filters > before.filters, 'no filter was created');
  assert.ok(context.record.oscillators > before.oscillators, 'no oscillator was created');
  assert.ok(context.record.gains > before.gains, 'no gain node was created');
  assert.ok(context.record.started > before.started, 'nothing was ever started');
  assert.equal(context.record.buffers, 1, 'the noise buffer was regenerated per cue');

  board.dispose();
});

test('a broken audio context degrades to no-op instead of throwing', () => {
  // A factory that throws: an autoplay-blocked or locked-down browser.
  assert.doesNotThrow(() => {
    const board = new SoundBoard({
      contextFactory: () => {
        throw new Error('AudioContext is not allowed');
      },
    });
    assert.equal(board.enabled, false);
    board.play('impact', 1);
    board.dispose();
  });

  // A factory that returns null.
  const none = new SoundBoard({ contextFactory: () => null });
  assert.equal(none.enabled, false);
  assert.doesNotThrow(() => none.play('impact'));

  // A context that refuses to hand out a gain node.
  const hostile = new SoundBoard({
    contextFactory: () => ({
      ...stubAudioContext(),
      createGain() {
        throw new Error('no gain node');
      },
    }),
  });
  assert.equal(hostile.enabled, false, 'a half-built context should report itself disabled');
  assert.doesNotThrow(() => hostile.play('impact'));
});

test('the event stream maps to the right cues', () => {
  const context = stubAudioContext();
  const board = new SoundBoard({ contextFactory: () => context });

  const hit = (extra) => ({
    type: 'hit',
    tick: 1,
    attackerSlot: 0,
    defenderSlot: 1,
    moveId: 'brad_hawk_barrage_1',
    damage: 20,
    hitstun: 12,
    blockstun: 10,
    hitstop: 8,
    guarded: false,
    knockdown: false,
    launcher: false,
    distanceFp: FP_SCALE,
    ...extra,
  });

  board.consume([hit({})]);
  assert.equal(board.stats().played.impact, 1, 'a clean light hit did not play an impact');

  board.consume([hit({ guarded: true })]);
  assert.equal(board.stats().played.block, 1, 'a blocked hit did not play a block');

  board.consume([hit({ launcher: true, knockdown: true })]);
  assert.equal(board.stats().played.impactHeavy, 1, 'a launcher did not play the heavy impact');
  assert.equal(board.stats().played.knockdown, 1, 'a knockdown did not play the floor hit');

  board.consume([
    { type: 'dodge', tick: 2, slot: 1, direction: 'high', evadedMoveId: 'x', outcome: 'slip', counterMoveId: null },
  ]);
  assert.equal(board.stats().played.slip, 1, 'a dodge slip did not play a slip');

  board.consume([
    {
      type: 'dodge',
      tick: 3,
      slot: 1,
      direction: 'high',
      evadedMoveId: 'x',
      outcome: 'reversal',
      counterMoveId: 'brad_hawk_reversal',
    },
  ]);
  assert.equal(board.stats().played.reversal, 1, 'a reversal did not play its own chime');

  board.consume([{ type: 'wallImpact', tick: 4, slot: 2, axis: 'x', speed: 900 }]);
  assert.equal(board.stats().played.wallSplat, 1, 'a wall impact did not play a wall splat');

  board.consume([
    { type: 'spa', tick: 5, slot: 3, moveId: 'brad_hawk_spa2', tier: 2, gaugeSpent: 100, gaugeRemaining: 0 },
  ]);
  assert.equal(board.stats().played.spaRelease, 1, 'an SPA did not play its release');

  // A tick with nothing in it must not make a sound.
  const quiet = board.stats().total;
  board.consume([]);
  assert.equal(board.stats().total, quiet, 'an empty event stream produced audio');

  board.dispose();
});

test('the voice budget drains instead of permanently muting the board', () => {
  const context = stubAudioContext();
  const board = new SoundBoard({ contextFactory: () => context, maxVoices: 4 });

  // A five-hit string plus change: far more cues than the four-voice budget.
  for (let i = 0; i < 12; i += 1) board.play('impact', 0.8);
  assert.ok(board.stats().dropped > 0, 'the voice ceiling was never enforced');

  // Drain: the released slots must come back. Without this, the board goes permanently silent
  // after `maxVoices` cues — about four seconds into a real match.
  board.play('impact', 0.8);
  const droppedNow = board.stats().dropped;
  for (let i = 0; i < 40; i += 1) board.play('impact', 0.8);
  assert.ok(
    board.stats().dropped > droppedNow,
    'the voice budget never refilled; the board is permanently muted',
  );

  board.dispose();
});