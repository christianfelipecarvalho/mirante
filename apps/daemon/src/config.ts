import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type MiranteConfig = {
  /** Where Mirante keeps its own data. Nothing here is ever sent anywhere. */
  home: string;
  databasePath: string;
  tokenPath: string;
  /** Written while the daemon is listening, so a later run can take the port over. */
  pidPath: string;
  /** Loopback only. Binding anywhere else would expose prompts to the network. */
  host: string;
  port: number;
  /** Where Claude Code writes session transcripts. */
  claudeProjectsDir: string;
  /**
   * Claude Code's own state file. Read for one key — the plan-usage figure it
   * already fetched — and for nothing else. Never a credential file. See
   * ADR-0006.
   */
  claudeStatePath: string;
  /**
   * How often, while an agent is working, to run `/usage` and read the figure it
   * leaves. Claude Code fetches it at most once a minute, so faster finds nothing
   * new. Nothing runs while idle. 0 disables. See ADR-0007.
   */
  planUsagePollMs: number;
  /**
   * How long the daemon holds a permission request before answering `ask` and
   * letting the terminal prompt. Must stay well under the hook's own timeout: a
   * hook that times out on PreToolUse does not block the call, so waiting longer
   * buys nothing and risks the decision arriving after the call already went
   * through. See ARCHITECTURE.md.
   */
  approvalWindowMs: number;
  /**
   * One extra browser origin to accept, for running the board from Vite's dev
   * server while the daemon serves the API.
   *
   * Opt-in through MIRANTE_DEV_ORIGIN and empty otherwise: widening the Origin
   * check is the one thing standing between a page you happen to have open and
   * your prompts, so it never happens by default or by inference.
   */
  devOrigin?: string;
};

const DEFAULT_PORT = 7788;

/**
 * The plan-usage poll interval. Parsed on its own because 0 is meaningful here —
 * it turns the poller off — and `envNumber` treats 0 as unset. Anything else is
 * held to one minute: Claude Code rewrites the figure at most that often, so
 * polling faster only re-reads the same bytes.
 */
export const MIN_PLAN_POLL_MS = 60_000;
const planPollMs = (override: number | undefined): number => {
  const raw =
    override ??
    (process.env.MIRANTE_PLAN_POLL_MS === undefined
      ? undefined
      : Number(process.env.MIRANTE_PLAN_POLL_MS));
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return MIN_PLAN_POLL_MS;
  return raw === 0 ? 0 : Math.max(MIN_PLAN_POLL_MS, raw);
};

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadConfig = (overrides: Partial<MiranteConfig> = {}): MiranteConfig => {
  const home = overrides.home ?? process.env.MIRANTE_HOME ?? join(homedir(), '.mirante');
  return {
    home,
    databasePath: overrides.databasePath ?? join(home, 'mirante.db'),
    tokenPath: overrides.tokenPath ?? join(home, 'token'),
    pidPath: overrides.pidPath ?? join(home, 'daemon.pid'),
    // Not configurable by environment on purpose. See ADR-0005.
    host: '127.0.0.1',
    port: overrides.port ?? envNumber('MIRANTE_PORT', DEFAULT_PORT),
    claudeProjectsDir:
      overrides.claudeProjectsDir ??
      process.env.CLAUDE_PROJECTS_DIR ??
      join(homedir(), '.claude', 'projects'),
    // Where Claude Code itself looks: CLAUDE_CONFIG_DIR when set, home otherwise.
    // Hardcoding home would leave those users with "unknown" forever and no hint.
    claudeStatePath:
      overrides.claudeStatePath ?? join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json'),
    planUsagePollMs: planPollMs(overrides.planUsagePollMs),
    approvalWindowMs: overrides.approvalWindowMs ?? envNumber('MIRANTE_APPROVAL_WINDOW_MS', 20_000),
    ...((overrides.devOrigin ?? process.env.MIRANTE_DEV_ORIGIN)
      ? { devOrigin: overrides.devOrigin ?? process.env.MIRANTE_DEV_ORIGIN }
      : {}),
  };
};

export const ensureHome = (config: MiranteConfig): void => {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
};

/**
 * The shared secret hooks and the status line present to the daemon.
 *
 * Written 0600 and never logged. It authenticates local callers; it is not a
 * credential for anything else, and Mirante holds no other kind.
 */
export const loadOrCreateToken = (config: MiranteConfig): string => {
  ensureHome(config);
  if (existsSync(config.tokenPath)) {
    const existing = readFileSync(config.tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(config.tokenPath, 0o600);
  return token;
};

export const readToken = (config: MiranteConfig): string | undefined => {
  if (!existsSync(config.tokenPath)) return undefined;
  const token = readFileSync(config.tokenPath, 'utf8').trim();
  return token.length > 0 ? token : undefined;
};
