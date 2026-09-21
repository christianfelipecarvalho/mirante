import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * No test may read the developer's own Claude Code state.
 *
 * `~/.claude.json` holds the account's identity and the real plan figure; a test
 * that reached it would put a real reading into a test database and pass or
 * fail on the developer's usage that hour — which is how this was found. Every
 * default path that resolves to it goes through CLAUDE_CONFIG_DIR, so pointing
 * that at an empty directory closes it for the whole suite. A test that needs a
 * state file writes its own.
 */
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mirante-test-claude-'));
