import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { TaskPlan } from '@mirante/shared';
import { scrubSecrets } from './redact.js';

export const MARKDOWN_PLAN_MAX_BYTES = 512 * 1024;

const PLAN_WORD =
  /\b(?:plans?|planos?|planejamento|planning|progress|progresso|tracking|acompanhamento)\b/i;

/** Explicit project plan files only; no arbitrary Markdown documents or outside paths. */
export const markdownPlanSourceFile = (
  projectPath: unknown,
  filePath: unknown,
): string | undefined => {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) return undefined;
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return undefined;
  const name = basename(filePath);
  if (!/\.(?:md|markdown)$/i.test(name)) return undefined;
  if (!PLAN_WORD.test(name.replace(/[_\-.]/g, ' '))) return undefined;
  const path = relative(resolve(projectPath), resolve(projectPath, filePath));
  if (
    !path ||
    path.length > 4096 ||
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  )
    return undefined;
  return path.split(sep).join('/');
};

/** Count the recorded checkboxes, never the percentage claimed by surrounding prose. */
export const parseMarkdownPlan = (content: string): TaskPlan['steps'] | undefined => {
  if (Buffer.byteLength(content, 'utf8') > MARKDOWN_PLAN_MAX_BYTES) return undefined;
  const steps: TaskPlan['steps'] = [];
  let planHeading = false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ''
      )
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+)/.exec(line)?.[1];
    if (heading && PLAN_WORD.test(heading)) planHeading = true;
    const checkbox = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]\s*(.*)$/.exec(line);
    if (!checkbox) continue;
    // Nested parent/child rows cannot safely be assumed to have equal weight.
    if (checkbox[1] || !/^[ xX]$/.test(checkbox[2]!)) return undefined;
    const text = scrubSecrets(checkbox[3]!).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 4000 || steps.length >= 500) return undefined;
    steps.push({
      id: `step-${steps.length + 1}`,
      text,
      status: checkbox[2]!.toLowerCase() === 'x' ? 'completed' : 'pending',
    });
  }
  return planHeading && steps.length > 0 && !fence ? steps : undefined;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const markdownPlanId = (
  context: {
    sessionId: string;
    agentId: string;
    scopeId?: string;
  },
  sourceFile: string,
): string =>
  `claude:markdown:${context.sessionId}:${context.agentId}:${context.scopeId ?? 'session'}:${sourceFile}`;

/** Only call after the Write/Edit result has been paired and confirmed successful. */
export const confirmedMarkdownPlan = (context: {
  toolName: string;
  input: unknown;
  output: unknown;
  projectPath?: string;
  sessionId: string;
  agentId: string;
  scopeId?: string;
}): TaskPlan | undefined => {
  if (context.toolName !== 'Write' && context.toolName !== 'Edit') return undefined;
  const input = record(context.input);
  const output = record(context.output);
  const sourceFile = markdownPlanSourceFile(context.projectPath, output?.filePath);
  if (
    !sourceFile ||
    sourceFile !== markdownPlanSourceFile(context.projectPath, input?.file_path) ||
    output?.userModified === true
  )
    return undefined;
  let content: string;
  if (context.toolName === 'Write') {
    if (typeof output?.content !== 'string') return undefined;
    content = output.content;
  } else {
    if (
      typeof output?.originalFile !== 'string' ||
      typeof output.oldString !== 'string' ||
      !output.oldString ||
      typeof output.newString !== 'string' ||
      typeof output.replaceAll !== 'boolean' ||
      output.oldString !== input?.old_string ||
      output.newString !== input?.new_string ||
      output.replaceAll !== (input?.replace_all ?? false) ||
      Buffer.byteLength(output.originalFile, 'utf8') > MARKDOWN_PLAN_MAX_BYTES
    )
      return undefined;
    const parts = output.originalFile.split(output.oldString);
    if (parts.length < 2 || (!output.replaceAll && parts.length !== 2)) return undefined;
    if (
      output.originalFile.length +
        (parts.length - 1) * (output.newString.length - output.oldString.length) >
      MARKDOWN_PLAN_MAX_BYTES
    )
      return undefined;
    content = parts.join(output.newString);
  }
  const steps = parseMarkdownPlan(content);
  if (!steps) return undefined;
  const safeFile = scrubSecrets(sourceFile);
  if (safeFile.length > 4096) return undefined;
  return {
    planId: markdownPlanId(context, safeFile),
    ...(context.scopeId ? { scopeId: context.scopeId } : {}),
    sourceTool: 'Markdown',
    // A scrubbed path is display text, not a different file to follow on disk.
    ...(safeFile === sourceFile ? { sourceFile } : {}),
    completeness: 'full',
    steps,
  };
};
