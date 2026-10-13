/**
 * `npm run lan-server` launcher.
 *
 * `src/net/server-cli.ts` is TypeScript, and the relay is a Node process that has to actually run
 * — so this bundles it with the same esbuild the test suite already uses (see `tools/load-sim.mjs`)
 * and hands the result to a child `node`.
 *
 * Bundling rather than `tsc`-emitting keeps one build story for the whole repo: `npm run build` is
 * `tsc && vite build` with `noEmit`, so there is no server artefact to consume. `ws` stays external
 * because it is a real runtime dependency loaded from `node_modules`, and re-bundling it would be
 * both slower and wrong (it carries native-adjacent optional deps).
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = join(ROOT, 'src', 'net', 'server-cli.ts');

/**
 * The bundle is written inside the repo, not to the OS temp directory.
 *
 * `ws` has to stay external (it reaches for `require('events')`, which cannot be inlined into an
 * ESM bundle), and an external bare specifier only resolves if the importing file can walk up to
 * the repo's `node_modules`. A bundle in `%TEMP%` cannot, so `node` dies with ERR_MODULE_NOT_FOUND
 * on `ws`. `node_modules/.cache` is already git-ignored and is the conventional home for exactly
 * this kind of build artefact.
 */
const outDir = join(ROOT, 'node_modules', '.cache', 'urban-reign-relay');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const outfile = join(outDir, 'server-cli.mjs');

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  external: ['ws'],
  logLevel: 'silent',
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
  env: { ...process.env, UR_LAN_CLI: '1' },
});

const cleanup = () => {
  rmSync(outDir, { recursive: true, force: true });
};

// Forward termination so Ctrl-C at the shell stops the relay, then tidy the bundle up.
child.on('exit', (code, signal) => {
  cleanup();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
