#!/usr/bin/env node
import { EventLog, loadConfig, loadOrCreateToken, start } from '@mirante/daemon';
import { defaultSettingsPath, install, pathsFor, uninstall } from '@mirante/installer';
import { doctor } from './doctor.js';
import { bullet, heading, line, ui } from './ui.js';
import { findWebRoot } from './webroot.js';

const HELP = `
${ui.bold('mirante')} — local lookout for coding agents

  ${ui.cyan('mirante')}              start the daemon and open the board
  ${ui.cyan('mirante install')}      wire hooks and the status line into Claude Code
  ${ui.cyan('mirante uninstall')}    undo exactly what install wrote
  ${ui.cyan('mirante doctor')}       check that data is actually arriving
  ${ui.cyan('mirante purge')}        delete everything Mirante has stored

Options
  --port <n>          port to listen on (default 7788)
  --settings <path>   settings file to modify (default ~/.claude/settings.json)
  --transport <type>  http (default) or command
  --yes               skip confirmation on purge
`;

const parseArgs = (argv: string[]) => {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(name, next);
        i += 1;
      } else flags.set(name, true);
    } else positional.push(arg);
  }
  return { command: positional[0] ?? 'start', flags };
};

const configOverrides = (flags: Map<string, string | boolean>) => {
  const port = flags.get('port');
  return typeof port === 'string' ? { port: Number(port) } : {};
};

const runInstall = (flags: Map<string, string | boolean>): number => {
  const config = loadConfig(configOverrides(flags));
  const token = loadOrCreateToken(config);
  const settingsFlag = flags.get('settings');
  const transportFlag = flags.get('transport');

  const outcome = install({
    paths: pathsFor(
      config.home,
      typeof settingsFlag === 'string' ? settingsFlag : defaultSettingsPath(),
    ),
    daemonUrl: `http://${config.host}:${config.port}`,
    token,
    transport: transportFlag === 'command' ? 'command' : 'http',
    // Comfortably longer than the daemon's approval window, so a click can win.
    permissionTimeoutSeconds: Math.ceil(config.approvalWindowMs / 1000) + 10,
  });

  heading('Installed');
  line(`  ${ui.dim('settings')}  ${outcome.manifest.settingsPath}`);
  if (outcome.backupPath) line(`  ${ui.dim('backup  ')}  ${outcome.backupPath}`);
  line();
  heading('What changed');
  for (const change of outcome.changes) bullet(change);

  if (outcome.settingsWorldReadable) {
    line();
    line(
      ui.yellow(
        '  ! Your settings.json is readable by other users on this machine, and it now\n' +
          '    holds the local token. Run: chmod 600 ' +
          outcome.manifest.settingsPath,
      ),
    );
  }

  line();
  line(`  Next: ${ui.cyan('mirante')} to start the board, then use Claude Code as usual.`);
  line(`  Undo at any time with ${ui.cyan('mirante uninstall')}.`);
  return 0;
};

const runUninstall = (flags: Map<string, string | boolean>): number => {
  const config = loadConfig(configOverrides(flags));
  const outcome = uninstall(pathsFor(config.home));

  if (!outcome.hadManifest) {
    line(`\n  Nothing to undo — Mirante is not installed.`);
    return 0;
  }

  heading('Uninstalled');
  for (const change of outcome.changes) bullet(change);
  if (outcome.backupPath) {
    line();
    line(`  ${ui.dim('backup taken before undoing:')} ${outcome.backupPath}`);
  }
  line();
  line(
    `  Your stored data is still in ${config.home}. Remove it with ${ui.cyan('mirante purge')}.`,
  );
  return 0;
};

const runPurge = (flags: Map<string, string | boolean>): number => {
  const config = loadConfig(configOverrides(flags));
  if (flags.get('yes') !== true) {
    line(`\n  This deletes every event Mirante has stored in ${config.databasePath}.`);
    line(`  It cannot be undone. Re-run with ${ui.cyan('--yes')} to confirm.`);
    return 1;
  }
  const log = new EventLog(config.databasePath);
  try {
    log.purge();
  } finally {
    log.close();
  }
  line(`\n  ${ui.green('Purged.')} Stored prompts and tool inputs are gone.`);
  return 0;
};

const runStart = async (flags: Map<string, string | boolean>): Promise<number> => {
  const webRoot = findWebRoot();
  const startOptions = {
    config: configOverrides(flags),
    ...(webRoot ? { webRoot } : {}),
  };
  const { daemon, url, token } = await start(startOptions);

  heading('Mirante is watching');
  line(`  ${ui.cyan(`${url}/?token=${token}`)}`);
  line();
  if (!webRoot) {
    line(
      ui.yellow(
        '  ! The board was not built. Run `pnpm build` first, or use `pnpm --filter @mirante/web dev`.',
      ),
    );
    line();
  }
  line(`  ${ui.dim('Open Claude Code in your terminal or VS Code — the board fills itself.')}`);
  line(`  ${ui.dim('Ctrl+C to stop. Nothing leaves this machine.')}`);

  const shutdown = () => {
    void daemon.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise<number>(() => {});
};

const main = async (): Promise<void> => {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.get('help') === true || command === 'help') {
    line(HELP);
    return;
  }

  switch (command) {
    case 'install':
      process.exitCode = runInstall(flags);
      return;
    case 'uninstall':
      process.exitCode = runUninstall(flags);
      return;
    case 'doctor':
      process.exitCode = await doctor(configOverrides(flags));
      return;
    case 'purge':
      process.exitCode = runPurge(flags);
      return;
    case 'start':
      process.exitCode = await runStart(flags);
      return;
    default:
      line(`\n  Unknown command: ${command}`);
      line(HELP);
      process.exitCode = 1;
  }
};

void main().catch((error: unknown) => {
  line(ui.red(`\n  ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
