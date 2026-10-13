/**
 * Headless loader for the TypeScript simulation sources.
 *
 * The test suite (`npm test`) and the balance gate (`npm run report`) must exercise the *same*
 * code the browser bundles — not a reimplementation and not a hand-transpiled copy. esbuild
 * resolves the `.ts` graph into a temporary ESM file that Node imports directly, so both gates
 * run the real `src/` sources with zero browser globals present.
 */

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
`;

const LOOP_ENTRY = `export * from './src/core/loop';
`;

let tempDir = null;

function ensureTempDir() {
  if (tempDir === null) {
    tempDir = mkdtempSync(join(tmpdir(), 'urban-reign-'));
  }
  return tempDir;
}

async function bundle(entry, name) {
  const outfile = join(ensureTempDir(), `${name}.mjs`);
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: `${name}.ts` },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
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
  return { sim: readBundleSource('sim'), loop: readBundleSource('loop') };
}

export function cleanup() {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
}