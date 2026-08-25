import {contextBridge, ipcRenderer} from 'electron';
import type {CommandName, EventName} from '@peers/api';

/**
 * The renderer-facing seam. Exactly the @peers/api shape: `request` for
 * commands, `on` for events — so the frontend's Tauri adapter swaps for
 * this one without touching a single component.
 */

const EVENT_NAMES: EventName[] = [
  'presence://peer-connected',
  'presence://peer-disconnected',
  'node://message',
  'net://hole-punch',
  'code://resolved',
  'friend://request',
  'blob://parked',
  'blob://fetched',
  'blob://failed',
  'server://list',
  'server://message',
  'server://error',
  'server://join-request',
  'plaza://message',
  'plaza://profile',
];

contextBridge.exposeInMainWorld('peers', {
  request: (cmd: CommandName, args: unknown): Promise<{ok: true; ret: unknown} | {ok: false; error: string}> =>
    ipcRenderer.invoke('peers:request', cmd, args),
  on: (event: EventName, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENT_NAMES.includes(event)) throw new Error(`unknown event: ${event}`);
    const channel = `peers:event:${event}`;
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});

// Tell the main process to start fanning engine events to this window.
ipcRenderer.send('peers:subscribe-events');
