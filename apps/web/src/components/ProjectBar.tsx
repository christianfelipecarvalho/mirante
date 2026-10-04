import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { ProjectActivity, ProjectGroup } from '../lib/projects';
import { useI18n } from '../lib/i18n';
import { PROJECT_MARK as MARK } from '../lib/project-state';
import { summarizeProject } from '../lib/project-summary';
import { waitingText } from './AgentCard';
import { Icon } from './Icon';

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
          selected={selected === 'all'}
          onClick={() => onSelect('all')}
        />
        {ordered.map((group) => {
          // What is awaited, in the tooltip: the chip says how many, the card
          // below says what, and a hover should not have to open the card.
          const awaited =
            group.activity === 'needs_you'
              ? summarizeProject(group.lanes, Date.now()).awaited
              : undefined;
          return (
            <Chip
              key={group.key}
              label={group.name}
              awaiting={group.awaiting}
              activity={group.activity}
              {...(awaited ? { detail: waitingText(awaited.waitingOn, t) } : {})}
              selected={selected === group.key}
              onClick={() => onSelect(group.key)}
            />
          );
        })}
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
  awaiting?: number;
  /** What the project waits on, for the tooltip. */
  detail?: string;
  activity?: ProjectActivity;
  selected: boolean;
  onClick: () => void;
};

/** Working projects retain a lit frame even while another filter is selected. */
const Chip = ({ label, awaiting = 0, detail, activity, selected, onClick }: ChipProps) => {
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
      data-life={activity === 'working' ? 'working' : activity === 'needs_you' ? 'waiting' : 'rest'}
      data-beam={activity === 'working'}
      title={[label, state, detail].filter(Boolean).join(' — ')}
      className={`project-chip glow-card pressable relative flex shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px] whitespace-nowrap ${
        activity === 'needs_you' ? 'calling' : ''
      }`}
      style={
        {
          // Selection is carried by the fill and the border together, so it does
          // not rest on a hue alone.
          background: selected ? 'var(--surface-1)' : 'transparent',
          borderColor: selected ? 'var(--accent)' : 'var(--hairline)',
          color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
          '--glow': mark?.color ?? 'var(--accent)',
        } as CSSProperties
      }
    >
      {mark && (
        <span style={{ color: mark.color }} aria-hidden="true">
          <Icon name={mark.icon} size={11} />
        </span>
      )}
      <span className="max-w-[18ch] overflow-hidden text-ellipsis">{label}</span>
      {/* A bare number beside a name said nothing about what it counted; the
          cards below carry the counts, with their words. */}
      {spoken && (
        <span className="text-[11px] font-medium" style={{ color: mark?.color }}>
          {spoken}
        </span>
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
