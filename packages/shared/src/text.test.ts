import { describe, expect, it } from 'vitest';
import { isInjectedMessage, requestText } from './text.js';

describe('injected Claude messages', () => {
  it('recognizes remote-session hand-backs even without transcript metadata', () => {
    const text =
      'Another Claude session sent a message:\n<agent-message from="reviewer">\n[Subagent hand-back] Review completed.';
    expect(isInjectedMessage(text)).toBe(true);
    expect(isInjectedMessage(`  \n${text}`)).toBe(true);
    expect(requestText(text)).toBeUndefined();
  });

  it('keeps real requests that discuss messages or mention their tags', () => {
    for (const text of [
      'Another Claude session sent a message: please explain it.',
      'Explain <agent-message from="reviewer"> to me.',
      'Explain this wrapper: Another Claude session sent a message:\n<agent-message from="reviewer">',
    ]) {
      expect(isInjectedMessage(text)).toBe(false);
      expect(requestText(text)).toBe(text);
    }
  });
});
