#!/usr/bin/env node
/**
 * Runs the daemon and the board's dev server together.
 *
 * The daemon serves the API on 7788; Vite serves the board on 7789 with hot
 * reload and proxies /api and /ws across. That split is why MIRANTE_DEV_ORIGIN
 * exists: the browser's Origin is Vite's, not the daemon's, and the daemon
 * refuses an origin it does not know.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAEMON_PORT = process.env.MIRANTE_PORT ?? '7788';
const WEB_PORT = process.env.MIRANTE_WEB_PORT ?? '7789';
const devOrigin = `http://127.0.0.1:${WEB_PORT}`;

const children = [];

const run = (name, command, args, env = {}) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    shutdown();
  });
  children.push(child);
  return child;
};

const shutdown = () => {
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
};
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', shutdown);

run('daemon', 'node', ['packages/cli/dist/bin.js', '--port', DAEMON_PORT], {
  MIRANTE_DEV_ORIGIN: devOrigin,
});
run('web', 'pnpm', ['--filter', '@mirante/web', 'dev', '--port', WEB_PORT]);

// The daemon writes its token on first start; wait for it so the URL printed
// here can be opened directly instead of being assembled by hand.
const tokenPath = join(process.env.MIRANTE_HOME ?? join(homedir(), '.mirante'), 'token');

const announce = (attempt = 0) => {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf8').trim();
    process.stdout.write(`\n  Board with hot reload:\n  ${devOrigin}/?token=${token}\n\n`);
    return;
  }
  if (attempt > 40) {
    process.stdout.write(
      `\n  Board with hot reload: ${devOrigin}\n  (token not found at ${tokenPath})\n\n`,
    );
    return;
  }
  setTimeout(() => announce(attempt + 1), 250);
};

announce();
