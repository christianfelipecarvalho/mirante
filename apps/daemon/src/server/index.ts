import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { BoardProjector, type MiranteEvent } from '@mirante/shared';
import type { MiranteConfig } from '../config.js';
import { EventLog } from '../core/eventlog.js';
import { PermissionBroker, permissionResponse } from '../core/permissions.js';
import { hookPayloadSchema, hookToEvents } from '../ingest/hooks.js';
import { statusLinePayloadSchema, statusLineToEvents } from '../ingest/statusline.js';
import { TranscriptWatcher } from '../ingest/transcript/watcher.js';
import { authorize } from './auth.js';

export type DaemonOptions = {
  config: MiranteConfig;
  token: string;
  /** Built web assets. Omitted in tests and when running the UI from Vite. */
  webRoot?: string;
  /** Off in tests, where the watcher would pick up the developer's own sessions. */
  watch?: boolean;
  logger?: boolean;
};

export type Daemon = {
  app: FastifyInstance;
  log: EventLog;
  projector: BoardProjector;
  broker: PermissionBroker;
  watcher?: TranscriptWatcher;
  ingest: (events: MiranteEvent[]) => void;
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
    });
    if (result.ok) return true;
    // Deliberately terse: an error that distinguishes "wrong token" from "no
    // token" helps an attacker more than it helps a user.
    void reply.code(result.status).send({ error: result.reason });
    return false;
  };

  void app.register(websocket);

  app.get('/health', async () => ({ ok: true, events: log.count() }));

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

  app.get('/ws', { websocket: true }, (socket, request) => {
    const result = authorize({
      headers: request.headers as Record<string, unknown>,
      query: request.query,
      token,
      port: config.port,
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
    listen: async () => {
      watcher?.reindexFromLog();
      watcher?.start();
      return app.listen({ host: config.host, port: config.port });
    },
    close: async () => {
      watcher?.stop();
      broker.releaseAll();
      await app.close();
      log.close();
    },
  };
};
