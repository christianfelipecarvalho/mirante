/** Plain, quiet output. A tool that shouts about routine work is tiring to run. */
const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const paint = (code: string, text: string): string =>
  supportsColor ? `\u001B[${code}m${text}\u001B[0m` : text;

export const ui = {
  bold: (text: string) => paint('1', text),
  dim: (text: string) => paint('2', text),
  green: (text: string) => paint('32', text),
  yellow: (text: string) => paint('33', text),
  red: (text: string) => paint('31', text),
  cyan: (text: string) => paint('36', text),
};

export const heading = (text: string): void => {
  process.stdout.write(`\n${ui.bold(text)}\n`);
};

export const line = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};

export const bullet = (text: string): void => line(`  ${ui.dim('•')} ${text}`);

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** Status carries an icon and a word, never colour alone — the same rule the board follows. */
export const check = (status: CheckStatus, label: string, detail?: string): void => {
  const marks: Record<CheckStatus, string> = {
    pass: ui.green('✓ ok  '),
    warn: ui.yellow('! warn'),
    fail: ui.red('✕ fail'),
    info: ui.dim('· info'),
  };
  line(`  ${marks[status]}  ${label}${detail ? ` ${ui.dim(`— ${detail}`)}` : ''}`);
};
