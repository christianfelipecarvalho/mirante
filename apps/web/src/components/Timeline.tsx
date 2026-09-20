import { useMemo, useState } from 'react';
import type { TimelineEntry, TimelineKind } from '@mirante/shared';
import { formatClock } from '../lib/format';
import { useI18n, type Translate } from '../lib/i18n';
import { Icon, type IconName } from './Icon';

const KIND_META: Record<TimelineKind, { icon: IconName; color: string }> = {
  prompt: { icon: 'prompt', color: 'var(--text-secondary)' },
  'handoff.start': { icon: 'handoff', color: 'var(--accent)' },
  'handoff.end': { icon: 'back', color: 'var(--status-good)' },
  tool: { icon: 'dot', color: 'var(--text-muted)' },
  'tool.failed': { icon: 'cross', color: 'var(--status-critical)' },
  skill: { icon: 'skill', color: 'var(--text-secondary)' },
  compaction: { icon: 'compact', color: 'var(--status-serious)' },
  permission: { icon: 'alert', color: 'var(--status-warning)' },
  error: { icon: 'cross', color: 'var(--status-critical)' },
};

type Group = 'all' | 'handoffs' | 'tools' | 'skills' | 'permissions' | 'errors';

const GROUPS: Record<Group, TimelineKind[] | undefined> = {
  all: undefined,
  handoffs: ['handoff.start', 'handoff.end', 'prompt'],
  tools: ['tool', 'tool.failed'],
  skills: ['skill', 'compaction'],
  permissions: ['permission'],
  errors: ['error', 'tool.failed'],
};

/**
 * Rows whose text is a bare English label are rebuilt in the reader's language;
 * rows carrying real content — a command, a prompt, a handoff — keep their text.
 */
const rowText = (entry: TimelineEntry, t: Translate): string => {
  switch (entry.kind) {
    case 'compaction':
      return t('timeline.compaction');
    case 'skill':
      return t('timeline.skill', { subject: entry.subject ?? entry.text });
    case 'permission':
      if (entry.subject === 'fallback') return t('timeline.permissionFallback');
      if (entry.subject === 'allow') return t('timeline.permissionAllow');
      if (entry.subject === 'deny') return t('timeline.permissionDeny');
      return t('timeline.permissionNeeded', { subject: entry.subject ?? entry.text });
    default:
      return entry.text;
  }
};

export type TimelineProps = {
  entries: TimelineEntry[];
  sessionFilter?: string | undefined;
};

export const Timeline = ({ entries, sessionFilter }: TimelineProps) => {
  const { t } = useI18n();
  const [group, setGroup] = useState<Group>('all');

  const rows = useMemo(() => {
    const kinds = GROUPS[group];
    const filtered = entries
      .filter((entry) => (sessionFilter ? entry.sessionId === sessionFilter : true))
      .filter((entry) => (kinds ? kinds.includes(entry.kind) : true))
      .slice(-400);

    // Consecutive identical rows collapse into one with a count. A board that
    // repeats "Bash" forty times is technically accurate and useless.
    const collapsed: { entry: TimelineEntry; repeats: number }[] = [];
    for (const entry of filtered) {
      const previous = collapsed.at(-1);
      if (previous && previous.entry.kind === entry.kind && previous.entry.text === entry.text) {
        previous.repeats += 1;
        continue;
      }
      collapsed.push({ entry, repeats: 1 });
    }
    return collapsed.reverse();
  }, [entries, group, sessionFilter]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col rounded-xl border"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
    >
      <div className="border-b px-3 py-2" style={{ borderColor: 'var(--hairline)' }}>
        <h2 className="text-[12px] font-semibold text-[var(--text-secondary)]">
          {t('timeline.title')}
        </h2>
        <div className="mt-2 flex flex-wrap gap-1">
          {(Object.keys(GROUPS) as Group[]).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setGroup(name)}
              className="rounded-full px-2 py-0.5 text-[10px] transition-colors"
              style={{
                background: group === name ? 'var(--surface-1)' : 'transparent',
                color: group === name ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {t(`timeline.${name}` as 'timeline.all')}
            </button>
          ))}
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 && (
          <li className="px-1 py-6 text-center text-[11px] text-[var(--text-muted)]">
            {t('timeline.empty')}
          </li>
        )}
        {rows.map(({ entry, repeats }) => {
          const meta = KIND_META[entry.kind];
          return (
            <li key={`${entry.id}-${entry.kind}`} className="flex gap-2 px-1 py-1">
              <span
                className="mt-[2px] flex w-3.5 shrink-0 justify-center"
                style={{ color: meta.color }}
              >
                <Icon name={meta.icon} size={12} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className="min-w-0 truncate text-[11px] text-[var(--text-primary)]"
                    title={entry.text}
                  >
                    {rowText(entry, t)}
                  </span>
                  {repeats > 1 && (
                    <span className="tabular shrink-0 text-[10px] text-[var(--text-muted)]">
                      {t('timeline.repeated', { count: repeats })}
                    </span>
                  )}
                </div>
                <div className="tabular text-[10px] text-[var(--text-muted)]">
                  {formatClock(entry.ts)} · {entry.agentType ?? entry.agentId}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
};
