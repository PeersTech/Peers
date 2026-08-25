#!/usr/bin/env node
// Entry point for `peers --node`. Plain JS (this file runs as-is); it
// launches the esbuild bundle, so a VPS only requires Node 22+.
const args = process.argv.slice(2);
if (!args.includes('--node')) {
  process.stdout.write(`usage: peers --node [--port <port>]\n\n  --node   run the headless backbone node (relay tier)\n`);
  process.exit(args.length === 0 ? 0 : 1);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') process.env.PEERS_PORT = args[i + 1] ?? '';
}
try {
  const {runBackbone} = await import('../dist/main.js');
  const backbone = await runBackbone();
  const shutdown = async () => {
    await backbone.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (err) {
  process.stderr.write(`peers node failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
