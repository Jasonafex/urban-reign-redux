/**
 * Headless loader for the TypeScript simulation sources.
 *
 * The test suite (`npm test`) and the balance gate (`npm run report`) must exercise the *same*
 * code the browser bundles — not a reimplementation and not a hand-transpiled copy. esbuild
 * resolves the `.ts` graph into a temporary ESM file that Node imports directly, so both gates
 * run the real `src/` sources with zero browser globals present.
 */

import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository root, resolved from this file rather than the caller's cwd. */
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// `defs` is deliberately not re-exported here: `moveset` re-exports every name it defines, and a
// second `export *` of the same symbols would make the bundle's export table ambiguous.
const SIM_ENTRY = `export * from './src/config';
export * from './src/combat/archetypes';
export * from './src/combat/moveset';
export * from './src/sim/events';
export * from './src/sim/fighter';
export * from './src/sim/runner';
export * from './src/sim/modes';
export * from './src/sim/ai';
`;

const LOOP_ENTRY = `export * from './src/core/loop';
`;

// The input stack. Bundled on its own so the architecture gate can scan exactly what the headless
// suite drives: every device layer and the join manager, with the simulation reachable through
// `FrameInput` but no DOM in sight.
export const INPUT_ENTRY = `export * from './src/input/layout';
export * from './src/input/gamepad';
export * from './src/input/keyboard';
export * from './src/input/buffer';
export * from './src/input/join';
`;

// The touch module. Half of it is DOM (the overlay controller), which is exactly why it is scanned
// separately from the input stack: the pure half must stay importable in Node.
export const TOUCH_ENTRY = `export * from './src/ui/touch';
`;

// The QR encoder. Bundled on its own because `test/qr.test.mjs` scans the matrix generator for
// DOM and wall-clock reach, and because it must stay importable with no document present.
export const QR_ENTRY = `export * from './src/ui/qr';
`;

/**
 * The *pure* half of the networking layer: the wire protocol and the rollback engine.
 *
 * Deliberately excludes `client.ts` and `server.ts`. `client.ts` legitimately reads
 * `performance.now()` and touches `WebSocket`; `server.ts` needs Node's socket stack. Bundling
 * them separately from `protocol` + `rollback` is what lets the architecture gate assert that the
 * engine driving four fighters' simulation has no clock, no socket and no DOM in it.
 */
export const NET_ENTRY = `export * from './src/net/protocol';
export * from './src/net/rollback';
`;

/**
 * The relay server, on its own graph.
 *
 * `protocol` is bundled in again rather than shared with `NET_ENTRY`, because esbuild emits a
 * separate file per entry and each suite needs to load exactly one copy of the protocol module —
 * two copies would mean `instanceof`-free but identity-sensitive constants and duplicated state.
 */
export const SERVER_ENTRY = `export * from './src/net/protocol';
export * from './src/net/server';
`;

/** The browser client, on its own graph, with the same reasoning as `SERVER_ENTRY`. */
export const CLIENT_ENTRY = `export * from './src/net/protocol';
export * from './src/net/client';
`;

// -------------------------------------------------------------------------------------------
// Phase 4 — presentation layer (Three.js rigs/stage/VFX, framing camera, HUD, Web Audio)
// -------------------------------------------------------------------------------------------
//
// Bundled on its own graph, separate from `SIM_ENTRY`, and deliberately so. The architecture gate
// (`test/determinism.test.mjs`) scans `sources.sim` for `THREE`, `AudioContext`, `document` and
// friends to prove the *simulation* never reaches for the host; adding presentation modules to
// that bundle would fire that gate on files that are supposed to touch Three.js. Keeping the
// graphs apart is what lets each gate assert about exactly one layer.
//
// The renderer is still loadable in Node: `three`'s scene graph, geometry and material classes
// build fine without WebGL, because nothing touches a GL context until `WebGLRenderer` is
// constructed. That is what lets the Phase 4 suites build real rigs, real stage geometry and real
// particles and assert on them with no browser present.

export const RENDER_ENTRY = `export * from './src/render/character';
export * from './src/render/stage';
export * from './src/render/vfx';
`;

export const CAMERA_ENTRY = `export * from './src/camera/camera';
`;

export const HUD_ENTRY = `export * from './src/ui/hud';
`;

export const AUDIO_ENTRY = `export * from './src/audio/sound';
`;

let tempDir = null;
let repoTempDir = null;

function ensureTempDir() {
  if (tempDir === null) {
    tempDir = mkdtempSync(join(tmpdir(), 'urban-reign-'));
  }
  return tempDir;
}

/**
 * A scratch directory *inside the repo*, used for bundles that import a real runtime dependency.
 *
 * `ws` reaches for `require('events')`, which esbuild cannot inline into an ESM bundle, so it has
 * to stay external — and an external bare specifier only resolves if the importing file can walk
 * up to the repo's `node_modules`. A bundle written to the OS temp directory cannot, so the server
 * graph lands here instead. Cleaned up by `cleanup()` along with everything else.
 */
function ensureRepoTempDir() {
  if (repoTempDir === null) {
    const dir = join(ROOT, '.test-build');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    repoTempDir = dir;
  }
  return repoTempDir;
}

async function bundle(entry, name, options = {}) {
  const dir = options.external === undefined ? ensureTempDir() : ensureRepoTempDir();
  const outfile = join(dir, `${name}.mjs`);
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: `${name}.ts` },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    ...(options.external === undefined ? {} : { external: options.external }),
  });
  return outfile;
}

/**
 * Load the simulation module graph (`src/config`, `src/combat`, `src/sim`).
 * The returned namespace is the exact API the browser client uses.
 */
export async function loadSim() {
  const outfile = await bundle(SIM_ENTRY, 'sim');
  return import(pathToFileURL(outfile).href);
}

/** Load the fixed-step loop (`src/core/loop`) on its own, for architectural source scans. */
export async function loadLoop() {
  const outfile = await bundle(LOOP_ENTRY, 'loop');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the input stack (`src/input/*`) headlessly.
 *
 * The whole stack must import cleanly in Node: that is the property `test/input.test.mjs` gates,
 * because a device layer that reaches for `document` at module scope would take down the headless
 * run before a single assertion executed.
 */
export async function loadInput() {
  const outfile = await bundle(INPUT_ENTRY, 'input');
  return import(pathToFileURL(outfile).href);
}

/** Load the touch module (`src/ui/touch`) — both the pure state and the DOM overlay. */
export async function loadTouch() {
  const outfile = await bundle(TOUCH_ENTRY, 'touch');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the pure networking layer (`src/net/protocol` + `src/net/rollback`).
 *
 * These two must import and run in Node with no browser and no socket: `test/rollback.test.mjs`
 * drives the real engine across dozens of peers-in-one-process, and `test/lan.test.mjs` gates the
 * input validator against hostile packets. Both properties depend on this graph staying pure.
 */
export async function loadNet() {
  const outfile = await bundle(NET_ENTRY, 'net');
  return import(pathToFileURL(outfile).href);
}

/** Load the relay server (`src/net/server`) so the LAN suite can bind a real port. */
export async function loadServer() {
  const outfile = await bundle(SERVER_ENTRY, 'server', { external: ['ws'] });
  return import(pathToFileURL(outfile).href);
}

/** Load the browser client (`src/net/client`) so the LAN suite can drive it against the relay. */
export async function loadClient() {
  const outfile = await bundle(CLIENT_ENTRY, 'client');
  return import(pathToFileURL(outfile).href);
}

/** Load the QR encoder (`src/ui/qr`) headlessly. */
export async function loadQr() {
  const outfile = await bundle(QR_ENTRY, 'qr');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the Three.js presentation modules (`src/render/*`) headlessly.
 *
 * Scene graph, geometry and materials construct fine in Node — only `WebGLRenderer` needs a GL
 * context — so the Phase 4 suite can build the real rigs and the real stage and assert on the
 * resulting object graph.
 */
export async function loadRender() {
  const outfile = await bundle(RENDER_ENTRY, 'render');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the framing camera (`src/camera/camera`) headlessly.
 *
 * Bundled separately from `RENDER_ENTRY` so a suite that only cares about framing math does not
 * drag the whole Three.js rig graph in behind it, and so the camera's "reads sim state, writes
 * none" property can be scanned on its own.
 */
export async function loadCamera() {
  const outfile = await bundle(CAMERA_ENTRY, 'camera');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the arcade HUD (`src/ui/hud`) headlessly.
 *
 * The HUD's model half is pure and its view half touches `document`. Both must import with no
 * document present, which is what this suite gates: `test/hud.test.mjs` drives the view half
 * against a stub document rather than a real browser.
 */
export async function loadHud() {
  const outfile = await bundle(HUD_ENTRY, 'hud');
  return import(pathToFileURL(outfile).href);
}

/**
 * Load the audio layer (`src/audio/sound`) headlessly.
 *
 * `test/vfx-audio.test.mjs` gates that every cue is a no-op with no `AudioContext` in the process,
 * and that each cue builds real Web Audio nodes once one *is* injected. Both halves need the
 * module to import cleanly without a browser.
 */
export async function loadAudio() {
  const outfile = await bundle(AUDIO_ENTRY, 'sound');
  return import(pathToFileURL(outfile).href);
}

/**
 * Bundle an entry and return its transpiled source text, for architecture scans that prove a layer
 * never reaches for DOM or wall-clock globals. Comments are stripped by the bundler, so a match here
 * is real code and not a doc comment.
 */
export async function sourceFor(name, entry) {
  await bundle(entry, name);
  return readBundleSource(name);
}

/**
 * Bundled source text, used by the architecture gate to prove the simulation never reaches for
 * DOM or wall-clock globals. Comments are stripped by the bundler, so a match here is real code.
 */
export function readBundleSource(name) {
  return readFileSync(join(ensureTempDir(), `${name}.mjs`), 'utf8');
}

/** Bundle both graphs and return their source text. Call once, before running assertions. */
export async function buildSources() {
  await bundle(SIM_ENTRY, 'sim');
  await bundle(LOOP_ENTRY, 'loop');
  await bundle(NET_ENTRY, 'net');
  return {
    sim: readBundleSource('sim'),
    loop: readBundleSource('loop'),
    net: readBundleSource('net'),
  };
}

export function cleanup() {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}