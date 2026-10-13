import { defineConfig } from 'vite';

/**
 * Urban Reign web client build.
 *
 * The simulation under `src/sim`, `src/combat` and `src/core` is DOM-free and bundled
 * exactly like the presentation layer; nothing in the client build may introduce a
 * wall-clock or DOM dependency into the sim (see AGENTS.md §3.1).
 *
 * `npm run build` runs `tsc` first, so the four verification gates
 * (typecheck -> test -> build -> report) all guard the same sources.
 */
export default defineConfig({
  root: '.',
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: true, // expose the LAN address so phones/tablets on the house network can join
    port: 5173,
    strictPort: false,
  },
});