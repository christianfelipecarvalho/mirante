import type { TimelineEntry, TimelineKind } from '@mirante/shared';
import { formatClock } from '../lib/format';

const KIND_META: Record<TimelineKind, { glyph: string; color: string; label: string }> = {
  prompt: { glyph: '›', color: 'var(--text-secondary)', label: 'Prompt' },
  'handoff.start': { glyph: '⇢', color: 'var(--accent)', label: 'Handoff' },
  'handoff.end': { glyph: '⇠', color: 'var(--status-good)', label: 'Returned' },
  tool: { glyph: '▸', color: 'var(--text-muted)', label: 'Tool' },
  'tool.failed': { glyph: '✕', color: 'var(--status-critical)', label: 'Tool failed' },
  skill: { glyph: '✦', color: 'var(--text-secondary)', label: 'Skill' },
  compaction: { glyph: '⋯', color: 'var(--status-serious)', label: 'Compacted' },
  permission: { glyph: '⚠', color: 'var(--status-warning)', label: 'Permission' },
  error: { glyph: '✕', color: 'var(--status-critical)', label: 'Error' },
};

export type TimelineProps = {
  entries: TimelineEntry[];
  sessionFilter?: string | undefined;
};

export const Timeline = ({ entries, sessionFilter }: TimelineProps) => {
  const shown = (sessionFilter ? entries.filter((e) => e.sessionId === sessionFilter) : entries)
    .slice(-300)
    .reverse();

  return (
    <aside
      className="flex h-full min-h-0 flex-col rounded-xl border"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <h2
        className="border-b px-3 py-2 text-[12px] font-semibold text-[var(--text-secondary)]"
        style={{ borderColor: 'var(--hairline)' }}
      >
        Timeline
      </h2>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {shown.length === 0 && (
          <li className="px-1 py-6 text-center text-[11px] text-[var(--text-muted)]">
            Nothing yet. Start a session in your terminal or VS Code.
          </li>
        )}
        {shown.map((entry) => {
          const meta = KIND_META[entry.kind];
          return (
            <li key={entry.id} className="flex gap-2 px-1 py-1">
              <span
                aria-hidden="true"
                className="mt-[1px] w-3 shrink-0 text-center text-[11px]"
                style={{ color: meta.color }}
              >
                {meta.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-[var(--text-primary)]" title={entry.text}>
                  {entry.text}
                </div>
                <div className="tabular text-[10px] text-[var(--text-muted)]">
                  {formatClock(entry.ts)} · <span className="sr-only">{meta.label} · </span>
                  {entry.agentType ?? entry.agentId}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
};
