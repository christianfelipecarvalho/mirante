# Releasing

How `mirante` gets to npm. This page is for the maintainer; users want the [Install section of the README](../README.md#install).

## Why there is a build step

The workspace packages (`@mirante/shared`, `installer`, `daemon`) are private and live only in this repository. If `packages/cli` were published as it stands, `npx mirante` would fail to resolve them. So `scripts/build-release.mjs` stages a self-contained package in `release/` (git-ignored):

- the CLI and the three workspace packages, bundled into `dist/bin.js` with esbuild;
- the built board, in `web/`;
- a generated `package.json` whose runtime dependencies are read from the workspace manifests, so they cannot drift from what the code was tested against. Only real packages remain external: `better-sqlite3` is a native addon, and the rest are CommonJS.

`packages/cli/package.json` stays the single source of the name, version and metadata.

## Cutting a release

1. **Check.** From a clean working tree on `main`:

   ```bash
   pnpm check
   ```

2. **Version.** Edit `version` in `packages/cli/package.json`. The staged manifest copies it.

3. **Stage and prove it.**

   ```bash
   pnpm release:build    # builds everything, stages release/
   pnpm release:smoke    # packs it, installs the tarball into an empty project with npm,
                         # then runs install -> serve the board -> uninstall
   ```

   The smoke test uses a throwaway `HOME`, so your real Claude Code settings are never touched. CI runs the same two commands (the `package` job), so a change that breaks publishing fails the pull request.

4. **Look at what ships.**

   ```bash
   cd release && npm pack --dry-run
   ```

   Expect `dist/bin.js`, `web/`, `package.json`, `LICENSE`, `README.md`. Nothing else.

5. **Publish.** You need to be logged in as the package owner (`npm login`, with 2FA):

   ```bash
   cd release
   npm publish --tag latest
   ```

   `--tag` is required: npm refuses to publish a pre-release version such as `0.1.0-alpha.0` without one. Use `latest` while no stable release exists. Without it, `latest` would keep pointing at the earlier `0.0.1` placeholder that reserved the name, and `npx mirante` would install an empty package. Once a stable `0.1.0` is out, publish alphas with `--tag next` so they stop becoming the default.

6. **Verify from outside the repository.**

   ```bash
   cd "$(mktemp -d)" && npx mirante@<version> --help
   npm view mirante dist-tags
   ```

7. **Tag it.**

   ```bash
   git tag v<version> && git push origin v<version>
   ```

A published version cannot be replaced. If something is wrong, publish the next one; `npm deprecate mirante@<version> "<reason>"` warns anyone still on it.
