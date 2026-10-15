import { useId } from 'react';
import { workProgress } from '@mirante/shared';
import { describeAgent } from '../lib/agents';
import { formatClock } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { AgentProgress, agentProgressState, type TaskProgressProps } from './AgentProgress';
import { Icon } from './Icon';
import { StateBadge } from './StateBadge';
import './TaskProgress.css';

export type { TaskProgressProps } from './AgentProgress';

/** One plan owner at a time: adding a subagent's checklist to its parent's
 * checklist would count the same delegated work twice. */
export const TaskProgress = ({
  card,
  plan: explicitPlan,
  now,
  sessionEnded = false,
}: TaskProgressProps) => {
  const { t } = useI18n();
  const id = useId();
  const plan = explicitPlan ?? card?.plan;
  const progress = workProgress(plan);
  const known = progress.percent !== undefined;
  const current = plan?.steps.find((step) => step.status === 'in_progress');
  const state = agentProgressState(card, now, sessionEnded);
  const count = t('progress.count', { completed: progress.completed, total: progress.total });
  const subtitle = !plan
    ? t('progress.unknown')
    : !progress.total
      ? t('progress.empty')
      : plan.completeness === 'partial'
        ? t('progress.partial')
        : count;
  const identity = card ? describeAgent(card, t).name : undefined;
  const summary = (
    <>
      <AgentProgress card={card} plan={plan} now={now} sessionEnded={sessionEnded} />
      <span className="task-progress-heading">
        <span className="task-progress-title">
          {t('progress.title')}
          {identity && <span className="task-progress-owner"> · {identity}</span>}
        </span>
        <span className="task-progress-count" role="status" aria-live="polite">
          {subtitle}
        </span>
      </span>
      {card && <StateBadge status={card.status} override={state.override} />}
    </>
  );
  if (!plan || !progress.total)
    return (
      <section
        className="task-progress task-progress-empty"
        aria-label={t('progress.title')}
        data-tone={state.tone}
      >
        <div className="task-progress-summary">{summary}</div>
        <p className="task-progress-explanation">{t('progress.recordHint')}</p>
      </section>
    );
  return (
    <section className="task-progress" aria-label={t('progress.title')} data-tone={state.tone}>
      <details className="task-progress-details">
        <summary className="task-progress-summary pressable">
          {summary}
          <span className="task-progress-disclosure">
            <Icon name="disclose" size={14} />
            <span className="task-progress-show">{t('progress.showPlan')}</span>
            <span className="task-progress-hide">{t('progress.hidePlan')}</span>
          </span>
        </summary>
        <div className="task-progress-body" id={`${id}-steps`}>
          {plan.sourceTool === 'Markdown' && plan.sourceFile && (
            <p className="task-progress-source">
              {t('progress.fileChecklist', { file: plan.sourceFile })}
            </p>
          )}
          <p className="task-progress-explanation">
            {plan.completeness === 'partial'
              ? t('progress.partialHint')
              : t('progress.explanation')}
          </p>
          <ol className="task-progress-steps">
            {plan.steps.map((step) => (
              <li key={step.id} data-step-state={step.status}>
                <span className="task-progress-step-icon" aria-hidden="true">
                  <Icon
                    name={
                      step.status === 'completed'
                        ? 'check'
                        : step.status === 'in_progress'
                          ? 'play'
                          : 'circle'
                    }
                    size={15}
                  />
                </span>
                <span className="task-progress-step-text">{step.text}</span>
                <span className="task-progress-step-state">
                  {t(
                    step.status === 'completed'
                      ? 'progress.completed'
                      : step.status === 'in_progress'
                        ? 'progress.inProgress'
                        : 'progress.pending',
                  )}
                </span>
              </li>
            ))}
          </ol>
          <p className="task-progress-updated">
            {t('progress.updated', { time: formatClock(plan.updatedAt) })}
          </p>
        </div>
      </details>
      {known && (
        <progress
          className="task-progress-bar"
          max={100}
          value={progress.percent}
          aria-label={t('progress.title')}
          aria-valuetext={`${progress.percent}% · ${count}`}
        />
      )}
      {current && (
        <p className="task-progress-current">
          <span>{t(state.tone === 'working' ? 'progress.current' : 'progress.lastCurrent')}</span>
          <span title={current.text}>{current.text}</span>
        </p>
      )}
    </section>
  );
};
