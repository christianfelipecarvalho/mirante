import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from '../config.js';
import { createDaemon, type Daemon } from './index.js';

/**
 * These tests do a real HTTP upgrade instead of using `inject`.
 *
 * `inject` cannot upgrade a connection, so it happily passed a daemon whose
 * every websocket attempt returned 500: the route had been declared before the
 * websocket plugin finished loading, and the handler was being handed an HTTP
 * reply rather than a socket. Nothing short of a real client catches that.
 */
const TOKEN = 'd'.repeat(64);

let daemon: Daemon | undefined;
let port = 0;

/**
 * The daemon builds its allowed-origin list from the port it was configured
 * with, so the test has to configure the port it will actually listen on —
 * binding to 0 would leave the config saying 0 and every browser Origin wrong.
 */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const found = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(found));
    });
  });

const startDaemon = async (): Promise<string> => {
  port = await freePort();
  const config = loadConfig({ databasePath: ':memory:', port });
  daemon = createDaemon({ config, token: TOKEN, watch: false });
  return daemon.app.listen({ host: '127.0.0.1', port });
};

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const connect = (query: string, origin?: string) =>
  new Promise<{ opened: boolean; firstMessage?: unknown; closeCode?: number }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, {
      ...(origin ? { headers: { Origin: origin } } : {}),
    });
    let opened = false;
    const done = (result: { opened: boolean; firstMessage?: unknown; closeCode?: number }) => {
      socket.removeAllListeners();
      socket.close();
      resolve(result);
    };
    socket.on('open', () => {
      opened = true;
    });
    socket.on('message', (data) => done({ opened, firstMessage: JSON.parse(String(data)) }));
    socket.on('error', () => resolve({ opened }));
    socket.on('close', (code) => resolve({ opened, closeCode: code }));
    setTimeout(() => done({ opened }), 3000);
  });

describe('the websocket', () => {
  it('upgrades and sends a snapshot', async () => {
    await startDaemon();
    const result = await connect(`?token=${TOKEN}`, `http://127.0.0.1:${port}`);
    expect(result.opened).toBe(true);
    expect(result.firstMessage).toMatchObject({ type: 'snapshot' });
  });

  it('pushes events as they are ingested', async () => {
    await startDaemon();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const received: unknown[] = [];
    await new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string };
        received.push(message);
        if (message.type === 'snapshot') {
          void daemon?.app.inject({
            method: 'POST',
            url: '/ingest/hook',
            headers: { authorization: `Bearer ${TOKEN}` },
            payload: { hook_event_name: 'SessionStart', session_id: 'live-1', cwd: '/home/user/p' },
          });
        }
        if (message.type === 'events') resolve();
      });
      socket.on('error', () => resolve());
    });
    socket.close();
    expect(received.map((m) => (m as { type: string }).type)).toEqual(['snapshot', 'events']);
  });

  it('refuses a connection with no token', async () => {
    await startDaemon();
    const result = await connect('');
    expect(result.firstMessage).toBeUndefined();
  });

  it('refuses a foreign Origin', async () => {
    await startDaemon();
    const result = await connect(`?token=${TOKEN}`, 'https://evil.example');
    expect(result.firstMessage).toBeUndefined();
  });
});
