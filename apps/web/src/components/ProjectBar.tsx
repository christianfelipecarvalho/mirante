import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ProjectActivity, ProjectGroup } from '../lib/projects';
import { useI18n } from '../lib/i18n';
import { Icon, type IconName } from './Icon';

/**
 * Each state gets its own shape, not just its own colour, so the row still reads
 * in greyscale and for a colourblind reader.
 */
const MARK: Record<ProjectActivity, { icon: IconName; color: string }> = {
  needs_you: { icon: 'alert', color: 'var(--status-warning)' },
  working: { icon: 'play', color: 'var(--accent)' },
  blocked: { icon: 'pause', color: 'var(--status-serious)' },
  idle: { icon: 'dot', color: 'var(--text-muted)' },
  finished: { icon: 'check', color: 'var(--text-muted)' },
};

export type ProjectBarProps = {
  groups: ProjectGroup[];
  selected: string;
  onSelect: (key: string) => void;
  archivedCount: number;
  onRestoreAll: () => void;
};

/**
 * One button per project, in the order the board shows them.
 *
 * A dropdown hides the thing you came to look at: which projects are busy. These
 * chips carry that on their face, so the answer arrives before the click.
 */
export const ProjectBar = ({
  groups,
  selected,
  onSelect,
  archivedCount,
  onRestoreAll,
}: ProjectBarProps) => {
  const { t } = useI18n();
  const rail = useRef<HTMLDivElement>(null);
  const overflowing = useOverflow(rail);
  const ordered = useFrozenWhileHeld(groups, rail);
  const liveSessions = groups.reduce((sum, group) => sum + group.liveSessions, 0);

  return (
    <div className="flex items-center gap-2" role="group" aria-label={t('filter.project')}>
      {/* One row that scrolls sideways rather than wrapping: wrapping would push
          the board down by a line every time a project appears. */}
      <div
        ref={rail}
        data-overflow={overflowing}
        className="rail flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1"
      >
        <Chip
          label={t('project.allSessions')}
          count={liveSessions}
          selected={selected === 'all'}
          onClick={() => onSelect('all')}
        />
        {ordered.map((group) => (
          <Chip
            key={group.key}
            label={group.name}
            count={group.liveSessions}
            awaiting={group.awaiting}
            activity={group.activity}
            selected={selected === group.key}
            onClick={() => onSelect(group.key)}
          />
        ))}
      </div>

      {archivedCount > 0 && (
        <button
          // Keyed on the count, so archiving something flashes the place where it
          // went — which is also where the undo lives.
          key={archivedCount}
          type="button"
          onClick={onRestoreAll}
          className="arrive pressable flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] whitespace-nowrap"
          style={{ color: 'var(--text-muted)' }}
        >
          <Icon name="archive" size={12} />
          {archivedCount === 1
            ? t('project.restoreOne')
            : t('project.restoreAll', { n: archivedCount })}
        </button>
      )}
    </div>
  );
};

type ChipProps = {
  label: string;
  count: number;
  awaiting?: number;
  activity?: ProjectActivity;
  selected: boolean;
  onClick: () => void;
};

/**
 * Motion is spent in one place only. Every project that is merely running would
 * make the whole row twitch; only the one waiting on a decision earns the eye.
 * `prefers-reduced-motion` is honoured globally in index.css.
 */
const Chip = ({ label, count, awaiting = 0, activity, selected, onClick }: ChipProps) => {
  const { t } = useI18n();
  const mark = activity ? MARK[activity] : undefined;
  const state = activity ? t(`project.state.${activity}` as 'project.state.idle') : undefined;

  // The states that ask something of the reader say so in words on the chip;
  // the rest are carried by the icon and the tooltip.
  const spoken =
    activity === 'needs_you'
      ? t('project.waiting', { n: awaiting })
      : activity === 'blocked'
        ? t('plan.atLimit')
        : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={state ? `${label} — ${state}` : label}
      className={`pressable flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] whitespace-nowrap ${
        activity === 'needs_you' ? 'calling' : ''
      }`}
      style={{
        // Selection is carried by the fill and the border together, so it does
        // not rest on a hue alone.
        background: selected ? 'var(--surface-1)' : 'transparent',
        borderColor: selected ? 'var(--accent)' : 'var(--hairline)',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {mark && (
        <span style={{ color: mark.color }} aria-hidden="true">
          <Icon name={mark.icon} size={11} />
        </span>
      )}
      <span className="max-w-[18ch] overflow-hidden text-ellipsis">{label}</span>
      {spoken ? (
        <span className="text-[11px] font-medium" style={{ color: mark?.color }}>
          {spoken}
        </span>
      ) : (
        count > 0 && (
          <span className="tabular text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {count}
          </span>
        )
      )}
      {state && !spoken && <span className="sr-only">{state}</span>}
    </button>
  );
};

/** Whether the rail is wider than its box, so the fade shows only when there is more. */
const useOverflow = (ref: RefObject<HTMLElement | null>): boolean => {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });
  return overflowing;
};

/**
 * The live order, except while the pointer or keyboard focus is in the row.
 *
 * Projects change rank as they start and stop working. A chip that slides away
 * as you reach for it is worse than an order that is a few seconds stale, so the
 * row holds still while it is being used and catches up when it is let go.
 */
const useFrozenWhileHeld = (
  groups: ProjectGroup[],
  ref: RefObject<HTMLElement | null>,
): ProjectGroup[] => {
  const [held, setHeld] = useState(false);
  const frozen = useRef<string[]>([]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const hold = () => setHeld(true);
    const release = () => {
      if (!element.matches(':hover') && !element.contains(document.activeElement)) setHeld(false);
    };
    const releaseSoon = () => window.setTimeout(release, 0);
    element.addEventListener('pointerenter', hold);
    element.addEventListener('focusin', hold);
    element.addEventListener('pointerleave', release);
    element.addEventListener('focusout', releaseSoon);
    return () => {
      element.removeEventListener('pointerenter', hold);
      element.removeEventListener('focusin', hold);
      element.removeEventListener('pointerleave', release);
      element.removeEventListener('focusout', releaseSoon);
    };
  }, [ref]);

  if (!held) {
    frozen.current = groups.map((group) => group.key);
    return groups;
  }

  // Keep the held order for projects already shown; anything new goes last.
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const kept = frozen.current
    .map((key) => byKey.get(key))
    .filter((group): group is ProjectGroup => group !== undefined);
  const added = groups.filter((group) => !frozen.current.includes(group.key));
  return [...kept, ...added];
};
