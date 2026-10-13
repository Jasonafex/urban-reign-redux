/**
 * `npm run lan-server` — start the house relay and print the join details.
 *
 * A deliberately boring entry point. All behaviour lives in `src/net/server.ts` so it can be
 * tested headlessly; this file only parses argv, starts the relay and keeps the process alive.
 *
 * The join URLs it prints point at the **web client**, not the relay. A phone needs to load the
 * game page first; the page then opens a socket back to this relay. Getting that backwards is the
 * classic house-LAN bug where the QR code leads to a page that cannot find anyone to play with,
 * so the relay carries an explicit `--web-port` for exactly this.
 */

import { DEFAULT_WEB_PORT, LanRelayServer } from './server';
import { DEFAULT_RELAY_PORT } from './protocol';

interface CliOptions {
  readonly port: number;
  readonly host: string;
  readonly webPort: number;
  readonly maxPlayers: number;
  readonly stage: string;
}

function usage(): string {
  return [
    'Usage: npm run lan-server -- [options]',
    '',
    'Options:',
    `  --port <n>          relay port (default ${DEFAULT_RELAY_PORT})`,
    `  --web-port <n>      port the game page is served on (default ${DEFAULT_WEB_PORT})`,
    '  --host <addr>       bind address (default 0.0.0.0, i.e. reachable from the LAN)',
    '  --max-players <n>   1-4 simultaneous fighters (default 4)',
    '  --stage <id>        arena id advertised to peers (default alley)',
    '  -h, --help          print this',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliOptions {
  let options: CliOptions = {
    port: DEFAULT_RELAY_PORT,
    host: '0.0.0.0',
    webPort: DEFAULT_WEB_PORT,
    maxPlayers: 4,
    stage: 'alley',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(usage());
        process.exit(0);
        break;
      case '--port':
        options = { ...options, port: Number(next) };
        i += 1;
        break;
      case '--web-port':
        options = { ...options, webPort: Number(next) };
        i += 1;
        break;
      case '--host':
        options = { ...options, host: String(next ?? '0.0.0.0') };
        i += 1;
        break;
      case '--max-players':
        options = { ...options, maxPlayers: Number(next) };
        i += 1;
        break;
      case '--stage':
        options = { ...options, stage: String(next ?? 'alley') };
        i += 1;
        break;
      default:
        console.warn(`unknown option: ${arg ?? ''}`);
        console.log(usage());
        process.exit(1);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new RangeError(`--port must be 0-65535, got ${options.port}`);
  }
  if (!Number.isInteger(options.webPort) || options.webPort < 1 || options.webPort > 65535) {
    throw new RangeError(`--web-port must be 1-65535, got ${options.webPort}`);
  }
  if (!Number.isInteger(options.maxPlayers) || options.maxPlayers < 1 || options.maxPlayers > 4) {
    throw new RangeError(`--max-players must be 1-4, got ${options.maxPlayers}`);
  }
  return options;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const relay = new LanRelayServer({
    port: options.port,
    host: options.host,
    webPort: options.webPort,
    maxPlayers: options.maxPlayers,
    stage: options.stage,
  });

  await relay.start();
  console.log('');
  console.log('  Open the game page in a browser on this machine, then share the link');
  console.log('  (or scan the QR the page shows) with anyone else on the house Wi-Fi.');
  console.log('');
  if (relay.joinUrls.length === 0) {
    console.log('  No private LAN address found. If you are on Wi-Fi, check the network adapter.');
    console.log('  Peers on the same machine can still join via localhost.');
  }

  // Shut down cleanly so Ctrl-C does not leave the port bound and the next `npm run lan-server`
  // die with EADDRINUSE.
  const shutdown = (): void => {
    void relay.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run when explicitly launched. `tools/lan-server.mjs` bundles this module and runs it with
// `UR_LAN_CLI=1`; without the flag the module is inert, so a test can import `main` to exercise
// argv parsing without accidentally binding a port.
if (process.env['UR_LAN_CLI'] === '1') {
  void main();
}