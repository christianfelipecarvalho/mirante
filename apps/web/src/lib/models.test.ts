import { describe, expect, it } from 'vitest';
import { modelLabel } from './models.js';

const short = (raw: string | undefined): string | undefined => modelLabel(raw)?.short;

describe('modelLabel', () => {
  it('names a Claude model by family and version', () => {
    expect(modelLabel('claude-opus-5-5')).toEqual({
      short: 'Opus 5.5',
      full: 'claude-opus-5-5',
      vendor: 'anthropic',
    });
    expect(short('claude-opus-5')).toBe('Opus 5');
    expect(short('claude-sonnet-5')).toBe('Sonnet 5');
    expect(short('claude-fable-5-1')).toBe('Fable 5.1');
    expect(short('claude-fable-5')).toBe('Fable 5');
  });

  it('drops the snapshot date from the label but keeps it in the full id', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toEqual({
      short: 'Haiku 4.5',
      full: 'claude-haiku-4-5-20251001',
      vendor: 'anthropic',
    });
  });

  it('does not take a snapshot date for a minor version', () => {
    expect(short('claude-opus-4-20250514')).toBe('Opus 4');
  });

  it('reads the order Claude ids used before version 4', () => {
    expect(modelLabel('claude-3-5-sonnet-20241022')).toEqual({
      short: 'Sonnet 3.5',
      full: 'claude-3-5-sonnet-20241022',
      vendor: 'anthropic',
    });
  });

  it('tells the 1M-context variant apart from the same model', () => {
    expect(modelLabel('claude-opus-5-5[1m]')).toEqual({
      short: 'Opus 5.5 1M',
      full: 'claude-opus-5-5[1m]',
      vendor: 'anthropic',
    });
  });

  it('names the aliases a subagent definition uses', () => {
    expect(modelLabel('opus')).toEqual({ short: 'Opus', full: 'opus', vendor: 'anthropic' });
    expect(short('sonnet')).toBe('Sonnet');
    expect(short('haiku')).toBe('Haiku');
    expect(short('fable')).toBe('Fable');
  });

  /**
   * The caller shows "unknown" for these. A card that read "inherit" or
   * "<synthetic>" would present a marker as if it were a model.
   */
  it('says nothing for a value that names no model', () => {
    expect(modelLabel('inherit')).toBeUndefined();
    expect(modelLabel('<synthetic>')).toBeUndefined();
    expect(modelLabel('')).toBeUndefined();
    expect(modelLabel(undefined)).toBeUndefined();
  });

  it('names a Codex model by its version and the words after it', () => {
    expect(modelLabel('gpt-6-sol')).toEqual({
      short: 'GPT-6 Sol',
      full: 'gpt-6-sol',
      vendor: 'openai',
    });
    expect(short('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(short('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(short('gpt-5.6-terra')).toBe('GPT-5.6 Terra');
    expect(short('gpt-5.6-luna')).toBe('GPT-5.6 Luna');
    expect(short('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(short('gpt-5.5')).toBe('GPT-5.5');
    expect(short('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark');
  });

  it('keeps an o-series id as it is', () => {
    expect(modelLabel('o3')).toEqual({ short: 'o3', full: 'o3', vendor: 'openai' });
    expect(modelLabel('o4-mini')).toEqual({ short: 'o4-mini', full: 'o4-mini', vendor: 'openai' });
  });

  it('passes an id it does not understand through untouched, claiming no vendor', () => {
    expect(modelLabel('codex-auto-review')).toStrictEqual({
      short: 'codex-auto-review',
      full: 'codex-auto-review',
    });
  });
});
