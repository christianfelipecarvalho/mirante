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

/**
 * Editor context the VS Code extension puts ahead of a prompt: the file that was
 * open, the lines that were selected.
 *
 * It rides in the same entry as what the person typed, first, so a preview cut
 * at a fixed length shows only the editor's note and never the request — and
 * that note can name a file like `.env`. An unterminated tag, which is what a
 * cut preview leaves behind, is stripped to the end.
 */
const EDITOR_CONTEXT = /<(ide_[a-z_]+)>[\s\S]*?(?:<\/\1>|$)/g;

export const stripEditorContext = (text: string): string => text.replace(EDITOR_CONTEXT, '').trim();

/** What a person actually asked, or `undefined` when an entry carries no request. */
export const requestText = (text: string): string | undefined => {
  if (isInjectedMessage(text)) return undefined;
  const cleaned = stripEditorContext(text);
  return cleaned.length > 0 ? cleaned : undefined;
};
