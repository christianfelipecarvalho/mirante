import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPort, isPortBusy, readPidFile, removePidFile, writePidFile } from './takeover.js';

const servers: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];

const listen = (body: unknown): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('deciding whether a port may be taken', () => {
  it('reports a free port as free', async () => {
    // Port 1 on loopback is not something a user process can bind.
    expect(await isPortBusy('127.0.0.1', 1, 200)).toBe(false);
    expect(await inspectPort('127.0.0.1', 1)).toEqual({ state: 'free' });
  });

  it('recognises a previous Mirante by its own health response', async () => {
    const port = await listen({ ok: true, service: 'mirante', pid: 4242 });
    expect(await inspectPort('127.0.0.1', port)).toEqual({ state: 'mirante', pid: 4242 });
  });

  it('refuses to claim a port held by something else', async () => {
    // The rule that shapes all of this: never kill a process just because it
    // holds the port.
    const port = await listen({ ok: true });
    expect(await inspectPort('127.0.0.1', port)).toEqual({ state: 'foreign' });
  });

  it('treats a server that answers nothing useful as foreign', async () => {
    const port = await listen('not json at all');
    expect(await inspectPort('127.0.0.1', port)).toEqual({ state: 'foreign' });
  });
});

describe('the pid file', () => {
  const workspace = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirante-pid-'));
    dirs.push(dir);
    return join(dir, 'daemon.pid');
  };

  it('round-trips a pid', () => {
    const path = workspace();
    writePidFile(path, 1234);
    expect(readPidFile(path)).toBe(1234);
    removePidFile(path);
    expect(readPidFile(path)).toBeUndefined();
  });

  it('ignores a corrupt file rather than acting on nonsense', () => {
    const path = workspace();
    writeFileSync(path, 'not a pid');
    expect(readPidFile(path)).toBeUndefined();
  });

  it('is absent, not an error, when nothing ran', () => {
    expect(readPidFile(workspace())).toBeUndefined();
  });
});
