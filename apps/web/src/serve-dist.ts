// Serves the real renderer for visual inspection (CJS-safe, no top-level await).
import {Identity} from '@peers/core';
import {startWebHost} from './server.js';

startWebHost({
  identity: Identity.random(),
  port: 8123,
  host: '0.0.0.0',
  distDir: '/root/Peers/frontend/dist',
}).then(
  (web) => console.log('serving on', web.port),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
