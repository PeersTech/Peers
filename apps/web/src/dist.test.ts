import {expect, it} from 'vitest';
import {join} from 'node:path';
import {Identity} from '@peers/core';
import {startWebHost} from './server.js';

/** The built renderer served by the web host: assets resolve, SPA fallback
 * works, and the bundle carries our transport — not Tauri. */
it('serves the real renderer build', async () => {
  const web = await startWebHost({identity: Identity.random(), distDir: join(process.cwd(), 'frontend/dist')});
  try {
    const html = await (await fetch(`http://127.0.0.1:${web.port}/`)).text();
    expect(html).toContain('id="root"');
    const m = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
    expect(m).toBeTruthy();
    const js = await (await fetch(`http://127.0.0.1:${web.port}${m![1]}`)).text();
    expect(js.length).toBeGreaterThan(100_000);
    expect(js.includes('@tauri-apps')).toBe(false);
    // SPA fallback for client-side routes.
    const fallback = await (await fetch(`http://127.0.0.1:${web.port}/some/route`)).text();
    expect(fallback).toContain('id="root"');
  } finally {
    await web.close();
  }
}, 20_000);
