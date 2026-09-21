/**
 * What the board looks like before it knows anything.
 *
 * Shaped like the thing it is waiting for, so the layout does not jump when the
 * data lands — and so the wait reads as "loading" rather than "empty", which is
 * a different and much worse answer.
 */
export const BoardSkeleton = () => (
  <div className="space-y-3" aria-hidden="true">
    {[0, 1].map((lane) => (
      <section
        key={lane}
        className="rounded-xl border p-3"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--hairline)' }}
      >
        <div className="mb-3 flex items-center gap-3">
          <div className="skeleton h-3 w-32" />
          <div className="skeleton h-3 w-20" />
          <div className="skeleton ml-auto h-3 w-16" />
        </div>
        <div
          className="rounded-lg border py-3 pl-4 pr-3"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--hairline)' }}
        >
          <div className="flex items-center gap-2.5">
            <div className="skeleton size-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton h-2 w-40" />
            </div>
          </div>
          <div className="skeleton mt-3 h-2.5 w-2/3" />
        </div>
      </section>
    ))}
  </div>
);
