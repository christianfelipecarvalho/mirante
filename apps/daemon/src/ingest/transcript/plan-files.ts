import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BoardProjector, MAIN_AGENT_ID, type DraftEvent, type MiranteEvent } from '@mirante/shared';
import { MARKDOWN_PLAN_MAX_BYTES, parseMarkdownPlan } from '../../core/markdown-plan.js';

type PlanEvent = Extract<DraftEvent, { kind: 'task.plan.updated' }>;
type Tracked = {
  confirmed: PlanEvent;
  signature: string;
  steps: PlanEvent['payload']['steps'];
  lastKey: string;
  endedAt?: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Only open the explicitly recorded project file; never discover files by scanning. */
const readPlanFile = (event: PlanEvent): { content: string; ts: string } | undefined => {
  const sourceFile = event.payload.sourceFile;
  if (!sourceFile || !isAbsolute(event.projectPath) || isAbsolute(sourceFile)) return;
  let fd: number | undefined;
  try {
    const root = realpathSync(event.projectPath);
    const path = resolve(root, sourceFile);
    if (!inside(root, path)) return;
    const realPath = realpathSync(path);
    if (!inside(root, realPath)) return;
    // Do not follow a last-component symlink swapped after realpath, or block
    // on a pipe/device substituted for the recorded Markdown file.
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MARKDOWN_PLAN_MAX_BYTES) return;
    const data = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const read = readSync(fd, data, bytes, data.length - bytes, bytes);
      if (!read) break;
      bytes += read;
    }
    const after = fstatSync(fd);
    if (
      bytes !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      realpathSync(path) !== realPath ||
      before.mtimeMs > Date.now() + 1_000
    )
      return;
    return { content: data.subarray(0, bytes).toString('utf8'), ts: before.mtime.toISOString() };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** Follow checklists only for the assignment that actually recorded them.
 * File edits are metadata: they never wake agents or imply task completion. */
export class MarkdownPlanFiles {
  private readonly sessions = new Map<string, Map<string, Tracked>>();
  private readonly restored = new Map<string, PlanEvent>();
  private readonly corrections = new Map<string, PlanEvent[]>();

  restore(event: PlanEvent): void {
    if (event.source === 'plan-file') this.restored.set(event.payload.planId, event);
  }

  remember(sessionId: string, events: readonly DraftEvent[], historical: boolean): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const recorded = events.filter(
      (event): event is PlanEvent =>
        event.kind === 'task.plan.updated' && event.payload.sourceTool === 'Markdown',
    );
    if (!recorded.length) return;
    const owners = new Map<string, Set<string>>();
    const fileKey = (event: PlanEvent) =>
      JSON.stringify([resolve(event.projectPath), event.payload.sourceFile]);
    for (const event of recorded) {
      const key = fileKey(event);
      const agents = owners.get(key) ?? new Set<string>();
      agents.add(event.agentId);
      owners.set(key, agents);
    }
    const projector = new BoardProjector();
    projector.applyAll(
      events.map((event, index) => ({
        ...event,
        id: index + 1,
        receivedTs: event.ts,
      })) as MiranteEvent[],
    );
    const lane = projector.snapshot().sessions.find((lane) => lane.sessionId === sessionId);
    if (!lane) return;
    const tracked = new Map<string, Tracked>();
    for (const card of lane.cards) {
      if (!card.plan?.sourceFile || card.plan.sourceTool !== 'Markdown') continue;
      const confirmed = recorded.findLast(
        (event) =>
          event.agentId === card.agentId &&
          event.payload.planId === card.plan?.planId &&
          event.ts === card.plan.updatedAt,
      );
      if (!confirmed) continue;
      if (card.agentId !== MAIN_AGENT_ID && (owners.get(fileKey(confirmed))?.size ?? 0) > 1) {
        const observed = this.restored.get(confirmed.payload.planId);
        if (observed?.payload.completeness === 'full') {
          // A later file reading outranks the earlier transcript snapshot.
          // Record newly discovered shared ownership at observation time so
          // an old full percentage cannot survive the transcript correction.
          const correction: PlanEvent = {
            ...observed,
            ts: new Date().toISOString(),
            dedupeKey: `plan-file:${hash(`${observed.dedupeKey}:shared`)}`,
            payload: { ...observed.payload, completeness: 'partial' },
          };
          this.restore(correction);
          this.corrections.set(sessionId, [...(this.corrections.get(sessionId) ?? []), correction]);
        }
        continue;
      }
      if (historical || (card.plan.completeness !== 'full' && card.plan.steps.length > 0)) continue;
      const old = previous?.get(card.agentId);
      const same =
        old !== undefined &&
        old.confirmed.dedupeKey === confirmed.dedupeKey &&
        JSON.stringify(old.confirmed.payload) === JSON.stringify(confirmed.payload);
      const restored = this.restored.get(confirmed.payload.planId);
      const prior = restored && restored.ts >= confirmed.ts ? restored : confirmed;
      const endedAt = card.endedAt ?? lane.endedAt;
      tracked.set(card.agentId, {
        confirmed,
        signature: same
          ? old.signature
          : prior.payload.completeness === 'full'
            ? JSON.stringify(prior.payload.steps)
            : 'unavailable',
        steps: same ? old.steps : prior.payload.steps,
        lastKey: same ? old.lastKey : (prior.dedupeKey ?? confirmed.payload.planId),
        ...(endedAt ? { endedAt } : {}),
      });
    }
    if (tracked.size) this.sessions.set(sessionId, tracked);
  }

  forgetExcept(sessionIds: ReadonlySet<string>): void {
    for (const id of this.sessions.keys()) if (!sessionIds.has(id)) this.sessions.delete(id);
  }

  read(sessionId: string): PlanEvent[] {
    const events = this.corrections.get(sessionId) ?? [];
    this.corrections.delete(sessionId);
    const tracked = this.sessions.get(sessionId);
    if (!tracked) return events;
    for (const [agentId, item] of tracked) {
      const { confirmed } = item;
      const file = readPlanFile(confirmed);
      // A completed assignment can receive its last file snapshot once, but
      // later edits by another task must never rewrite its historical progress.
      if (item.endedAt) {
        tracked.delete(agentId);
        if (!file || file.ts > item.endedAt) continue;
      }
      if (file && confirmed.payload.steps.length > 0 && file.ts < confirmed.ts) continue;
      const steps = file ? parseMarkdownPlan(file.content) : undefined;
      const signature = steps ? JSON.stringify(steps) : 'unavailable';
      if (signature === item.signature) continue;
      item.signature = signature;
      if (steps) item.steps = steps;
      const event: PlanEvent = {
        // This is when we observed the file, whose mtime may be preserved by
        // an editor/restore. Using mtime as event time could strand a partial
        // snapshot forever after the file becomes readable again.
        ts: new Date().toISOString(),
        source: 'plan-file',
        sessionId,
        projectPath: confirmed.projectPath,
        agentId,
        ...(confirmed.promptId ? { promptId: confirmed.promptId } : {}),
        // A reopen to an earlier checkbox state is still a new observation.
        dedupeKey: `plan-file:${hash(`${item.lastKey}:${file?.ts ?? ''}:${signature}`)}`,
        kind: 'task.plan.updated',
        payload: {
          ...confirmed.payload,
          completeness: steps ? 'full' : 'partial',
          steps: item.steps,
        },
      };
      item.lastKey = event.dedupeKey!;
      this.restore(event);
      events.push(event);
    }
    return events;
  }
}
