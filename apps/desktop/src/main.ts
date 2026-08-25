import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, powerMonitor} from 'electron';
import {PeersAccount} from '@peers/host';
import type {CommandName, EventName} from '@peers/api';

/**
 * The desktop shell: an Electron wrapper around the SAME engine every
 * other host uses. It contributes exactly three things the engine can't
 * know about — a window, a tray with close-to-tray semantics, and the
 * platform truth about battery state injected as the node's powerSource
 * (M12: a laptop on battery downgrades itself out of backbone duty).
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitRequested = false;

/** The account is created once, lazily, and shared by every IPC caller.
 * It starts locked when no keystore exists yet — the renderer's login
 * screen drives generate_phrase / init_from_phrase / unlock over IPC. */
let account: PeersAccount | null = null;

function getAccount(): PeersAccount {
  if (!account) {
    account = new PeersAccount({
      dataDir: join(app.getPath('userData'), 'account'),
      // M12 battery guard: the OS reports, the node decides. An hour of
      // idle counts as "asleep on a shelf" even if the battery is drawn.
      powerSource: {
        isPowerConstrained: () => powerMonitor.isOnBatteryPower() && powerMonitor.getSystemIdleTime() < 3600,
      },
    });
  }
  return account;
}

function createWindow(distDir: string): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(import.meta.dirname ?? '.', 'preload.js'),
      contextIsolation: true,
    },
  });
  // Close-to-tray: hiding keeps gossip, DHT blob seeding and DMs alive.
  mainWindow.on('close', (event) => {
    if (!quitRequested) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  if (distDir && existsSync(join(distDir, 'index.html'))) {
    void mainWindow.loadFile(join(distDir, 'index.html'));
  } else {
    void mainWindow.loadURL(
      `data:text/html,<title>Peers</title><body style="font-family:sans-serif;background:%230b0d10;color:%23eee;display:grid;place-items:center;height:100vh;margin:0"><div><h1>Peers</h1><p>Renderer not built yet — run <code>npm run build</code> in <code>frontend/</code>.</p></div></body>`,
    );
  }
}

function createTray(): void {
  // 1×1 transparent PNG — a real icon lands with branding assets.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('Peers');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Peers',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: 'Quit Peers',
        click: () => {
          quitRequested = true;
          app.quit();
        },
      },
    ]),
  );
}

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

function wireIpc(): void {
  ipcMain.handle('peers:request', async (_event, cmd: CommandName, args: unknown) => {
    try {
      return {ok: true, ret: await getAccount().request(cmd, args as never)};
    } catch (e) {
      return {ok: false, error: e instanceof Error ? e.message : String(e)};
    }
  });
  // Events flow from the account (queued while locked, live after unlock).
  ipcMain.on('peers:subscribe-events', (event) => {
    const acct = getAccount();
    for (const name of EVENT_NAMES) {
      acct.on(name, (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send(`peers:event:${name}`, payload);
      });
    }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(async () => {
    wireIpc();
    // Packaged builds ship the renderer via electron-builder extraResources;
    // dev runs read it straight out of the frontend workspace.
    const distDir = app.isPackaged
      ? join(process.resourcesPath, 'renderer')
      : join(app.getAppPath(), '../../frontend/dist');
    createWindow(existsSync(distDir) ? distDir : '');
    createTray();

    // OS shutdown/logout must close for real, not hide.
    powerMonitor.on('shutdown', () => {
      quitRequested = true;
      app.quit();
    });
  });

  app.on('before-quit', async () => {
    quitRequested = true;
    try {
      await getAccount().lock(); // flushes sealed state, stops the node
    } catch {
      /* account never constructed — nothing to stop */
    }
  });

  app.on('window-all-closed', () => {
    // Tray app: closing the window is not quitting.
  });
}
