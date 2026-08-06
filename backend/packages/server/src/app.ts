import type { OrgEvent } from "@honmaru/protocol";
import type { Hono } from "hono";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { createHttpApp, type HttpEnv } from "./http.js";
import { githubIssuesIntegration } from "./integrations/github.js";
import { IntegrationRegistry } from "./integrations/registry.js";
import { createLogger, type Logger } from "./log.js";
import { Hub } from "./realtime.js";

export interface App {
  db: Db;
  log: Logger;
  http: Hono<HttpEnv>;
  hub: Hub;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
  close: () => void;
}

// Composition root. Every write path (REST or WS) funnels committed events
// through emitEvents: broadcast to connected clients first, then dispatch
// to integrations (whose ref updates are broadcast but not re-dispatched).
export function createApp(config: Config): App {
  const log = createLogger(config.logLevel);
  const db = openDb(config.databasePath);
  const registry = new IntegrationRegistry(db, log, [githubIssuesIntegration]);
  const hub = new Hub(db, config, log);

  const emitEvents = (orgId: string, events: OrgEvent[]): void => {
    if (events.length === 0) return;
    hub.broadcastEvents(orgId, events);
    void registry.dispatch(orgId, events, (refOrgId, refEvents) =>
      hub.broadcastEvents(refOrgId, refEvents)
    );
  };
  hub.onEventsCommitted = emitEvents;

  const http = createHttpApp({ db, config, log, registry, emitEvents });

  return {
    db,
    log,
    http,
    hub,
    emitEvents,
    close: () => {
      hub.close();
      db.close();
    },
  };
}
