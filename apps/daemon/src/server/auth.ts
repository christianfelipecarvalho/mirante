import { timingSafeEqual } from 'node:crypto';

/**
 * Two independent checks guard the daemon, because they stop different things.
 *
 * The token stops any other local process from reading your prompts. Origin
 * validation stops a web page you happen to have open from doing the same: a
 * browser always attaches Origin to a cross-origin request, and cannot forge it.
 *
 * Neither alone is enough. A token in a page the browser can reach is readable
 * by same-origin script; an Origin check alone is no defence against a local
 * process, which sends whatever header it likes.
 */
export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export const allowedOrigins = (port: number, devOrigin?: string): string[] => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  `http://[::1]:${port}`,
  ...(devOrigin ? [devOrigin] : []),
];

export const extractToken = (
  headers: Record<string, unknown>,
  query: unknown,
): string | undefined => {
  const header = headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  // WebSocket upgrades cannot carry an Authorization header from the browser.
  if (typeof query === 'object' && query !== null) {
    const token = (query as Record<string, unknown>).token;
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return undefined;
};

export const authorize = (args: {
  headers: Record<string, unknown>;
  query: unknown;
  token: string;
  port: number;
  /** Only ever set from MIRANTE_DEV_ORIGIN. See MiranteConfig. */
  devOrigin?: string;
}): AuthResult => {
  const origin = args.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    // Hooks and the status line send no Origin at all; a browser always does on
    // a cross-origin request. So a present-but-wrong Origin is a page trying to
    // reach the daemon, and is refused before the token is even considered.
    if (!allowedOrigins(args.port, args.devOrigin).includes(origin)) {
      return { ok: false, status: 403, reason: 'origin not allowed' };
    }
  }

  const presented = extractToken(args.headers, args.query);
  if (!presented) return { ok: false, status: 401, reason: 'missing token' };
  if (!safeEqual(presented, args.token)) return { ok: false, status: 401, reason: 'invalid token' };

  return { ok: true };
};
