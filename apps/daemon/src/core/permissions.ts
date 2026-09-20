/**
 * Holds a permission request open while the board waits for a click.
 *
 * The shape of this is dictated by how PermissionRequest hooks work:
 *
 * - There is no "ask" decision. A hook either returns `allow`/`deny`, or returns
 *   no decision object at all and leaves the permission flow untouched. Omitting
 *   the decision *is* the fallback to the terminal prompt.
 * - A hook that times out has its output discarded, which lands in the same
 *   place. So the daemon can afford to wait, but must answer first if it wants a
 *   say.
 *
 * Nothing here may hold a hook open indefinitely.
 */
export type PermissionBehavior = 'allow' | 'deny';

export type PermissionOutcome =
  | { decided: true; behavior: PermissionBehavior; reason?: string }
  /** Nobody answered in time: fall through to Claude Code's normal permission flow. */
  | { decided: false };

type Waiter = {
  resolve: (outcome: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
};

export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();

  /** Resolves when someone decides, or when the window closes. Never rejects. */
  wait(requestId: string, windowMs: number): Promise<PermissionOutcome> {
    return new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ decided: false });
      }, windowMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  /** Returns false when the window already closed, so the caller can say so in the UI. */
  decide(requestId: string, behavior: PermissionBehavior, reason?: string): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    waiter.resolve({ decided: true, behavior, ...(reason === undefined ? {} : { reason }) });
    return true;
  }

  isPending(requestId: string): boolean {
    return this.waiters.has(requestId);
  }

  get pendingCount(): number {
    return this.waiters.size;
  }

  /** Releases everything to the normal flow. Used when the daemon shuts down. */
  releaseAll(): void {
    for (const [requestId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ decided: false });
      this.waiters.delete(requestId);
    }
  }
}

/**
 * The response body a PermissionRequest hook must return.
 *
 * `undefined` means "no decision": Claude Code proceeds through its normal
 * permission flow and the terminal asks. That is the fallback, and it is spelled
 * as the absence of a decision object rather than as a value.
 */
export const permissionResponse = (
  outcome: PermissionOutcome,
): Record<string, unknown> | undefined => {
  if (!outcome.decided) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: outcome.behavior,
        ...(outcome.behavior === 'deny' && outcome.reason ? { message: outcome.reason } : {}),
      },
    },
  };
};
