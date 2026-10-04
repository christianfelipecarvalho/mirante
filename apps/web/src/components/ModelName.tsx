import { useI18n } from '../lib/i18n';
import { modelLabel, type ModelLabel } from '../lib/models';

/** Company names, the same in every language. */
const VENDOR: Record<NonNullable<ModelLabel['vendor']>, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/**
 * The model an agent runs, as a person reads it: "Opus 5.5", not
 * `claude-opus-5-5`. The exact id stays in the tooltip.
 *
 * Set like the figures it sits beside — the same weight and colour as tokens
 * and time — rather than as a chip: the footer already holds the skill chip,
 * and two chips side by side would read as two skills. No vendor colour:
 * colour on this board means state.
 *
 * Nothing is drawn while the agent has not said which model it runs, as
 * before: an empty place in a footer claims nothing.
 */
export const ModelName = ({ model }: { model?: string | undefined }) => {
  const { t } = useI18n();
  const label = modelLabel(model);
  if (!label) return null;

  return (
    <span
      // Keyed on the model, so a switch mid-session is noticed once, not missed.
      key={label.full}
      className="arrive min-w-0 max-w-[22ch] truncate font-medium text-[var(--text-primary)]"
      title={`${t('card.model')} ${label.full}${label.vendor ? ` (${VENDOR[label.vendor]})` : ''}`}
    >
      {/* So a screen reader says what the name is. */}
      <span className="sr-only">{t('card.model')} </span>
      {label.short}
    </span>
  );
};
