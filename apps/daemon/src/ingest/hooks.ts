import { z } from 'zod';
import { MAIN_AGENT_ID, dedupeKeys, type DraftEvent } from '@mirante/shared';
import { preview, summarizeToolInput } from '../core/redact.js';

/**
 * Hook payloads, read leniently.
 *
 * Mirante does not own this schema. A field that disappears should cost one
 * derived event, not the ingest path.
 */
export const hookPayloadSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string(),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
    permission_mode: z.string().optional(),
    prompt_id: z.string().optional(),
    /** Present only when the hook fired inside a subagent. Routes the event to the right card. */
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    tool_response: z.unknown().optional(),
    prompt: z.string().optional(),
    message: z.string().optional(),
    /** Notification subtype: permission_prompt, idle_prompt, agent_needs_input, quota_auto_resume_*. */
    notification_type: z.string().optional(),
    source: z.string().optional(),
    trigger: z.string().optional(),
  })
  .passthrough();

export type HookPayload = z.infer<typeof hookPayloadSchema>;

export type HookContext = {
  /** Assigned by the daemon for PermissionRequest, which carries no tool_use_id. */
  requestId?: string;
  /** When the daemon will stop waiting for a click and let the terminal prompt. */
  decideBy?: string;
  now?: string;
};

/**
 * Notification types that mean Claude is blocked on the human.
 *
 * `permission_prompt` is deliberately absent: it only fires about six seconds
 * after the prompt appears, and PermissionRequest already gave us the signal
 * immediately.
 */
const WAITING_NOTIFICATIONS = new Set(['idle_prompt', 'agent_needs_input', 'elicitation_dialog']);

/** Notification types that mean a usage limit interrupted the session. */
const QUOTA_NOTIFICATIONS = new Set([
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
]);

export const hookToEvents = (payload: HookPayload, context: HookContext = {}): DraftEvent[] => {
  const ts = context.now ?? new Date().toISOString();
  const base = {
    ts,
    source: 'hook' as const,
    sessionId: payload.session_id,
    projectPath: payload.cwd ?? '',
    agentId: payload.agent_id ?? MAIN_AGENT_ID,
    ...(payload.agent_type ? { agentType: payload.agent_type } : {}),
    ...(payload.prompt_id ? { promptId: payload.prompt_id } : {}),
  };

  switch (payload.hook_event_name) {
    case 'SessionStart':
      return [
        {
          ...base,
          kind: 'session.started',
          dedupeKey: dedupeKeys.sessionStarted(payload.session_id),
          payload: {
            // The transcript knows the real entrypoint and outranks this event,
            // so the lane corrects itself a moment later. See ADR-0002.
            entrypoint: 'unknown',
            cwd: payload.cwd ?? '',
            ...(payload.permission_mode ? { permissionMode: payload.permission_mode } : {}),
            ...(payload.source === 'resume' ? { resumed: true } : {}),
          },
        },
      ];

    case 'SessionEnd':
      return [
        {
          ...base,
          kind: 'session.ended',
          dedupeKey: dedupeKeys.sessionEnded(payload.session_id),
          payload: { ...(payload.source ? { reason: payload.source } : {}) },
        },
      ];

    case 'UserPromptSubmit': {
      const text = payload.prompt ?? '';
      return [
        {
          ...base,
          kind: 'prompt.submitted',
          ...(payload.prompt_id
            ? { dedupeKey: dedupeKeys.promptSubmitted(payload.prompt_id) }
            : {}),
          payload: {
            ...(payload.prompt_id ? { promptId: payload.prompt_id } : {}),
            preview: preview(text),
            charCount: text.length,
          },
        },
      ];
    }

    case 'SubagentStart':
      return payload.agent_id
        ? [
            {
              ...base,
              agentId: payload.agent_id,
              parentAgentId: MAIN_AGENT_ID,
              kind: 'agent.started',
              dedupeKey: dedupeKeys.agentStarted(payload.agent_id),
              payload: {
                agentType: payload.agent_type ?? 'unknown',
                // Hooks do not say whether the launch blocks the parent. The
                // transcript's tool result does, and outranks this.
                spawnMode: 'async',
              },
            },
          ]
        : [];

    case 'SubagentStop':
      return payload.agent_id
        ? [
            {
              ...base,
              agentId: payload.agent_id,
              parentAgentId: MAIN_AGENT_ID,
              kind: 'agent.finished',
              dedupeKey: dedupeKeys.agentFinished(payload.agent_id),
              payload: { outcome: 'ok', handedBackTo: MAIN_AGENT_ID },
            },
          ]
        : [];

    case 'PreToolUse': {
      // Never blocks. PreToolUse fires on every tool call, so holding it open
      // would add the approval window to each one. Approval runs through
      // PermissionRequest, which fires only when a decision is actually needed.
      if (!payload.tool_use_id || !payload.tool_name) return [];
      return [
        {
          ...base,
          correlationId: payload.tool_use_id,
          dedupeKey: dedupeKeys.toolStarted(payload.tool_use_id),
          kind: 'tool.started',
          payload: {
            toolUseId: payload.tool_use_id,
            toolName: payload.tool_name,
            summary: summarizeToolInput(payload.tool_name, payload.tool_input),
          },
        },
      ];
    }

    case 'PostToolUse':
      if (!payload.tool_use_id || !payload.tool_name) return [];
      return [
        {
          ...base,
          correlationId: payload.tool_use_id,
          dedupeKey: dedupeKeys.toolFinished(payload.tool_use_id),
          kind: 'tool.finished',
          payload: { toolUseId: payload.tool_use_id, toolName: payload.tool_name },
        },
      ];

    case 'PostToolUseFailure':
      if (!payload.tool_use_id || !payload.tool_name) return [];
      return [
        {
          ...base,
          correlationId: payload.tool_use_id,
          dedupeKey: dedupeKeys.toolFailed(payload.tool_use_id),
          kind: 'tool.failed',
          payload: {
            toolUseId: payload.tool_use_id,
            toolName: payload.tool_name,
            errorPreview: preview(payload.tool_response ?? payload.message ?? ''),
          },
        },
      ];

    case 'PermissionRequest': {
      if (!context.requestId || !context.decideBy || !payload.tool_name) return [];
      return [
        {
          ...base,
          dedupeKey: dedupeKeys.permissionRequested(context.requestId),
          kind: 'permission.requested',
          payload: {
            requestId: context.requestId,
            toolName: payload.tool_name,
            inputPreview: summarizeToolInput(payload.tool_name, payload.tool_input),
            decideBy: context.decideBy,
          },
        },
      ];
    }

    case 'PermissionDenied':
      if (!context.requestId) return [];
      return [
        {
          ...base,
          dedupeKey: dedupeKeys.permissionResolved(context.requestId),
          kind: 'permission.resolved',
          payload: { requestId: context.requestId, decision: 'deny', via: 'external' },
        },
      ];

    case 'Notification': {
      const type = payload.notification_type ?? '';
      if (QUOTA_NOTIFICATIONS.has(type)) {
        return [
          {
            ...base,
            kind: 'error.raised',
            payload: {
              kind: 'api',
              message: preview(payload.message ?? `Usage limit: ${type}`),
              recoverable: true,
            },
          },
        ];
      }
      if (!WAITING_NOTIFICATIONS.has(type)) return [];
      return [
        {
          ...base,
          kind: 'waiting.changed',
          payload: {
            status: {
              state: 'waiting_input',
              waitingOn: {
                summary: preview(payload.message ?? 'Claude is waiting for you'),
                reason: 'input',
                subject: type,
                since: ts,
                ref: type,
              },
            },
          },
        },
      ];
    }

    case 'Stop':
      return [
        {
          ...base,
          kind: 'waiting.changed',
          payload: { status: { state: 'idle' } },
        },
      ];

    case 'StopFailure':
      return [
        {
          ...base,
          kind: 'error.raised',
          payload: { kind: 'api', message: preview(payload.message ?? 'Turn ended with an error') },
        },
      ];

    case 'PreCompact':
    case 'PostCompact':
      return [
        {
          ...base,
          kind: 'context.compacted',
          payload: {
            phase: payload.hook_event_name === 'PreCompact' ? 'pre' : 'post',
            ...(payload.trigger === 'auto' || payload.trigger === 'manual'
              ? { trigger: payload.trigger }
              : {}),
          },
        },
      ];

    default:
      return [];
  }
};
