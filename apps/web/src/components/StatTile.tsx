export type StatTileProps = {
  label: string;
  value: string;
  hint?: string;
};

/** Label in sentence case, value semibold and auto-compacted, no trailing colon. */
export const StatTile = ({ label, value, hint }: StatTileProps) => (
  <div className="min-w-[88px]">
    <div className="text-[11px] text-[var(--text-secondary)]">{label}</div>
    <div className="text-[18px] font-semibold leading-tight text-[var(--text-primary)]">
      {value}
    </div>
    {hint && <div className="text-[10px] text-[var(--text-muted)]">{hint}</div>}
  </div>
);
