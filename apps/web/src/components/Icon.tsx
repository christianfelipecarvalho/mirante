import { DASHED_ICONS, FILLED_ICONS, ICON_PATHS, type IconName } from '../lib/icon-set';

export type { IconName };

export type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
  /** Decorative by default; give a label when the icon is the only thing said. */
  label?: string;
};

/**
 * Drawn inline as SVG rather than pulled from an icon package or a text font:
 * this tool makes no network requests, and a glyph borrowed from the text font
 * carries that font's colour and weight instead of the one the interface asked
 * for. One 24x24 grid, one stroke width, so nothing looks heavier than its
 * neighbour by accident.
 */
export const Icon = ({ name, size = 14, className, label }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    className={className}
    fill={FILLED_ICONS.has(name) ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={FILLED_ICONS.has(name) ? 0 : 1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeDasharray={DASHED_ICONS.has(name) ? '3 3' : undefined}
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
  >
    <path d={ICON_PATHS[name]} />
  </svg>
);
