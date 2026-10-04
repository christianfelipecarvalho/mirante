#!/usr/bin/env node
/**
 * Stages the npm package in `release/`.
 *
 * The workspace packages (`@mirante/shared`, `installer`, `daemon`) are private
 * and exist only inside this repository, so `mirante` cannot be published with
 * them as dependencies: `npx mirante` would fail to resolve them. Instead the
 * CLI and all three are bundled into one file, the built board is copied
 * beside it, and the third-party runtime dependencies are declared in a
 * generated manifest. The versions are read from the workspace manifests, so
 * they cannot drift from what the code was tested against.
 *
 * Run `pnpm build` first (it builds the board), or use `pnpm release:build`.
 * Publishing is a separate, deliberate step — see docs/RELEASING.md.
 */
import { build } from 'esbuild';
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release');

const readJson = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

const webDist = join(root, 'apps', 'web', 'dist');
if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error('The board is not built. Run `pnpm build` first, or use `pnpm release:build`.');
}

const cli = await readJson('packages/cli/package.json');
const workspaces = [
  'apps/daemon/package.json',
  'packages/installer/package.json',
  'packages/shared/package.json',
];

// Every third-party runtime dependency of the code that ends up in the bundle.
const dependencies = {};
for (const manifestPath of workspaces) {
  const manifest = await readJson(manifestPath);
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith('workspace:')) continue;
    if (dependencies[name] && dependencies[name] !== range) {
      throw new Error(`${name} is declared as ${dependencies[name]} and as ${range}.`);
    }
    dependencies[name] = range;
  }
}

// Empty the directory rather than removing it: a shell sitting in release/ (to
// run `npm publish`) would otherwise be left in a deleted directory.
await mkdir(out, { recursive: true });
for (const entry of await readdir(out)) {
  await rm(join(out, entry), { recursive: true, force: true });
}
await mkdir(join(out, 'dist'), { recursive: true });

await build({
  entryPoints: [join(root, 'packages/cli/src/bin.ts')],
  outfile: join(out, 'dist', 'bin.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve the workspace packages from source rather than from their tsc
  // output, so the bundle never depends on a stale `dist/`.
  alias: {
    '@mirante/daemon': join(root, 'apps/daemon/src/index.ts'),
    '@mirante/installer': join(root, 'packages/installer/src/index.ts'),
    '@mirante/shared': join(root, 'packages/shared/src/index.ts'),
  },
  // Real packages stay external: better-sqlite3 is a native addon and the rest
  // are CommonJS, so they are installed by npm, not copied into the bundle.
  external: Object.keys(dependencies),
  logLevel: 'warning',
});
await chmod(join(out, 'dist', 'bin.js'), 0o755);

await cp(webDist, join(out, 'web'), { recursive: true });
await cp(join(root, 'LICENSE'), join(out, 'LICENSE'));
await cp(join(root, 'README.md'), join(out, 'README.md'));

const manifest = {
  name: cli.name,
  version: cli.version,
  description: cli.description,
  keywords: cli.keywords,
  license: cli.license,
  homepage: cli.homepage,
  repository: cli.repository,
  bugs: cli.bugs,
  type: 'module',
  // npm rewrites `./dist/bin.js` to `dist/bin.js` on publish and warns about it.
  bin: Object.fromEntries(
    Object.entries(cli.bin).map(([name, path]) => [name, path.replace(/^\.\//, '')]),
  ),
  files: cli.files,
  engines: cli.engines,
  dependencies: Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)),
  ),
};
await writeFile(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Staged ${manifest.name}@${manifest.version} in release/`);
