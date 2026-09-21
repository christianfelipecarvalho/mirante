/**
 * The icon set's data: names, geometry, and how each mark is drawn.
 *
 * Kept in `lib` so modules that only need to *name* an icon do not have to
 * import a React component to do it.
 */
export type IconName =
  | 'terminal'
  | 'file'
  | 'pencil'
  | 'search'
  | 'globe'
  | 'handoff'
  | 'skill'
  | 'clock'
  | 'dot'
  | 'play'
  | 'check'
  | 'cross'
  | 'alert'
  | 'pause'
  | 'circle'
  | 'thinking'
  | 'down'
  | 'prompt'
  | 'compact'
  | 'unknown'
  | 'session'
  | 'agent'
  | 'back'
  | 'open'
  | 'shield'
  | 'beaker'
  | 'layout'
  | 'server'
  | 'box'
  | 'map'
  | 'guide'
  | 'compass'
  | 'board'
  | 'palette'
  | 'window'
  | 'database'
  | 'magnify'
  | 'package'
  | 'refresh'
  | 'archive'
  | 'sliders'
  | 'branch'
  | 'disclose';

export const ICON_PATHS: Record<IconName, string> = {
  terminal: 'M5 7l4 4-4 4M12 16h7',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  pencil: 'M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  globe:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c4 5 4 13 0 18M12 3c-4 5-4 13 0 18',
  handoff: 'M4 12h13M13 7l5 5-5 5',
  skill: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  dot: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  play: 'M8 5l11 7-11 7z',
  check: 'M5 13l4.5 4.5L19 7',
  cross: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.2v.1',
  pause: 'M9 5v14M15 5v14',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  thinking: 'M12 4a8 8 0 1 0 0 16zM12 4a8 8 0 0 1 0 16',
  down: 'M12 4v13M7 12l5 5 5-5',
  prompt: 'M9 6l6 6-6 6',
  compact: 'M4 9h16M4 15h16M9 5l3-2 3 2M9 19l3 2 3-2',
  unknown: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  // The lookout tower, matching the favicon.
  session:
    'M12 15L9.5 21M18 15l2.5 6M10.5 18.5h7M5 11h14l-2.6 3H7.6zM14.6 6a2 2 0 1 0-4 0 2 2 0 0 0 4 0z',
  agent: 'M12 4l7 4v8l-7 4-7-4V8z',
  back: 'M11 6l-6 6 6 6M5 12h14',
  open: 'M9 5h10v10M19 5L6 18',
  shield: 'M12 3l7 3v6c0 4-3 6.6-7 9-4-2.4-7-5-7-9V6z',
  beaker: 'M9 3v6L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L15 9V3M8 3h8M6.5 14h11',
  layout: 'M4 5h16v14H4zM4 10h16M10 10v9',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8v.1M7.5 16v.1',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  map: 'M9 4L3 7v13l6-3 6 3 6-3V4l-6 3zM9 4v13M15 7v13',
  guide: 'M12 8a3 3 0 1 1 3 3c-1.5.6-3 1.4-3 3M12 18v.1',
  // Role marks, following the vocabulary people already read: a drafting
  // compass is an architect, a kanban board is product work, a palette is
  // design. A generic cube for all three said nothing.
  compass:
    'M12 4.4a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4M11.1 7.6L6.5 20M12.9 7.6L17.5 20M8.6 15.4a7.6 7.6 0 0 0 6.8 0',
  board: 'M4.5 4.5h15v15h-15zM9.5 4.5v15M14.5 4.5v15M6.2 8h1.8M11.2 8h1.8M16.2 8h1.8',
  palette:
    'M12 4.2c-4.3 0-7.8 3.4-7.8 7.6s3.5 7.6 7.8 7.6c.9 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.9.7-1.5 1.6-1.5h1.8c2.6 0 4.6-2 4.6-4.5 0-3.9-3.5-7-8.8-7zM8 10.5v.1M11 8v.1M15 9v.1',
  window: 'M4.5 5.5h15v13h-15zM4.5 9.6h15M7 7.5v.1M9.4 7.5v.1',
  database:
    'M12 4c3.9 0 7 1 7 2.3S15.9 8.6 12 8.6 5 7.6 5 6.3 8.1 4 12 4zM5 6.3v11.4C5 19 8.1 20 12 20s7-1 7-2.3V6.3M5 12c0 1.3 3.1 2.3 7 2.3s7-1 7-2.3',
  magnify:
    'M4 6.5h9M4 10.5h6M4 14.5h5M15.5 13.5a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8M18.2 19.2L21 22',
  // Two arcs chasing each other, heads drawn as right angles. Chosen by swapping
  // candidates into the real button and capturing it at 1x and 2x: every
  // single-arc version read as the letter C beside the label at 1x, and a
  // diagonal head blurs across pixels where an axis-aligned one stays sharp.
  refresh:
    'M4 12a8 8 0 0 1 13.66-5.66L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.66 5.66L4 15.5M4 20v-4.5h4.5',
  // A lidded tray. Putting something away, not throwing it out.
  archive: 'M3.5 6.5h17v3.5h-17zM5.5 10v8.5h13V10M10 13.5h4',
  // Three faders: display preferences, gathered behind one control.
  sliders:
    'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h10M18 17h2M15 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM16 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  // Open or closed. Rotated a quarter turn when closed; distinct from `prompt`,
  // which means typed text.
  disclose: 'M6 9l6 6 6-6',
  // Replaces a borrowed text glyph, which carried the font's weight, not ours.
  branch:
    'M7 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 16.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 7.5v9M17 7.5v1.5a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 3.5',
  package: 'M12 3l8 4.3v9.4L12 21l-8-4.3V7.3zM4 7.3l8 4.3 8-4.3M12 11.6V21',
};

/** Shapes that read as areas rather than outlines. */
export const FILLED_ICONS: ReadonlySet<IconName> = new Set(['play', 'dot', 'skill']);
export const DASHED_ICONS: ReadonlySet<IconName> = new Set(['unknown']);
