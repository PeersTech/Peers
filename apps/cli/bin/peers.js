#!/usr/bin/env node
// Entry point for `peers --node`. Plain JS (this file runs as-is); it
// launches the esbuild bundle, so a VPS only requires Node 22+.

// Minimal colour, same rules as the engine: TTY on stdout, NO_COLOR wins.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);

const args = process.argv.slice(2);
if (!args.includes('--node')) {
  process.stdout.write(
    [
      paint('1', 'peers'),
      '',
      `  ${paint('36', '--node')}          run the headless backbone node (relay tier)`,
      `  ${paint('36', '--port <port>')}   override the listen port (default 4001 or PEERS_PORT)`,
      `  ${paint('36', '--show-seed')}     print PEERS_NODES line (hidden by default — directory handles it)`,
      '',
    ].join('\n') + '\n',
  );
  process.exit(args.length === 0 ? 0 : 1);
}
let showSeed = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') process.env.PEERS_PORT = args[i + 1] ?? '';
  if (args[i] === '--show-seed') showSeed = true;
}
try {
  const {runBackbone} = await import('../dist/main.js');
  const backbone = await runBackbone({showSeed});
  const shutdown = async () => {
    await backbone.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (err) {
  process.stderr.write(
    `${paint('31', 'peers node failed')}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
