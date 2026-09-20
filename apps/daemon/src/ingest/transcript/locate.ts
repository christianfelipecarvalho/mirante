import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type SubagentFile = {
  agentId: string;
  transcriptPath: string;
  metaPath: string | undefined;
};

export type LocatedSession = {
  sessionId: string;
  projectSlug: string;
  mainPath: string;
  subagentsDir: string;
  subagents: SubagentFile[];
  /** Newest mtime across all of the session's files. */
  lastModifiedMs: number;
};

const safeStat = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

const safeReaddir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/**
 * Finds a session's subagent transcripts.
 *
 * This directory layout is internal to Claude Code, not a documented interface.
 * It is read defensively and reported as missing rather than thrown on, so a
 * layout change costs the agent tree and not the whole board. See ADR-0004.
 */
export const locateSubagents = (subagentsDir: string): SubagentFile[] => {
  if (!existsSync(subagentsDir)) return [];
  const files: SubagentFile[] = [];
  for (const entry of safeReaddir(subagentsDir)) {
    if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
    const agentId = basename(entry, '.jsonl').slice('agent-'.length);
    const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
    files.push({
      agentId,
      transcriptPath: join(subagentsDir, entry),
      metaPath: existsSync(metaPath) ? metaPath : undefined,
    });
  }
  return files;
};

export const locateSession = (
  projectsDir: string,
  projectSlug: string,
  sessionId: string,
): LocatedSession | undefined => {
  const mainPath = join(projectsDir, projectSlug, `${sessionId}.jsonl`);
  const mainStat = safeStat(mainPath);
  if (!mainStat) return undefined;

  const subagentsDir = join(projectsDir, projectSlug, sessionId, 'subagents');
  const subagents = locateSubagents(subagentsDir);

  let lastModifiedMs = mainStat.mtimeMs;
  for (const sub of subagents) {
    const stat = safeStat(sub.transcriptPath);
    if (stat && stat.mtimeMs > lastModifiedMs) lastModifiedMs = stat.mtimeMs;
  }

  return { sessionId, projectSlug, mainPath, subagentsDir, subagents, lastModifiedMs };
};

/**
 * Every session on disk, newest first.
 *
 * `maxAgeMs` keeps the board about what is happening rather than about
 * everything that ever happened — browsable history is M2.
 */
export const locateSessions = (projectsDir: string, maxAgeMs?: number): LocatedSession[] => {
  if (!existsSync(projectsDir)) return [];
  const cutoff = maxAgeMs === undefined ? 0 : Date.now() - maxAgeMs;
  const sessions: LocatedSession[] = [];

  for (const slug of safeReaddir(projectsDir)) {
    const dir = join(projectsDir, slug);
    if (!safeStat(dir)?.isDirectory()) continue;

    for (const entry of safeReaddir(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const session = locateSession(projectsDir, slug, basename(entry, '.jsonl'));
      if (session && session.lastModifiedMs >= cutoff) sessions.push(session);
    }
  }

  return sessions.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
};

/** Cheap change detection: a file's identity plus its size and mtime. */
export const fileSignature = (path: string): string => {
  const stat = safeStat(path);
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : 'missing';
};

export const sessionSignature = (session: LocatedSession): string =>
  [
    fileSignature(session.mainPath),
    ...session.subagents.map((s) => `${s.agentId}=${fileSignature(s.transcriptPath)}`),
  ].join('|');
