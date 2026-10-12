import { useId, useMemo, useState } from 'react';
import {
  completionOf,
  livenessOf,
  needsRecovery,
  type AgentControlRun,
  type SessionLane,
} from '@mirante/shared';
import { agentOrdinals, describeAgent } from '../lib/agents';
import type { BoardClient } from '../lib/client';
import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

const inProgress = (run?: AgentControlRun) =>
  Boolean(run && ['queued', 'running', 'stopping'].includes(run.status));

/** Recovery results remain distinct from observed finish markers. A completed
 * CLI turn may still report pending or blocked work; only its explicit report
 * and evidence resolve the recovery row. No command runs on mount or refresh. */
export const AgentControls = ({
  lane,
  runs,
  now,
  onControl,
}: {
  lane: SessionLane;
  runs: AgentControlRun[];
  now: number;
  onControl: BoardClient['controlAgents'];
}) => {
  const { t } = useI18n();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const latest = useMemo(() => {
    const result = new Map<string, AgentControlRun>();
    for (const run of runs) if (run.sessionId === lane.sessionId) result.set(run.agentId, run);
    return result;
  }, [runs, lane.sessionId]);
  const ordinals = agentOrdinals(lane.cards, (card) => describeAgent(card, t).name);
  const resolved = (agentId: string) => {
    const run = latest.get(agentId);
    const card = lane.cards.find((card) => card.agentId === agentId)!;
    return (
      run?.status === 'completed' &&
      run.verdict === 'completed' &&
      Date.parse(run.finishedAt ?? '') >= Date.parse(card.lastEventAt ?? card.startedAt)
    );
  };
  const candidates = lane.cards.filter(
    (card) => needsRecovery(card, now, Boolean(lane.endedAt)) || latest.has(card.agentId),
  );
  const pending = candidates.filter(
    (card) =>
      !resolved(card.agentId) &&
      completionOf(card) !== 'completed' &&
      livenessOf(card, now, Boolean(lane.endedAt)) !== 'live' &&
      !inProgress(latest.get(card.agentId)),
  );
  const activeRuns = [...latest.values()].filter((run) => inProgress(run));
  const sessionBusy =
    lane.harness === 'claude-code' &&
    lane.cards.some((card) => livenessOf(card, now, Boolean(lane.endedAt)) === 'live') &&
    activeRuns.length === 0;

  if (candidates.length === 0) return null;

  const act = async (action: 'verify' | 'resume' | 'stop', ids: string[]) => {
    setOpen(true);
    setSending(true);
    setMessage(undefined);
    try {
      const result = await onControl(lane.sessionId, action, ids);
      if (!result.ok)
        setMessage({
          error: true,
          text: t(`control.reason.${result.reason}` as 'control.reason.unreachable'),
        });
      else
        setMessage({
          error: false,
          text:
            t(action === 'stop' ? 'control.stopRequested' : 'control.queued', {
              n: result.runIds.length,
            }) +
            (result.skipped.length ? ` ${t('control.skipped', { n: result.skipped.length })}` : ''),
        });
    } catch {
      setMessage({ error: true, text: t('control.reason.unreachable') });
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className="shrink-0 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2"
      aria-label={t('control.label')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          className="pressable flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-[12px] font-medium text-[var(--text-primary)]"
        >
          <Icon name="pause" size={14} />
          {t('control.review', { n: pending.length })}
          <Icon name="down" size={12} className={open ? 'rotate-180' : undefined} />
        </button>
        {activeRuns.length > 0 && (
          <span role="status" className="text-[11px] text-[var(--accent)]">
            {t('control.executions', { n: activeRuns.length })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={sending || sessionBusy || pending.length === 0}
            onClick={() =>
              void act(
                'verify',
                pending.map((card) => card.agentId),
              )
            }
            className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
          >
            {t('control.verifyAll')}
          </button>
          <button
            type="button"
            disabled={sending || sessionBusy || pending.length === 0}
            onClick={() =>
              void act(
                'resume',
                pending.map((card) => card.agentId),
              )
            }
            className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
          >
            {t('control.resumeAll')}
          </button>
          {activeRuns.length > 0 && (
            <button
              type="button"
              disabled={sending}
              onClick={() =>
                void act(
                  'stop',
                  activeRuns.map((run) => run.runId),
                )
              }
              className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--status-serious)] disabled:opacity-50"
            >
              {t('control.stopAll')}
            </button>
          )}
        </div>
      </div>
      {sessionBusy && (
        <p role="status" className="mt-2 text-[11px] text-[var(--status-warning)]">
          {t('control.reason.session-busy')}
        </p>
      )}
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={t('control.reports')}
          tabIndex={0}
          className="mt-2 max-h-[min(36vh,360px)] overflow-y-auto border-t border-[var(--hairline)] pt-2"
        >
          <p className="max-w-[85ch] text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {t('control.hint')}
          </p>
          {lane.harness === 'claude-code' && (
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('control.coordinator')}</p>
          )}
          <ul className="mt-2 divide-y divide-[var(--hairline)]">
            {candidates.map((card) => {
              const run = latest.get(card.agentId);
              const busy = inProgress(run);
              const live = livenessOf(card, now, Boolean(lane.endedAt)) === 'live';
              const superseded = Boolean(
                run?.finishedAt &&
                Date.parse(card.lastEventAt ?? card.startedAt) > Date.parse(run.finishedAt),
              );
              const finished = resolved(card.agentId) || completionOf(card) === 'completed';
              const identity = describeAgent(card, t);
              const ordinal = ordinals.get(card.agentId);
              const label = `${identity.name}${ordinal === undefined ? '' : ` ${ordinal}`}`;
              const verdict = run?.status === 'completed' && !superseded ? run.verdict : undefined;
              const status = live
                ? t('control.observed.working')
                : run && !superseded
                  ? t(`control.status.${run.status}` as 'control.status.queued')
                  : t(
                      `control.observed.${completionOf(card) ?? 'unknown'}` as 'control.observed.unknown',
                    );
              return (
                <li
                  key={card.agentId}
                  className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
                >
                  <div className="min-w-0 flex-1 basis-[220px]">
                    <p className="text-[12px] font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">
                      {label}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                      {verdict
                        ? t(`control.verdict.${verdict}` as 'control.verdict.unknown')
                        : status}
                    </p>
                    <p
                      className="mt-1 truncate text-[11px] text-[var(--text-muted)]"
                      title={card.task ?? card.lastActivity}
                    >
                      {card.task ?? card.lastActivity ?? t('control.noTask')}
                    </p>
                    {run?.summary && (
                      <p className="mt-1 max-w-[90ch] whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                        {superseded && <span>{t('control.previousReport')} </span>}
                        {run.summary}
                      </p>
                    )}
                    {run?.reason && (
                      <p className="mt-1 text-[11px] text-[var(--status-serious)]">
                        {t(`control.reason.${run.reason}` as 'control.reason.unreachable')}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {busy ? (
                      <button
                        type="button"
                        disabled={sending || run?.status === 'stopping'}
                        onClick={() => void act('stop', [run!.runId])}
                        aria-label={t('control.stopAgent', { agent: label })}
                        className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--status-serious)] disabled:opacity-50"
                      >
                        {t(run?.status === 'queued' ? 'control.cancelQueued' : 'control.stop')}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={sending || sessionBusy || live || finished}
                          onClick={() => void act('verify', [card.agentId])}
                          aria-label={t('control.verifyAgent', { agent: label })}
                          className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
                        >
                          {t('control.verify')}
                        </button>
                        <button
                          type="button"
                          disabled={sending || sessionBusy || live || finished}
                          onClick={() => void act('resume', [card.agentId])}
                          aria-label={t('control.resumeAgent', { agent: label })}
                          className="pressable min-h-9 cursor-pointer rounded border border-[var(--hairline)] px-2.5 text-[11px] text-[var(--text-primary)] disabled:cursor-default disabled:opacity-50"
                        >
                          {t('control.resume')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {message && (
        <p
          role={message.error ? 'alert' : 'status'}
          className="mt-2 text-[11px]"
          style={{ color: message.error ? 'var(--status-serious)' : 'var(--text-secondary)' }}
        >
          {message.text}
        </p>
      )}
    </section>
  );
};
