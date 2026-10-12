import { useI18n } from '../lib/i18n';
import {
  useInstructionTranslation,
  useVisibleInstruction,
} from '../lib/use-instruction-translation';

/** The turn heading and the expanded instruction share the full-text cache. */
export const InstructionPreview = ({ text }: { text: string }) => {
  const { t } = useI18n();
  const { ref, visible } = useVisibleInstruction<HTMLSpanElement>();
  const { value, target } = useInstructionTranslation(text, visible);
  const body = value?.ok
    ? value.text
    : value
      ? `${t('instruction.original')}: ${text}`
      : t('instruction.translating');
  return (
    <span
      ref={ref}
      title={value ? body : undefined}
      lang={value?.ok && value.translated ? target : undefined}
    >
      {t('instruction.label')}: {body.slice(0, 240)}
    </span>
  );
};
