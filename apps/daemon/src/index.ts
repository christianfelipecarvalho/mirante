import { loadConfig, loadOrCreateToken, type MiranteConfig } from './config.js';
import { createDaemon, type Daemon, type DaemonOptions } from './server/index.js';

export { loadConfig, loadOrCreateToken, readToken } from './config.js';
export type { MiranteConfig } from './config.js';
export { EventLog } from './core/eventlog.js';
export { PermissionBroker, permissionResponse } from './core/permissions.js';
export { preview, scrubSecrets, summarizeToolInput } from './core/redact.js';
export { loadAgentDefinitions } from './ingest/agents.js';
export type { AgentDefinition } from './ingest/agents.js';
export { hookToEvents, hookPayloadSchema } from './ingest/hooks.js';
export { statusLineToEvents, statusLinePayloadSchema } from './ingest/statusline.js';
export { parseSessionTranscript, normalizeEntrypoint } from './ingest/transcript/parse.js';
export { locateSessions, locateSession } from './ingest/transcript/locate.js';
export { TranscriptWatcher } from './ingest/transcript/watcher.js';
export { createDaemon } from './server/index.js';
export { authorize, allowedOrigins } from './server/auth.js';
export type { Daemon, DaemonOptions } from './server/index.js';

export type StartOptions = {
  config?: Partial<MiranteConfig>;
  webRoot?: string;
  logger?: boolean;
};

/** Boots the daemon and starts watching. Used by the CLI. */
export const start = async (
  options: StartOptions = {},
): Promise<{ daemon: Daemon; url: string; token: string }> => {
  const config = loadConfig(options.config);
  const token = loadOrCreateToken(config);
  const daemonOptions: DaemonOptions = {
    config,
    token,
    watch: true,
    logger: options.logger ?? false,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  };
  const daemon = createDaemon(daemonOptions);
  await daemon.listen();
  return { daemon, url: `http://${config.host}:${config.port}`, token };
};
