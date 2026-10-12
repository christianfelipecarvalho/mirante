import { readToken } from './client';
import {
  InstructionTranslations,
  type InstructionLanguage,
  type InstructionTranslation,
} from './instruction-translation';

const request = async (
  text: string,
  target: InstructionLanguage,
  signal: AbortSignal,
): Promise<InstructionTranslation> => {
  try {
    const response = await fetch('/api/instructions/translate', {
      method: 'POST',
      headers: { authorization: `Bearer ${readToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text, target }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    });
    if (!response.ok) return { ok: false, reason: 'failed' };
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return { ok: false, reason: 'failed' };
    const value = body as Record<string, unknown>;
    if (
      value.ok === true &&
      typeof value.text === 'string' &&
      typeof value.translated === 'boolean' &&
      ['en', 'pt', 'unknown'].includes(String(value.sourceLanguage))
    )
      return value as InstructionTranslation;
    return {
      ok: false,
      reason: value.reason === 'unavailable' || value.reason === 'busy' ? value.reason : 'failed',
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
};

export const instructionTranslations = new InstructionTranslations(request);
