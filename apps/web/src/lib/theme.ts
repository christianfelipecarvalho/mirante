import { useCallback, useEffect, useState } from 'react';

export const THEMES = ['auto', 'dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'mirante.theme';

const read = (): Theme => {
  // A theme in the URL wins, so a link can carry one — the same way session, tab
  // and agent already do.
  const fromUrl = new URLSearchParams(window.location.search).get('theme');
  if (fromUrl && (THEMES as readonly string[]).includes(fromUrl)) return fromUrl as Theme;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (THEMES as readonly string[]).includes(stored)) return stored as Theme;
  } catch {
    // Private mode. The default is as good a starting point as any.
  }
  return 'auto';
};

const systemPrefersLight = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: light)').matches;

/**
 * Applies the theme as an attribute, which is what the stylesheet keys off.
 *
 * `auto` resolves to the system preference rather than leaving the attribute
 * off, so there is exactly one place that decides — the alternative is a media
 * query and an attribute disagreeing about what "dark" means.
 */
const apply = (theme: Theme): void => {
  const resolved = theme === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
};

export const useTheme = (): { theme: Theme; setTheme: (theme: Theme) => void } => {
  const [theme, setThemeState] = useState<Theme>(read);

  useEffect(() => {
    apply(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not remembering the choice is not a reason to refuse it.
    }

    if (theme !== 'auto' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('auto');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  return { theme, setTheme };
};
