import { useEffect, useRef, useState } from 'react';
import { BoardProjector, emptyBoard, type BoardState, type MiranteEvent } from '@mirante/shared';
import type { AgentDefinition } from './agents';
import { collectEventPages, type EventPage } from './event-pages';

/**
 * The token reaches the page through the URL the CLI prints, then lives in
 * sessionStorage so a reload does not need it again. It is not a credential for
 * anything beyond this daemon, and the daemon also checks Origin — a page from
 * somewhere else cannot use it even if it somehow had it.
 */
export const readToken = (): string => {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    try {
      window.sessionStorage.setItem('mirante.token', fromUrl);
    } catch {
      // Private mode. The in-memory value still works for this page.
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url);
    return fromUrl;
  }
  try {
    return window.sessionStorage.getItem('mirante.token') ?? '';
  } catch {
    return '';
  }
};

export type Connection = 'connecting' | 'live' | 'offline' | 'unauthorized';

export type BoardClient = {
  board: BoardState;
  /**
   * The raw stream, kept alongside the projected board.
   *
   * The board answers "what is happening"; a person opening a session wants
   * "what happened, step by step, for this agent" — which the projection has
   * deliberately collapsed. Keeping both costs a few megabytes and saves a
   * round trip per click.
   */
  events: MiranteEvent[];
  /** Agent definitions from `.claude/agents`, keyed by name. */
  definitions: Map<string, AgentDefinition>;
  connection: Connection;
  decide: (requestId: string, behavior: 'allow' | 'deny') => Promise<boolean>;
  /**
   * Asks the daemon to read plan limits now.
   *
   * The daemon refreshes once a minute while an observed agent is working.
   * This also allows an immediate reading; its age stays visible in between.
   */
  refreshPlanUsage: () => Promise<PlanUsageRefresh>;
};

export type PlanUsageRefresh =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'claude-not-found'
        | 'command-failed'
        | 'unexpected-output'
        | 'no-plan-data'
        | 'not-local'
        | 'unreachable';
    };

const RECONNECT_MS = 1500;

export const useBoard = (): BoardClient => {
  const [board, setBoard] = useState<BoardState>(emptyBoard);
  const [events, setEvents] = useState<MiranteEvent[]>([]);
  const [definitions, setDefinitions] = useState<Map<string, AgentDefinition>>(new Map());
  const [connection, setConnection] = useState<Connection>('connecting');
  const tokenRef = useRef<string>('');
  const projectorRef = useRef(new BoardProjector());

  if (!tokenRef.current) tokenRef.current = readToken();

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let recovery: Promise<void> | undefined;
    // Events that arrive while the backlog is still loading are held, not
    // dropped: folding them out of order would misreport the board.
    let buffered: MiranteEvent[] = [];
    let ready = false;

    const token = tokenRef.current;

    const readEventPage = async (since: number): Promise<EventPage> => {
      const response = await fetch(`/api/events?since=${since}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`event recovery failed: ${response.status}`);
      return (await response.json()) as EventPage;
    };

    const applyEvents = (incoming: MiranteEvent[]) => {
      if (incoming.length === 0) return;
      const projector = projectorRef.current;
      const fresh = incoming.filter((event) => event.id > projector.snapshot().lastEventId);
      if (fresh.length === 0) return;
      for (const event of fresh) projector.apply(event);
      setBoard(projector.snapshot());
      setEvents((previous) => [...previous, ...fresh]);
    };

    /**
     * Closes the small race between the REST backlog and the WebSocket.
     *
     * The socket announces the newest snapshot id when it opens. If something
     * happened after our GET but before that connection, fetch from the exact
     * id already projected while live events wait in `buffered`. Event ids are
     * gapless, so the same path also repairs a gap after a reconnect.
     */
    const recoverGap = (): Promise<void> => {
      if (recovery) return recovery;
      ready = false;
      recovery = (async () => {
        const since = projectorRef.current.snapshot().lastEventId;
        const body = await readEventPage(since);
        applyEvents(await collectEventPages(body, readEventPage));
        ready = true;
        const queued = buffered;
        buffered = [];
        applyEvents(queued.sort((a, b) => a.id - b.id));
      })()
        .catch(() => {
          // Reconnecting starts from a fresh backlog. Do not apply a later
          // event over a missing one and make the graph show an impossible
          // transition.
          socket?.close();
        })
        .finally(() => {
          recovery = undefined;
        });
      return recovery;
    };

    const connect = async () => {
      if (disposed) return;
      try {
        const response = await fetch('/api/events?since=0', {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status === 401 || response.status === 403) {
          setConnection('unauthorized');
          return;
        }
        const body = (await response.json()) as EventPage;
        const backlog = await collectEventPages(body, readEventPage);
        projectorRef.current = new BoardProjector();
        projectorRef.current.applyAll(backlog);
        setBoard(projectorRef.current.snapshot());
        setEvents(backlog);
        ready = true;
        applyEvents(buffered);
        buffered = [];

        // Best effort: an agent without a definition still renders, it just uses
        // Mirante's own glyph and colour.
        try {
          const response = await fetch('/api/agents', {
            headers: { authorization: `Bearer ${token}` },
          });
          if (response.ok) {
            const body = (await response.json()) as { agents: AgentDefinition[] };
            setDefinitions(new Map(body.agents.map((agent) => [agent.name, agent])));
          }
        } catch {
          // No definitions is a normal state, not a failure.
        }
      } catch {
        if (!disposed) {
          setConnection('offline');
          retry = window.setTimeout(connect, RECONNECT_MS);
        }
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`,
      );
      socket.onopen = () => setConnection('live');
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as
          { type: 'events'; events: MiranteEvent[] } | { type: 'snapshot'; state: BoardState };
        if (data.type === 'snapshot') {
          if (data.state.lastEventId > projectorRef.current.snapshot().lastEventId) {
            void recoverGap();
          }
          return;
        }
        if (!ready) {
          buffered = [...buffered, ...data.events];
          return;
        }
        const next = data.events.find(
          (event) => event.id > projectorRef.current.snapshot().lastEventId,
        );
        if (next && next.id > projectorRef.current.snapshot().lastEventId + 1) {
          buffered = [...buffered, ...data.events];
          void recoverGap();
          return;
        }
        applyEvents(data.events);
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection('offline');
        ready = false;
        retry = window.setTimeout(connect, RECONNECT_MS);
      };
      socket.onerror = () => socket?.close();
    };

    void connect();

    return () => {
      disposed = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const decide = async (requestId: string, behavior: 'allow' | 'deny'): Promise<boolean> => {
    const response = await fetch(`/api/permissions/${requestId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenRef.current}` },
      body: JSON.stringify({ behavior }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { accepted: boolean };
    return body.accepted;
  };

  const refreshPlanUsage = async (): Promise<PlanUsageRefresh> => {
    try {
      const response = await fetch('/api/plan-usage/refresh', {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenRef.current}` },
      });
      if (!response.ok) return { ok: false, reason: 'unreachable' };
      return (await response.json()) as PlanUsageRefresh;
    } catch {
      // The daemon stopped while the button was in flight.
      return { ok: false, reason: 'unreachable' };
    }
  };

  return { board, events, definitions, connection, decide, refreshPlanUsage };
};
