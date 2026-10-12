import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import { instructionTranslations } from './instruction-translation-client';
import { type InstructionLanguage, type InstructionTranslation } from './instruction-translation';

export const useVisibleInstruction = <ElementType extends HTMLElement>() => {
  const ref = useRef<ElementType>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: '160px' },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
};

export const useInstructionTranslation = (text: string | undefined, visible: boolean) => {
  const { locale } = useI18n();
  const target: InstructionLanguage = locale === 'pt-BR' ? 'pt' : 'en';
  const key = `${target}\0${text ?? ''}`;
  const [reading, setReading] = useState<{ key: string; value: InstructionTranslation }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!text || !visible) return;
    return instructionTranslations.subscribe(text, target, () => {
      setReading(undefined);
      setAttempt((value) => value + 1);
    });
  }, [text, target, visible]);
  useEffect(() => {
    if (!text || !visible) return;
    let live = true;
    void instructionTranslations.get(text, target).then((value) => {
      if (live) setReading({ key, value });
    });
    return () => {
      live = false;
    };
  }, [key, text, target, visible, attempt]);
  // Never show a result from the preceding language while an effect catches up.
  const value = reading?.key === key ? reading.value : undefined;
  return {
    target,
    value,
    loading: Boolean(text && !value),
    retry: () => {
      if (text) instructionTranslations.invalidate(text, target);
      setReading(undefined);
      setAttempt((value) => value + 1);
    },
  };
};
