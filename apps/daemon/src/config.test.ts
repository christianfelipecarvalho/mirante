import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_PLAN_POLL_MS, loadConfig } from './config.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('the plan-usage poll interval', () => {
  it('defaults to one minute', () => {
    delete process.env.MIRANTE_PLAN_POLL_MS;
    expect(loadConfig().planUsagePollMs).toBe(60_000);
  });

  /** The generic env parser treats 0 as unset, which would quietly re-enable it. */
  it('turns off with 0 from the environment', () => {
    process.env.MIRANTE_PLAN_POLL_MS = '0';
    expect(loadConfig().planUsagePollMs).toBe(0);
  });

  it('never polls faster than Claude Code rewrites the figure', () => {
    process.env.MIRANTE_PLAN_POLL_MS = '5000';
    expect(loadConfig().planUsagePollMs).toBe(MIN_PLAN_POLL_MS);
  });
});

describe("Claude Code's state file", () => {
  it("is never the developer's own in tests", () => {
    expect(loadConfig().claudeStatePath).not.toBe(join(homedir(), '.claude.json'));
  });

  it('lives where Claude Code looks for it when CLAUDE_CONFIG_DIR is set', () => {
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude-config';
    expect(loadConfig().claudeStatePath).toBe('/opt/claude-config/.claude.json');
  });
});
