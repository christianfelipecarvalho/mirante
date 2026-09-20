/**
 * Markers Claude Code uses for messages it writes to itself — a subagent handing
 * work back, a task notification, a reminder injected into a turn.
 *
 * These arrive as ordinary `type: "user"` entries with string content, so
 * nothing but the text distinguishes them from something a person typed.
 * Counted as requests, they bury the real ones.
 */
export const INJECTED_MESSAGE_PREFIXES = [
  '<task-notification>',
  '<agent-message',
  '<system-reminder>',
  '<local-command-',
  '<command-name>',
  '[Subagent hand-back]',
  '<user-prompt-submit-hook>',
] as const;

/**
 * Lives in `shared` because both sides need it.
 *
 * The daemon stops recording these going forward, but its log is append-only —
 * everything captured before the rule existed is still there. A reader that
 * does not apply the same test shows machine chatter as requests forever, or
 * asks the user to purge, which is a worse answer.
 */
export const isInjectedMessage = (text: string): boolean => {
  const head = text.trimStart();
  return INJECTED_MESSAGE_PREFIXES.some((prefix) => head.startsWith(prefix));
};
