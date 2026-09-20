import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { EventLog, loadConfig, readToken, type MiranteConfig } from '@mirante/daemon';
import { locateSessions } from '@mirante/daemon';
import { readManifest, readSettings } from '@mirante/installer';
import { check, heading, line, ui } from './ui.js';

const claudeVersion = (): string | undefined => {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
};

const daemonRunning = async (config: MiranteConfig): Promise<boolean> =>
  new Promise((resolve) => {
    import('node:net')
      .then(({ createConnection }) => {
        const socket = createConnection({ host: config.host, port: config.port });
        socket.setTimeout(500);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
      })
      .catch(() => resolve(false));
  });

/**
 * Answers the only question that matters after installing: is data actually
 * arriving, and from which of the four sources?
 *
 * A green "hooks are configured" is worth nothing if no hook has ever fired, so
 * every check reads real state rather than repeating what install intended.
 */
export const doctor = async (overrides: Partial<MiranteConfig> = {}): Promise<number> => {
  const config = loadConfig(overrides);
  let failures = 0;
  const fail = () => {
    failures += 1;
  };

  heading('Claude Code');
  const version = claudeVersion();
  if (version) check('pass', 'Claude Code found', version);
  else {
    check('fail', 'Claude Code not found on PATH', 'is `claude` installed?');
    fail();
  }

  const sessions = locateSessions(config.claudeProjectsDir, 24 * 60 * 60 * 1000);
  const allSessions = locateSessions(config.claudeProjectsDir);
  if (allSessions.length > 0) {
    check(
      'pass',
      'Transcripts readable',
      `${sessions.length} in the last day, ${allSessions.length} total`,
    );
  } else {
    check('warn', 'No transcripts found', config.claudeProjectsDir);
  }
  const withSubagents = sessions.filter((s) => s.subagents.length > 0).length;
  check('info', 'Sessions with subagents in the last day', String(withSubagents));

  heading('Installation');
  const manifest = readManifest(config.home);
  if (!manifest) {
    check('fail', 'Not installed', 'run `mirante install`');
    fail();
  } else {
    check('pass', 'Manifest found', manifest.settingsPath);

    const settings = existsSync(manifest.settingsPath) ? readSettings(manifest.settingsPath) : {};
    const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: { url?: string }[] }[]>;
    const wired = Object.entries(hooks).filter(([, groups]) =>
      (groups ?? []).some((group) =>
        (group.hooks ?? []).some((hook) => hook.url?.startsWith(manifest.daemonUrl)),
      ),
    );
    if (wired.length >= manifest.hookEvents.length) {
      check('pass', 'Hooks wired', `${wired.length} events`);
    } else {
      check(
        'fail',
        'Hooks missing from settings',
        `${wired.length} of ${manifest.hookEvents.length}`,
      );
      fail();
    }

    const statusLine = settings.statusLine as { command?: string } | undefined;
    if (statusLine?.command === manifest.statusLine.wrapperPath) {
      check(
        'pass',
        'Status line wired',
        manifest.statusLine.wrapped ? 'wrapping your previous one' : 'none was configured before',
      );
    } else {
      check('fail', 'Status line not pointing at Mirante', 'plan usage will be unavailable');
      fail();
    }

    if (existsSync(manifest.settingsPath) && (statSync(manifest.settingsPath).mode & 0o077) !== 0) {
      // The hook header carries the token, so anyone who can read this file has it.
      check(
        'warn',
        'settings.json is readable beyond you',
        'chmod 600 it if this machine has other users',
      );
    }
  }

  heading('Daemon');
  const token = readToken(config);
  check(
    token ? 'pass' : 'fail',
    token ? 'Local token present' : 'No local token',
    config.tokenPath,
  );
  if (!token) fail();

  const running = await daemonRunning(config);
  check(
    running ? 'pass' : 'warn',
    running ? 'Daemon listening' : 'Daemon not running',
    `${config.host}:${config.port}`,
  );

  heading('Data actually arriving');
  if (!existsSync(config.databasePath)) {
    check('warn', 'No database yet', 'run `mirante` and use Claude Code once');
  } else {
    const log = new EventLog(config.databasePath);
    try {
      const events = log.since(0);
      const bySource = new Map<string, number>();
      for (const event of events) bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);

      check(events.length > 0 ? 'pass' : 'warn', 'Events recorded', String(events.length));
      check(
        (bySource.get('hook') ?? 0) > 0 ? 'pass' : 'warn',
        'Hooks firing',
        `${bySource.get('hook') ?? 0} events`,
      );
      check(
        (bySource.get('transcript') ?? 0) > 0 ? 'pass' : 'warn',
        'Transcripts being read',
        `${bySource.get('transcript') ?? 0} events`,
      );

      const statusLineEvents = bySource.get('statusline') ?? 0;
      if (statusLineEvents > 0) {
        check('pass', 'Status line reporting', `${statusLineEvents} events`);
      } else {
        // The status line is a terminal-interface feature. Sessions running in an
        // editor extension never invoke it, so plan usage and cost cannot arrive
        // from them — which looks exactly like a broken install unless it is
        // spelled out here.
        const entrypoints = new Set(
          events
            .filter((event) => event.kind === 'session.started')
            .map((event) => (event.payload as { entrypoint?: string }).entrypoint),
        );
        const onlyEditor = entrypoints.size > 0 && !entrypoints.has('cli');
        check(
          'warn',
          'Status line reporting',
          onlyEditor
            ? '0 events — every session seen so far runs in an editor, and the status line runs in the terminal'
            : '0 events — open a terminal session, or check that `mirante install` ran',
        );
        if (onlyEditor) {
          check('info', 'To get plan usage and cost', 'run `claude` in a terminal at least once');
        }
      }

      const sawPlanUsage = events.some((event) => event.kind === 'plan.usage.updated');
      if (sawPlanUsage) {
        check('pass', 'Plan usage available', '5-hour and weekly limits will render');
      } else {
        // Not a failure. It is absent for API-key users and before the first API
        // response of a session, and the board renders it as unknown, not zero.
        check(
          'info',
          'Plan usage not seen yet',
          'needs a Pro or Max subscription and one API response in a live session',
        );
      }
    } finally {
      log.close();
    }
  }

  line();
  line(
    failures === 0
      ? ui.green('Everything Mirante needs is in place.')
      : ui.red(`${failures} problem${failures === 1 ? '' : 's'} to fix.`),
  );
  return failures === 0 ? 0 : 1;
};
