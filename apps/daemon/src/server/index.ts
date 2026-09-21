import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { BoardProjector, dedupeKeys, livenessOf, type MiranteEvent } from '@mirante/shared';
import type { MiranteConfig } from '../config.js';
import { EventLog } from '../core/eventlog.js';
import { PermissionBroker, permissionResponse } from '../core/permissions.js';
import { loadAgentDefinitions } from '../ingest/agents.js';
import { hookPayloadSchema, hookToEvents } from '../ingest/hooks.js';
import { statusLinePayloadSchema, statusLineToEvents } from '../ingest/statusline.js';
import { readCachedUsageFile, stateFileSignature } from '../ingest/plan-usage-cache.js';
import { readPlanUsage as readPlanUsageFrom, type PlanReading } from '../ingest/plan-usage.js';
import { usageProbeToEvent } from '../ingest/usage-command.js';
import { projectSlug } from '../ingest/transcript/locate.js';
import { TranscriptWatcher } from '../ingest/transcript/watcher.js';
import { authorize } from './auth.js';

export type DaemonOptions = {
  config: MiranteConfig;
  token: string;
  /** Built web assets. Omitted in tests and when running the UI from Vite. */
  webRoot?: string;
  /** Off in tests, where the watcher would pick up the developer's own sessions. */
  watch?: boolean;
  /**
   * Re-read the cached plan figure on a timer after `listen`. Off unless asked
   * for, like `watch`: a test that listens must never read the developer's own
   * `~/.claude.json`.
   */
  pollPlanUsage?: boolean;
  /**
   * How plan limits are read. Substituted in tests so the suite never spawns a
   * real Claude Code, which would depend on the developer's own subscription.
   */
  readPlanUsage?: () => Promise<PlanReading>;
  logger?: boolean;
};

export type Daemon = {
  app: FastifyInstance;
  log: EventLog;
  projector: BoardProjector;
  broker: PermissionBroker;
  watcher?: TranscriptWatcher;
  ingest: (events: MiranteEvent[]) => void;
  /**
   * Re-reads the cached plan-usage figure and appends it when it is newer than
   * what the board shows. Returns whether it appended. Runs on a timer after
   * `listen`; exposed so tests need not wait for one.
   */
  pollPlanUsageCache: (now?: Date) => boolean;
  /**
   * One tick of the automatic reading: runs `/usage` if, and only if, some
   * agent is working. Runs on the timer after `listen`; exposed for tests.
   */
  refreshPlanUsageAutomatically: (now?: Date) => Promise<'idle' | 'read' | 'busy' | 'stopped'>;
  listen: () => Promise<string>;
  close: () => Promise<void>;
};

export const createDaemon = (options: DaemonOptions): Daemon => {
  const { config, token } = options;
  const app = Fastify({ logger: options.logger ?? false });
  const log = new EventLog(config.databasePath);
  const projector = new BoardProjector();
  const broker = new PermissionBroker();
  const sockets = new Set<{ send: (data: string) => void }>();
  let inFlightProbe: Promise<PlanReading> | undefined;
  const probeCwd = join(config.home, 'probe');
  const readPlanUsage =
    options.readPlanUsage ??
    (() =>
      readPlanUsageFrom({
        statePath: config.claudeStatePath,
        probeCwd,
        probeTranscriptDir: join(config.claudeProjectsDir, projectSlug(probeCwd)),
        preferCommand: true,
      }));

  /**
   * Automatic refresh, cache only. Reading a file Claude Code already keeps
   * costs nothing and occasions no traffic; the /usage command, which does, is
   * reserved for the button. See ADR-0007.
   *
   * Three guards keep it cheap and honest: the file is parsed only when its
   * inode, size or mtime changed; a figure already in the log (same fetch
   * stamp, same dedupe key) is not appended again — across restarts too, since
   * the check is against the log; and nothing here may throw out of a timer.
   */
  let lastSignature: string | undefined;
  let closed = false;
  const pollPlanUsageCache = (now = new Date()): boolean => {
    if (closed) return false;
    try {
      const signature = stateFileSignature(config.claudeStatePath);
      if (signature === undefined || signature === lastSignature) return false;
      const read = readCachedUsageFile(config.claudeStatePath, now);
      if (!read.ok) {
        // Stale, other account, torn write: nothing to add. A torn write gets
        // another look next tick, because the signature is left unrecorded.
        if (read.reason !== 'unreadable') lastSignature = signature;
        return false;
      }
      lastSignature = signature;
      const dedupeKey = dedupeKeys.planUsageCache(read.reading.fetchedAtMs);
      if (log.hasDedupeKey(dedupeKey)) return false;
      append([
        usageProbeToEvent(read.reading.usage, read.reading.fetchedAt, {
          source: 'usage-cache',
          dedupeKey,
        }),
      ]);
      return true;
    } catch {
      // A timer callback that throws takes the daemon down with it. Nothing is
      // logged: an error here can quote the state file, which holds identity.
      return false;
    }
  };
  /**
   * Records a reading once. `/usage` makes Claude Code rewrite its cached figure,
   * so after a command the cache is read — one row, with the write's own key —
   * and the command's parsed prose is kept only when no new figure landed.
   */
  const recordReading = (result: Extract<PlanReading, { ok: true }>): void => {
    if (result.via === 'command' && pollPlanUsageCache()) return;
    const cacheKey =
      result.via === 'cache' && result.fetchedAtMs !== undefined
        ? dedupeKeys.planUsageCache(result.fetchedAtMs)
        : undefined;
    if (cacheKey && log.hasDedupeKey(cacheKey)) return;
    append([
      usageProbeToEvent(result.usage, result.at, {
        source: result.via === 'cache' ? 'usage-cache' : 'usage-command',
        ...(cacheKey ? { dedupeKey: cacheKey } : {}),
      }),
    ]);
  };

  /**
   * The automatic reading. Every minute, and only while some agent is working:
   * plan usage rises only when requests are made, so reading it while nothing
   * runs would spend a process to learn nothing. The person chose this; see
   * ADR-0007.
   *
   * `/usage` costs no tokens — measured, and asserted on every run. If a future
   * Claude Code answers it with the model instead, the first such run stops the
   * automatic reading for good rather than paying for it once a minute.
   */
  let autoStopped = false;
  const refreshPlanUsageAutomatically = async (
    now = new Date(),
  ): Promise<'idle' | 'read' | 'busy' | 'stopped'> => {
    if (closed || autoStopped) return 'stopped';
    try {
      // Free, and catches a figure refreshed by someone opening /usage by hand.
      pollPlanUsageCache(now);
      const at = now.getTime();
      const working = projector
        .snapshot(at)
        .sessions.some(
          (lane) => !lane.endedAt && lane.cards.some((card) => livenessOf(card, at) === 'live'),
        );
      if (!working) return 'idle';
      // Shares the button's slot, so the two never run the command at once.
      if (inFlightProbe) return 'busy';
      inFlightProbe = readPlanUsage().finally(() => {
        inFlightProbe = undefined;
      });
      const result = await inFlightProbe;
      if (!result.ok) {
        if (result.reason === 'not-local') {
          autoStopped = true;
          app.log.warn('/usage was answered by the model; automatic plan reading stopped');
          return 'stopped';
        }
        return 'read';
      }
      if (!closed) recordReading(result);
      return 'read';
    } catch {
      // Nothing thrown here may reach the timer. Nothing is logged either: an
      // error here can quote Claude Code's state file.
      return 'read';
    }
  };

  let pollTimer: NodeJS.Timeout | undefined;

  // Rebuild state from the log so a restart resumes the board rather than
  // starting it empty. This is the replay guarantee, exercised on every boot.
  projector.applyAll(log.since(0));

  const ingest = (events: MiranteEvent[]): void => {
    if (events.length === 0) return;
    for (const event of events) projector.apply(event);
    const message = JSON.stringify({ type: 'events', events });
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {
        // A client that went away is dropped on its own close handler.
      }
    }
  };

  const append = (drafts: ReturnType<typeof hookToEvents>): MiranteEvent[] => {
    const appended = log.appendMany(drafts);
    ingest(appended);
    return appended;
  };

  const guard = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const result = authorize({
      headers: request.headers as Record<string, unknown>,
      query: request.query,
      token,
      port: config.port,
      ...(config.devOrigin ? { devOrigin: config.devOrigin } : {}),
    });
    if (result.ok) return true;
    // Deliberately terse: an error that distinguishes "wrong token" from "no
    // token" helps an attacker more than it helps a user.
    void reply.code(result.status).send({ error: result.reason });
    return false;
  };

  // `service` is what lets a later run tell "a previous Mirante" apart from
  // "something else of yours on this port" — and only the first may be stopped.
  app.get('/health', async () => ({
    ok: true,
    service: 'mirante',
    pid: process.pid,
    events: log.count(),
  }));

  /**
   * Hook ingest.
   *
   * Always answers, always quickly, and never with an error a hook could
   * interpret as a reason to change the session's behavior. A stopped or
   * confused Mirante must not degrade Claude Code.
   */
  app.post('/ingest/hook', async (request, reply) => {
    if (!guard(request, reply)) return;

    const parsed = hookPayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(200).send({});

    const payload = parsed.data;

    if (payload.hook_event_name === 'PermissionRequest') {
      const requestId = randomUUID();
      const decideBy = new Date(Date.now() + config.approvalWindowMs).toISOString();
      append(hookToEvents(payload, { requestId, decideBy }));

      const outcome = await broker.wait(requestId, config.approvalWindowMs);
      append([
        {
          ts: new Date().toISOString(),
          source: 'hook',
          sessionId: payload.session_id,
          projectPath: payload.cwd ?? '',
          agentId: payload.agent_id ?? 'main',
          kind: 'permission.resolved',
          dedupeKey: `permission.resolved:${requestId}`,
          payload: {
            requestId,
            decision: outcome.decided ? outcome.behavior : 'ask',
            via: outcome.decided ? 'ui' : 'fallback',
            ...(outcome.decided && outcome.reason ? { reason: outcome.reason } : {}),
          },
        },
      ]);

      // No decision object means Claude Code's normal permission flow continues
      // and the terminal asks. That is the fallback, and it is the absence of a
      // decision rather than a value.
      return reply.code(200).send(permissionResponse(outcome) ?? {});
    }

    append(hookToEvents(payload));
    return reply.code(200).send({});
  });

  app.post('/ingest/statusline', async (request, reply) => {
    if (!guard(request, reply)) return;
    const parsed = statusLinePayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(200).send({});
    append(statusLineToEvents(parsed.data));
    return reply.code(200).send({});
  });

  app.get('/api/state', async (request, reply) => {
    if (!guard(request, reply)) return;
    return reply.send(projector.snapshot());
  });

  /**
   * Agent definitions, so the board can show an agent by the name and colour its
   * author gave it. Read on request rather than cached: these files change while
   * the daemon runs, and there are only ever a handful of them.
   */
  app.get('/api/agents', async (request, reply) => {
    if (!guard(request, reply)) return;
    const projects = [...new Set(projector.snapshot().sessions.map((s) => s.projectPath))];
    return reply.send({ agents: loadAgentDefinitions(projects) });
  });

  app.get('/api/events', async (request, reply) => {
    if (!guard(request, reply)) return;
    const since = Number((request.query as { since?: string }).since ?? 0);
    return reply.send({ events: log.since(Number.isFinite(since) ? since : 0) });
  });

  app.post<{ Params: { requestId: string } }>(
    '/api/permissions/:requestId',
    async (request, reply) => {
      if (!guard(request, reply)) return;
      const body = request.body as { behavior?: string; reason?: string } | undefined;
      const behavior = body?.behavior;
      if (behavior !== 'allow' && behavior !== 'deny') {
        return reply.code(400).send({ error: 'behavior must be allow or deny' });
      }
      const accepted = broker.decide(request.params.requestId, behavior, body?.reason);
      // Not an error: the window closed and the terminal already has the
      // question. The UI says so rather than pretending the click worked.
      return reply.send({ accepted });
    },
  );

  /**
   * Reads plan limits on demand, by running Claude Code's own `/usage`.
   *
   * On demand and never on a timer: the command is local and free, but it is
   * still Mirante causing Claude Code to act, so it happens when the person asks
   * and at no other moment. The timer reads only the cached figure. See
   * ADR-0006 and ADR-0007.
   */
  app.post('/api/plan-usage/refresh', async (request, reply) => {
    if (!guard(request, reply)) return;

    // One at a time. The button disables itself, but a second browser tab does
    // not know that, and two probes would race to append the same reading.
    inFlightProbe ??= readPlanUsage().finally(() => {
      inFlightProbe = undefined;
    });
    const result = await inFlightProbe;

    if (!result.ok) {
      // Pressed by hand or not, a /usage that cost tokens ends the automatic reading.
      if (result.reason === 'not-local') autoStopped = true;
      return reply.send({ ok: false, reason: result.reason });
    }

    recordReading(result);
    if (result.drift.length > 0) {
      // A window Mirante does not recognize is a reading it is silently
      // dropping. Say so in the log rather than showing a partial total as if it
      // were the whole picture.
      app.log.warn({ drift: result.drift }, 'unrecognized plan window in /usage output');
    }
    return reply.send({ ok: true, via: result.via, drift: result.drift });
  });

  // The websocket plugin has to finish loading before a route can ask for
  // `websocket: true`. Registering both inside one scope makes that ordering
  // explicit — declaring the route beside an unawaited register silently hands
  // the handler an HTTP reply instead of a socket, and every upgrade 500s.
  void app.register(async (instance) => {
    await instance.register(websocket);

    instance.get('/ws', { websocket: true }, (socket, request) => {
      const result = authorize({
        headers: request.headers as Record<string, unknown>,
        query: request.query,
        token,
        port: config.port,
        ...(config.devOrigin ? { devOrigin: config.devOrigin } : {}),
      });
      if (!result.ok) {
        socket.close(1008, result.reason);
        return;
      }

      sockets.add(socket);
      socket.send(JSON.stringify({ type: 'snapshot', state: projector.snapshot() }));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
    });
  });

  if (options.webRoot && existsSync(options.webRoot)) {
    void app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ingest')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const watcher = options.watch
    ? new TranscriptWatcher({
        projectsDir: config.claudeProjectsDir,
        log,
        onEvents: ingest,
        ignoreSlugs: new Set([projectSlug(probeCwd)]),
        onWarning: (message) => app.log.warn({ message }, 'transcript'),
      })
    : undefined;

  return {
    app,
    log,
    projector,
    broker,
    ...(watcher ? { watcher } : {}),
    ingest,
    pollPlanUsageCache,
    refreshPlanUsageAutomatically,
    listen: async () => {
      watcher?.reindexFromLog();
      watcher?.start();
      if (options.pollPlanUsage && config.planUsagePollMs > 0) {
        // At start, only the free read; a process waits until work is seen.
        pollPlanUsageCache();
        pollTimer = setInterval(() => {
          void refreshPlanUsageAutomatically();
        }, config.planUsagePollMs);
        // Never the reason the process stays alive.
        pollTimer.unref();
      }
      return app.listen({ host: config.host, port: config.port });
    },
    close: async () => {
      // Before the log closes: a tick after that would write to a closed database.
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      watcher?.stop();
      broker.releaseAll();
      await app.close();
      log.close();
    },
  };
};
