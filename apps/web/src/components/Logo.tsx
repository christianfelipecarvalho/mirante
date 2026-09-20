/**
 * The Mirante mark: a lookout tower, which is what a mirante is.
 *
 * Inline rather than an <img> so it inherits `currentColor` and follows the
 * theme; the same geometry ships as the favicon.
 */
export const Logo = ({ size = 20, className }: { size?: number; className?: string }) => (
  <svg
    viewBox="0 0 32 32"
    width={size}
    height={size}
    className={className}
    role="img"
    aria-label="Mirante"
    fill="none"
  >
    <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15 L9 27" />
      <path d="M20 15 L23 27" />
      <path d="M10.4 21.5 L21.6 21.5" />
    </g>
    <path d="M6.5 11.5 h19 l-3.6 4 H10.1 Z" fill="currentColor" />
    <circle cx="16" cy="6" r="2.6" fill="currentColor" />
  </svg>
);
