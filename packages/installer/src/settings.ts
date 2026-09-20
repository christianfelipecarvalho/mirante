import {
  HOOK_EVENTS,
  type HookEvent,
  type InstallManifest,
  type InstallPlan,
  type Settings,
} from './types.js';

type HookDefinition = Record<string, unknown>;
type HookGroup = { matcher?: string; hooks: HookDefinition[] };

const clone = <T>(value: T): T => structuredClone(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Mirante's own hook entries are recognised by where they point, not by a marker
 * we hope survives an edit. A hook aimed at our daemon is ours; anything else
 * belongs to the user and is never touched.
 */
export const isMiranteHook = (
  hook: unknown,
  plan: Pick<InstallPlan, 'daemonUrl' | 'shimPath'>,
): boolean => {
  if (typeof hook !== 'object' || hook === null) return false;
  const record = hook as Record<string, unknown>;
  if (typeof record.url === 'string' && record.url.startsWith(plan.daemonUrl)) return true;
  if (plan.shimPath && record.command === plan.shimPath) return true;
  return false;
};

/** Permission needs a longer leash than ingest: the daemon holds it while a person decides. */
const timeoutFor = (event: HookEvent, plan: InstallPlan): number =>
  event === 'PermissionRequest' ? plan.permissionTimeoutSeconds : plan.ingestTimeoutSeconds;

export const buildHookDefinition = (event: HookEvent, plan: InstallPlan): HookDefinition => {
  if (plan.transport === 'command') {
    return {
      type: 'command',
      command: plan.shimPath ?? '',
      timeout: timeoutFor(event, plan),
    };
  }
  return {
    type: 'http',
    url: `${plan.daemonUrl}/ingest/hook`,
    headers: { Authorization: `Bearer ${plan.token}` },
    // Explicit and short. The 600-second default is unusable for something that
    // sits in front of every tool call.
    timeout: timeoutFor(event, plan),
  };
};

const withoutMiranteHooks = (
  groups: unknown[],
  plan: Pick<InstallPlan, 'daemonUrl' | 'shimPath'>,
): HookGroup[] => {
  const kept: HookGroup[] = [];
  for (const raw of groups) {
    if (typeof raw !== 'object' || raw === null) continue;
    const group = raw as HookGroup;
    const hooks = asArray(group.hooks).filter((hook) => !isMiranteHook(hook, plan));
    // A group that only ever held our hook goes too, rather than being left as
    // an empty shell in the user's file.
    if (hooks.length === 0) continue;
    kept.push({ ...group, hooks: hooks as HookDefinition[] });
  }
  return kept;
};

export type InstallResult = {
  settings: Settings;
  changes: string[];
  previousStatusLine: Record<string, unknown> | null;
};

/**
 * Produces the settings file Mirante wants, from the one that is there.
 *
 * Pure, so it can be tested against golden files before it is ever pointed at a
 * real machine. Idempotent, so running install twice is the same as running it
 * once. It adds its own hook groups alongside the user's rather than merging
 * into them, so nothing of theirs is rewritten.
 */
export const applyInstall = (
  input: Settings,
  plan: InstallPlan,
  existing?: InstallManifest,
): InstallResult => {
  const settings = clone(input);
  const changes: string[] = [];

  const hooks = (
    typeof settings.hooks === 'object' && settings.hooks !== null ? clone(settings.hooks) : {}
  ) as Record<string, unknown>;

  for (const event of HOOK_EVENTS) {
    const before = asArray(hooks[event]);
    const kept = withoutMiranteHooks(before, plan);
    const group: HookGroup = { hooks: [buildHookDefinition(event, plan)] };
    hooks[event] = [...kept, group];
    changes.push(
      kept.length === before.length
        ? `hooks.${event}: added Mirante hook (kept ${kept.length} existing)`
        : `hooks.${event}: replaced Mirante hook (kept ${kept.length} existing)`,
    );
  }
  settings.hooks = hooks;

  const currentStatusLine =
    typeof settings.statusLine === 'object' && settings.statusLine !== null
      ? (clone(settings.statusLine) as Record<string, unknown>)
      : null;

  const alreadyWrapped = currentStatusLine?.command === plan.statusLineWrapperPath;
  // On a re-install the thing already in place is our own wrapper. Recording it
  // as "previous" would make uninstall restore the wrapper it just removed.
  const previousStatusLine = alreadyWrapped
    ? (existing?.statusLine.previous ?? null)
    : currentStatusLine;

  settings.statusLine = {
    ...(currentStatusLine ?? {}),
    type: 'command',
    command: plan.statusLineWrapperPath,
  };
  changes.push(
    previousStatusLine
      ? 'statusLine: wrapped your existing status line'
      : 'statusLine: installed (none was configured)',
  );

  return { settings, changes, previousStatusLine };
};

export type UninstallResult = { settings: Settings; changes: string[] };

/**
 * Removes exactly what install added, and puts back exactly what it replaced.
 *
 * Anything not recorded in the manifest is left alone, including hooks for the
 * same events that the user added themselves.
 */
export const applyUninstall = (input: Settings, manifest: InstallManifest): UninstallResult => {
  const settings = clone(input);
  const changes: string[] = [];
  const plan = { daemonUrl: manifest.daemonUrl, ...(manifest.transport === 'command' ? {} : {}) };

  if (typeof settings.hooks === 'object' && settings.hooks !== null) {
    const hooks = clone(settings.hooks) as Record<string, unknown>;
    for (const event of Object.keys(hooks)) {
      const before = asArray(hooks[event]);
      const kept = withoutMiranteHooks(before, plan);
      if (kept.length === before.length) continue;
      if (kept.length === 0) {
        delete hooks[event];
        changes.push(`hooks.${event}: removed (nothing else was there)`);
      } else {
        hooks[event] = kept;
        changes.push(`hooks.${event}: removed Mirante hook (kept ${kept.length})`);
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
      changes.push('hooks: removed (empty)');
    } else {
      settings.hooks = hooks;
    }
  }

  const current = settings.statusLine as Record<string, unknown> | undefined;
  const isOurs = current?.command === manifest.statusLine.wrapperPath;
  if (isOurs) {
    if (manifest.statusLine.previous) {
      settings.statusLine = clone(manifest.statusLine.previous);
      changes.push('statusLine: restored your previous status line');
    } else {
      delete settings.statusLine;
      changes.push('statusLine: removed (there was none before)');
    }
  } else if (current) {
    // Someone changed it after install. Theirs wins; we do not overwrite it.
    changes.push('statusLine: left alone (it is no longer the one Mirante wrote)');
  }

  return { settings, changes };
};
