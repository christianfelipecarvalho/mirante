import { request } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';

/**
 * Taking over a port from a previous run.
 *
 * The rule that shapes all of this: never kill a process just because it holds
 * the port. A daemon Mirante started is ours to stop; anything else on 7788 is
 * someone else's work, and the right response is to say so and stop.
 */
export type PortHolder =
  { state: 'free' } | { state: 'mirante'; pid: number | undefined } | { state: 'foreign' };

const HEALTH_TIMEOUT_MS = 700;

export type HealthResponse = { ok?: boolean; service?: string; pid?: number };

const getHealth = (host: string, port: number): Promise<HealthResponse | undefined> =>
  new Promise((resolve) => {
    const req = request(
      { host, port, path: '/health', method: 'GET', timeout: HEALTH_TIMEOUT_MS },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as HealthResponse);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });

export const isPortBusy = (host: string, port: number, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });

/** Who holds the port, and whether Mirante may stop them. */
export const inspectPort = async (host: string, port: number): Promise<PortHolder> => {
  if (!(await isPortBusy(host, port))) return { state: 'free' };
  const health = await getHealth(host, port);
  // The service name is the only safe signal. A bare `{ ok: true }` could be
  // anything, and "it answered /health" is not a licence to kill it.
  if (health?.service === 'mirante') return { state: 'mirante', pid: health.pid };
  return { state: 'foreign' };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForPortFree = async (
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortBusy(host, port, 200))) return true;
    await sleep(120);
  }
  return !(await isPortBusy(host, port, 200));
};

/**
 * Asks a previous daemon to stop, then waits for it to let go of the port.
 *
 * SIGTERM only: the daemon closes its database and releases pending permission
 * requests on the way out, and SIGKILL would skip both — leaving a hook waiting
 * for an answer that will never come.
 */
export const stopDaemon = async (
  pid: number | undefined,
  host: string,
  port: number,
): Promise<boolean> => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone, or not ours to signal. Either way, see if the port frees.
  }
  return waitForPortFree(host, port);
};

export const writePidFile = (path: string, pid = process.pid): void => {
  try {
    writeFileSync(path, String(pid), { mode: 0o600 });
  } catch {
    // Without it, a later run cannot take over cleanly — but it can still start.
  }
};

export const readPidFile = (path: string): number | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

export const removePidFile = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale pid file is checked against a live /health before anyone acts on it.
  }
};
