#!/usr/bin/env node
/**
 * Proves that the staged package works the way a user gets it.
 *
 * Packs `release/`, installs the tarball into an empty project with plain npm
 * (so nothing from this workspace can leak in), then runs the real lifecycle:
 * install, serve the board, uninstall. Everything happens under a throwaway
 * HOME, so Claude Code settings on this machine are never touched.
 *
 * Needs the npm registry once, to install the package's dependencies — the same
 * thing `npx mirante` does. Mirante itself makes no network call.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const keep = process.argv.includes('--keep');

const work = mkdtempSync(join(tmpdir(), 'mirante-smoke-'));
const step = (message) => console.log(`\n▸ ${message}`);
const fail = (message) => {
  throw new Error(message);
};

const sh = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0 && !options.allowFailure) {
    fail(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
};

const freePort = () =>
  new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const httpGet = (url) =>
  new Promise((done, reject) => {
    get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => done({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });

try {
  step('Pack release/');
  const packed = JSON.parse(
    sh('npm', ['pack', release, '--pack-destination', work, '--json']).stdout,
  )[0];
  const files = packed.files.map((file) => file.path);
  for (const required of [
    'dist/bin.js',
    'web/index.html',
    'package.json',
    'LICENSE',
    'README.md',
  ]) {
    if (!files.includes(required)) fail(`The tarball is missing ${required}.`);
  }
  const stray = files.filter((file) => file.endsWith('.map') || file.startsWith('src/'));
  if (stray.length > 0) fail(`The tarball carries files it should not: ${stray.join(', ')}`);
  const manifest = JSON.parse(readFileSync(join(release, 'package.json'), 'utf8'));
  if (JSON.stringify(manifest).includes('workspace:')) fail('package.json still names workspace:.');
  console.log(`  ${packed.name}@${packed.version} — ${files.length} files, ${packed.size} bytes`);

  step('Install the tarball into an empty project');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{"name":"smoke","private":true}\n');
  sh('npm', ['install', '--no-audit', '--no-fund', join(work, packed.filename)], { cwd: app });
  const bin = join(app, 'node_modules', '.bin', 'mirante');

  const home = join(work, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const port = await freePort();
  const settings = join(home, '.claude', 'settings.json');
  const original = { theme: 'dark', statusLine: { type: 'command', command: 'echo mine' } };
  writeFileSync(settings, `${JSON.stringify(original, null, 2)}\n`);
  const env = { ...process.env, HOME: home, MIRANTE_HOME: join(home, '.mirante') };
  const mirante = (...args) =>
    sh(bin, [...args, '--port', String(port)], { env, allowFailure: true });

  step('mirante --help');
  const help = sh(bin, ['--help'], { env });
  if (!help.stdout.includes('local lookout')) fail(`Unexpected help output:\n${help.stdout}`);

  step('mirante install');
  const installed = mirante('install', '--settings', settings);
  if (installed.status !== 0) fail(`install failed:\n${installed.stdout}\n${installed.stderr}`);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  if (!after.hooks) fail('install wrote no hooks.');
  if (after.theme !== 'dark') fail('install lost a setting it did not own.');

  step('mirante (serve the board)');
  const daemon = spawn(bin, ['--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = await new Promise((done, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`The daemon never came up:\n${text}`)), 20_000);
    daemon.stdout.setEncoding('utf8');
    daemon.stderr.setEncoding('utf8');
    const collect = (chunk) => {
      text += chunk;
      if (text.includes('?token=')) {
        clearTimeout(timer);
        done(text);
      }
    };
    daemon.stdout.on('data', collect);
    daemon.stderr.on('data', collect);
    daemon.on('exit', (code) => reject(new Error(`The daemon exited early (${code}):\n${text}`)));
  });
  // eslint-disable-next-line no-control-regex -- strips terminal colour codes
  const url = output.replace(/\u001b\[[0-9;]*m/g, '').match(/http:\/\/\S+\?token=\S+/)?.[0];
  if (!url) fail(`No board URL in the daemon output:\n${output}`);
  if (output.includes('The board was not built')) fail('The package carries no board.');
  const page = await httpGet(url);
  if (page.status !== 200 || !page.body.includes('<div id="root"')) {
    fail(`The board did not load (HTTP ${page.status}):\n${page.body.slice(0, 300)}`);
  }
  console.log(`  board served at ${url.split('?')[0]}`);

  step('mirante doctor');
  const doctor = mirante('doctor');
  if (doctor.status !== 0 && doctor.status !== 1) fail(`doctor crashed:\n${doctor.stderr}`);
  if (!doctor.stdout.trim()) fail('doctor printed nothing.');

  step('mirante stop');
  daemon.removeAllListeners('exit');
  const stopped = mirante('stop');
  if (stopped.status !== 0) fail(`stop failed:\n${stopped.stdout}\n${stopped.stderr}`);

  step('mirante uninstall');
  const removed = mirante('uninstall');
  if (removed.status !== 0) fail(`uninstall failed:\n${removed.stdout}\n${removed.stderr}`);
  deepStrictEqual(JSON.parse(readFileSync(settings, 'utf8')), original);
  console.log('  settings restored exactly');

  console.log('\n✓ The package installs and runs from a clean project.');
} finally {
  if (keep) console.log(`\n  kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
