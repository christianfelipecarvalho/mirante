import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DraftEvent, MiranteEvent } from '@mirante/shared';

type Row = {
  id: number;
  ts: string;
  received_ts: string;
  source: string;
  session_id: string;
  project_path: string;
  git_branch: string | null;
  agent_id: string;
  agent_type: string | null;
  parent_agent_id: string | null;
  correlation_id: string | null;
  prompt_id: string | null;
  dedupe_key: string | null;
  kind: string;
  payload: string;
};

const TABLES = `
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  received_ts     TEXT NOT NULL,
  source          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  git_branch      TEXT,
  agent_id        TEXT NOT NULL,
  agent_type      TEXT,
  parent_agent_id TEXT,
  correlation_id  TEXT,
  prompt_id       TEXT,
  dedupe_key      TEXT,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL
);

-- Where the transcript reader left off in each file, so a restart resumes
-- instead of re-emitting a session from the beginning.
CREATE TABLE IF NOT EXISTS file_offsets (
  path       TEXT PRIMARY KEY,
  signature  TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Created after migration, not with the tables: an index over a column added by
 * a later version cannot exist until that column does.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_dedupe  ON events(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_events_prompt  ON events(prompt_id);
`;

const toEvent = (row: Row): MiranteEvent =>
  ({
    id: row.id,
    ts: row.ts,
    receivedTs: row.received_ts,
    source: row.source,
    sessionId: row.session_id,
    projectPath: row.project_path,
    ...(row.git_branch ? { gitBranch: row.git_branch } : {}),
    agentId: row.agent_id,
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.prompt_id ? { promptId: row.prompt_id } : {}),
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
  }) as MiranteEvent;

/**
 * The append-only event log.
 *
 * Ids are assigned here and nowhere else, which is what keeps them strictly
 * increasing and lets a client resume from any point. Nothing is ever updated or
 * deleted except by an explicit purge: the log doubles as the audit trail for a
 * tool that reads prompts, so overlapping reports from two sources are both
 * kept and reconciled at projection time. See ADR-0002.
 */
export class EventLog {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(TABLES);
    this.migrate();
    this.db.exec(INDEXES);
  }

  /**
   * Brings an older database up to the current shape.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing for a table that already exists, so
   * a column added later never appears and every insert fails against a database
   * from the previous version. Adding columns is the only migration shape needed
   * so far — the log is append-only, so nothing ever has to be rewritten.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name),
    );
    const added: [string, string][] = [['prompt_id', 'TEXT']];
    for (const [name, type] of added) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    }
  }

  append(draft: DraftEvent): MiranteEvent {
    return this.appendMany([draft])[0] as MiranteEvent;
  }

  appendMany(drafts: readonly DraftEvent[]): MiranteEvent[] {
    if (drafts.length === 0) return [];
    const receivedTs = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO events
        (ts, received_ts, source, session_id, project_path, git_branch, agent_id,
         agent_type, parent_agent_id, correlation_id, prompt_id, dedupe_key, kind, payload)
      VALUES (@ts, @received_ts, @source, @session_id, @project_path, @git_branch, @agent_id,
              @agent_type, @parent_agent_id, @correlation_id, @prompt_id, @dedupe_key, @kind, @payload)
    `);

    const run = this.db.transaction((items: readonly DraftEvent[]) =>
      items.map((draft) => {
        const info = insert.run({
          ts: draft.ts,
          received_ts: receivedTs,
          source: draft.source,
          session_id: draft.sessionId,
          project_path: draft.projectPath,
          git_branch: draft.gitBranch ?? null,
          agent_id: draft.agentId,
          agent_type: draft.agentType ?? null,
          parent_agent_id: draft.parentAgentId ?? null,
          correlation_id: draft.correlationId ?? null,
          prompt_id: draft.promptId ?? null,
          dedupe_key: draft.dedupeKey ?? null,
          kind: draft.kind,
          payload: JSON.stringify(draft.payload),
        });
        return { ...draft, id: Number(info.lastInsertRowid), receivedTs } as MiranteEvent;
      }),
    );

    return run(drafts);
  }

  /** Replay. `afterId` of 0 returns the whole log. */
  since(afterId: number, limit = 100_000): MiranteEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(afterId, limit) as Row[];
    return rows.map(toEvent);
  }

  lastId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null };
    return row.id ?? 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return row.n;
  }

  getOffset(path: string): { signature: string; byteOffset: number } | undefined {
    const row = this.db
      .prepare('SELECT signature, byte_offset FROM file_offsets WHERE path = ?')
      .get(path) as { signature: string; byte_offset: number } | undefined;
    return row ? { signature: row.signature, byteOffset: row.byte_offset } : undefined;
  }

  setOffset(path: string, signature: string, byteOffset: number): void {
    this.db
      .prepare(
        `INSERT INTO file_offsets (path, signature, byte_offset, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET signature = excluded.signature,
                                         byte_offset = excluded.byte_offset,
                                         updated_at = excluded.updated_at`,
      )
      .run(path, signature, byteOffset, new Date().toISOString());
  }

  /**
   * Removes everything Mirante has stored.
   *
   * Stored prompts and tool inputs can contain secrets, so this has to actually
   * empty the file rather than mark rows deleted — VACUUM is the difference
   * between a purge and a promise.
   */
  purge(): void {
    this.db.exec('DELETE FROM events; DELETE FROM file_offsets; DELETE FROM meta;');
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}
