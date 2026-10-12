import {
  MAIN_AGENT_ID,
  requestText,
  type AgentCard,
  type MiranteEvent,
  type SessionLane,
} from '@mirante/shared';
import { buildSteps } from './steps.js';
import { isFollowUp } from './turns.js';

/** The captured, redacted text understood by InstructionText. */
export type AgentMapInstruction = {
  text?: string;
  availability?: 'captured' | 'encrypted' | 'missing';
  charCount?: number;
  truncated?: boolean;
};

/** Select a real instruction, never a card's headline or current activity. */
export const agentMapInstruction = (
  lane: SessionLane,
  card: AgentCard,
  events: readonly MiranteEvent[],
): AgentMapInstruction => {
  if (card.sessionId !== lane.sessionId) return { availability: 'missing' };

  if (card.agentId !== MAIN_AGENT_ID) {
    const projected = {
      text: card.brief,
      availability: card.briefAvailability ?? (card.brief ? 'captured' : 'missing'),
      charCount: card.briefCharCount,
      truncated: card.briefTruncated,
    } satisfies AgentMapInstruction;
    // The projector knows the current assignment even when history is only
    // partially loaded. An earlier captured task must not replace it.
    if (card.brief) return projected;

    const assignments = events.filter(
      (event) =>
        event.sessionId === lane.sessionId &&
        ((event.kind === 'agent.started' && event.agentId === card.agentId) ||
          (event.kind === 'agent.instruction' &&
            event.payload.recipientAgentId === card.agentId &&
            ['assignment', 'followup'].includes(event.payload.instructionType))),
    );
    const latest = buildSteps(assignments, { sessionId: lane.sessionId })
      .filter(
        (step) =>
          step.kind === 'instruction' &&
          step.instruction?.recipientAgentId === card.agentId &&
          step.ts >= card.startedAt,
      )
      .sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)[0];
    if (!latest?.instruction) return projected;
    return {
      text: latest.detail,
      availability: latest.instruction.availability,
      charCount: latest.instruction.charCount,
      truncated: latest.instruction.truncated,
    };
  }

  const prompts = events.filter(
    (event): event is Extract<MiranteEvent, { kind: 'prompt.submitted' }> =>
      event.sessionId === lane.sessionId &&
      event.agentId === MAIN_AGENT_ID &&
      !event.parentAgentId &&
      event.kind === 'prompt.submitted',
  );
  const byId = new Map(prompts.map((event) => [event.id, event]));
  // Reuse the activity reader's source precedence and the request strip's
  // follow-up policy, while retaining each actual event's count and cut marker.
  const requests = buildSteps(prompts, { sessionId: lane.sessionId })
    .flatMap((step) => {
      if (step.kind !== 'prompt' || step.injected) return [];
      const event = byId.get(step.id);
      const text = event && requestText(event.payload.preview);
      return event && text ? [{ event, text }] : [];
    })
    .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.event.id - b.event.id);
  let index = requests.length - 1;
  while (index > 0 && isFollowUp(requests[index]?.text ?? '')) index -= 1;
  const selected = requests[index];
  if (!selected) return { availability: 'missing' };
  const { preview, charCount } = selected.event.payload;
  return {
    text: selected.text,
    availability: 'captured',
    charCount,
    // A larger original count can also come from redaction, whitespace or
    // stripped editor context. Only the ingest ellipsis indicates a cut.
    truncated: charCount > preview.length && preview.endsWith('…'),
  };
};
