// Standalone Peers engine: identity + swarm + WS bridge in one file.
// Run: node host.cjs   → the Tauri/browser app auto-connects to it.
import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolveBootstrapNodes} from '@peers/node';
import {startWebHost} from './server.js';

const dataDir = process.env.PEERS_HOME ?? join(homedir(), '.config', 'peers-app');
mkdirSync(dataDir, {recursive: true});

resolveBootstrapNodes().then((bootstrapAddrs) =>
startWebHost({
  accountDir: dataDir,
  bootstrapAddrs,
  port: Number(process.env.PEERS_PORT ?? 8123),
  host: '127.0.0.1',
})).then(
  (web) => {
    console.log(`peers engine running  →  ws://127.0.0.1:${web.port}/ws`);
    console.log(`identity + state dir  →  ${dataDir}`);
    console.log('keep this window open, then launch the Peers app.');
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
