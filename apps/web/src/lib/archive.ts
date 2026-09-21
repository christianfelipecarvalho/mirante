import { useCallback, useState } from 'react';

const KEY = 'mirante.archived';

/**
 * Projects the person has put away.
 *
 * Archiving hides a project from the board. It deletes nothing: the event log is
 * append-only and untouched, and restoring brings the project back exactly as it
 * was. This lives in the browser rather than in the daemon because it is a
 * preference about one person's view, not a fact about the work.
 */
const read = (): Set<string> => {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [],
    );
  } catch {
    // Private mode, or a value someone else wrote. An empty set shows everything,
    // which is the safe failure: nothing disappears.
    return new Set();
  }
};

const write = (keys: Set<string>): void => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...keys]));
  } catch {
    // The choice still holds for this page.
  }
};

export type Archive = {
  archived: ReadonlySet<string>;
  archive: (key: string) => void;
  restore: (key: string) => void;
  restoreAll: () => void;
};

export const useArchive = (): Archive => {
  const [archived, setArchived] = useState<Set<string>>(read);

  const update = useCallback((next: Set<string>) => {
    write(next);
    setArchived(next);
  }, []);

  return {
    archived,
    archive: useCallback((key) => update(new Set(archived).add(key)), [archived, update]),
    restore: useCallback(
      (key) => {
        const next = new Set(archived);
        next.delete(key);
        update(next);
      },
      [archived, update],
    ),
    restoreAll: useCallback(() => update(new Set()), [update]),
  };
};
