import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LOCALES, LOCALE_LABEL, useI18n } from '../lib/i18n';
import { THEMES, useTheme, type Theme } from '../lib/theme';
import { Icon } from './Icon';

/**
 * Theme and language, behind one control.
 *
 * They were six buttons in the header, as prominent as the plan limits and
 * changed perhaps once. Collapsing them gives the header back to the numbers
 * that move.
 */
export const DisplaySettings = () => {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Closes on Escape and on a click anywhere else — the two ways people expect
  // a menu to go away. Focus returns to the button so the keyboard is not lost.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('settings.label')}
        title={t('settings.label')}
        className="pressable grid size-8 cursor-pointer place-items-center rounded-md border transition-colors duration-200 hover:border-[var(--accent)]"
        style={{
          borderColor: open ? 'var(--accent)' : 'var(--hairline)',
          color: 'var(--text-secondary)',
        }}
      >
        <Icon name="sliders" size={15} />
      </button>

      {open && (
        <div
          id={panelId}
          className="panel-enter absolute top-full right-0 z-30 mt-2 w-[220px] rounded-lg border p-3"
          style={{
            background: 'var(--surface-1)',
            borderColor: 'var(--hairline)',
            boxShadow: '0 12px 32px -12px rgba(0, 0, 0, 0.5)',
          }}
        >
          <Segment label={t('settings.theme')}>
            {THEMES.map((option: Theme) => (
              <Option key={option} selected={theme === option} onClick={() => setTheme(option)}>
                {t(`theme.${option}` as 'theme.auto')}
              </Option>
            ))}
          </Segment>
          <div className="h-3" />
          <Segment label={t('settings.language')}>
            {LOCALES.map((option) => (
              <Option key={option} selected={locale === option} onClick={() => setLocale(option)}>
                {LOCALE_LABEL[option]}
              </Option>
            ))}
          </Segment>
        </div>
      )}
    </div>
  );
};

const Segment = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label}>
    <div className="mb-1.5 text-[11px] text-[var(--text-muted)]">{label}</div>
    <div className="flex gap-1 rounded-md p-0.5" style={{ background: 'var(--surface-2)' }}>
      {children}
    </div>
  </div>
);

const Option = ({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    className="pressable flex-1 cursor-pointer rounded px-2 py-1 text-[11px] font-medium"
    style={{
      background: selected ? 'var(--surface-1)' : 'transparent',
      color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
      boxShadow: selected ? 'inset 0 0 0 1px var(--hairline)' : undefined,
    }}
  >
    {children}
  </button>
);
