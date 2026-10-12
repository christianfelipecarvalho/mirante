import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import {
  useInstructionTranslation,
  useVisibleInstruction,
} from '../lib/use-instruction-translation';
import { Icon } from './Icon';

/** Real, redacted delegation text. Native disclosure keeps long instructions
 * available without turning every activity row into a screenful of prose. */
export const InstructionText = ({
  text,
  availability,
  charCount,
  truncated,
  defaultOpen = false,
  summaryLabel,
}: {
  text?: string;
  availability?: 'captured' | 'encrypted' | 'missing';
  charCount?: number;
  truncated?: boolean;
  /** Quick agent details start with the instruction readable in full. */
  defaultOpen?: boolean;
  summaryLabel?: string;
}) => {
  const { t, locale } = useI18n();
  const { ref, visible } = useVisibleInstruction<HTMLDivElement>();
  const { value, target, loading, retry } = useInstructionTranslation(text, visible);
  const [originalFor, setOriginalFor] = useState<string>();
  useEffect(() => setOriginalFor(undefined), [locale, text]);
  const identity = `${locale}\0${text ?? ''}`;
  const showOriginal = originalFor === identity;
  const translated = value?.ok && value.translated;
  const body = showOriginal
    ? text
    : value?.ok
      ? value.text
      : value
        ? text
        : t('instruction.translating');
  const language =
    translated && !showOriginal
      ? target
      : value?.ok && value.sourceLanguage !== 'unknown'
        ? value.sourceLanguage
        : undefined;
  if (!text)
    return (
      <div ref={ref}>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {t(availability === 'encrypted' ? 'instruction.encrypted' : 'instruction.missing')}
        </p>
      </div>
    );
  const cut = truncated ?? Boolean(charCount && charCount > text.length && text.endsWith('…'));
  return (
    <div ref={ref} className="min-w-0" aria-busy={loading && !showOriginal}>
      <details open={defaultOpen || undefined} className="group min-w-0 text-[12px]">
        <summary className="pressable min-h-9 cursor-pointer rounded py-1 text-[var(--text-primary)]">
          <span className="inline-block max-w-full align-top">
            <span
              lang={summaryLabel ? locale : language}
              className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {summaryLabel ?? body}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--accent)]">
            <Icon name="disclose" size={11} />
            <span className="group-open:hidden">{t('instruction.read')}</span>
            <span className="hidden group-open:inline">{t('instruction.close')}</span>
          </span>
        </summary>
        {(translated || loading || (value && !value.ok)) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="text-[var(--text-secondary)]" role={loading ? 'status' : undefined}>
              {loading
                ? t('instruction.translating')
                : value && !value.ok
                  ? t('instruction.original')
                  : t(showOriginal ? 'instruction.original' : 'instruction.automatic')}
            </span>
            {(translated || loading) && (
              <button
                type="button"
                className="pressable cursor-pointer rounded px-1 py-1 text-[var(--accent)]"
                aria-pressed={showOriginal}
                onClick={() => setOriginalFor(showOriginal ? undefined : identity)}
              >
                {t(showOriginal ? 'instruction.showPanelLanguage' : 'instruction.showOriginal')}
              </button>
            )}
            {value && !value.ok && (
              <button
                type="button"
                onClick={retry}
                className="pressable cursor-pointer rounded px-1 py-1 text-[var(--accent)]"
              >
                {t('instruction.retryTranslation')}
              </button>
            )}
          </div>
        )}
        <div
          role="region"
          aria-label={t('instruction.text')}
          tabIndex={0}
          className="mt-2 max-h-[min(55vh,36rem)] max-w-[75ch] overflow-y-auto pr-2"
        >
          <blockquote
            lang={language}
            className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-primary)] [overflow-wrap:anywhere]"
          >
            {body}
          </blockquote>
        </div>
        {cut && (
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            {t('brief.kept', { kept: text.length, total: charCount ?? text.length })}
          </p>
        )}
      </details>
      {value && !value.ok && (
        <p role="status" className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {t(
            value.reason === 'unavailable'
              ? 'instruction.translationUnavailable'
              : 'instruction.translationFailed',
          )}
        </p>
      )}
    </div>
  );
};
