import type { IconName } from './icon-set.js';
import type { ProjectActivity } from './projects.js';

/**
 * How a project's state is drawn, wherever it is drawn: the chip rail, the
 * project card, the compact row. Each state gets its own shape as well as its
 * own colour, so it still reads in greyscale and for a colourblind reader, and
 * it always travels with its word (`project.state.*`).
 */
export const PROJECT_MARK: Record<ProjectActivity, { icon: IconName; color: string }> = {
  needs_you: { icon: 'alert', color: 'var(--status-warning)' },
  working: { icon: 'play', color: 'var(--accent)' },
  blocked: { icon: 'pause', color: 'var(--status-serious)' },
  idle: { icon: 'dot', color: 'var(--text-muted)' },
  finished: { icon: 'check', color: 'var(--text-muted)' },
};
