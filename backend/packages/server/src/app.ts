import type { CardPriority, OrgEvent } from "@honmaru/protocol";
import type { Hono } from "hono";
import type { Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { createHttpApp, type HttpEnv } from "./http.js";
import {
  createInstruction,
  makeRefineHandler,
  type InstructionDeps,
} from "./instructions.js";
import { githubIssuesIntegration } from "./integrations/github.js";
import { IntegrationRegistry } from "./integrations/registry.js";
import { JobQueue } from "./jobs.js";
import { createLogger, type Logger } from "./log.js";
import {
  NotificationEngine,
  webhookChannel,
  type DeliveryChannel,
} from "./notifications.js";
import { Hub } from "./realtime.js";
import { sweepOverdue } from "./sla.js";

export interface App {
  db: Db;
  log: Logger;
  http: Hono<HttpEnv>;
  hub: Hub;
  queue: JobQueue;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
  // Escalate overdue cards now (also runs on a timer per config).
  runSlaSweep: () => void;
  close: () => void;
}

// Composition root. Every write path (REST or WS) funnels committed events
// through emitEvents, which fans out in latency order:
//   1. WS broadcast to connected clients (instant)
//   2. notification engine (per-user inbox rows + WS frames + channels)
//   3. integrations (external mirrors, slowest, fully async)
// The AI refinement pipeline runs on the job queue and re-enters through
// the same emitEvents, so downstream consumers never care whether an
// event came from the fast path or from enrichment.
export function createApp(config: Config): App {
  const log = createLogger(config.logLevel);
  const db = openDb(config.databasePath);
  const registry = new IntegrationRegistry(db, log, [githubIssuesIntegration]);
  const hub = new Hub(db, config, log);

  const channels: DeliveryChannel[] = [];
  if (config.notifyWebhookUrl) {
    channels.push(webhookChannel(config.notifyWebhookUrl));
  }
  const notifications = new NotificationEngine(db, log, channels, (orgId, userId, notification) =>
    hub.sendNotification(orgId, userId, notification)
  );

  const emitEvents = (orgId: string, events: OrgEvent[]): void => {
    if (events.length === 0) return;
    hub.broadcastEvents(orgId, events);
    notifications.handle(events);
    void registry.dispatch(orgId, events, (refOrgId, refEvents) =>
      hub.broadcastEvents(refOrgId, refEvents)
    );
  };
  hub.onEventsCommitted = emitEvents;

  const instructionDeps: InstructionDeps = {
    db,
    config,
    log,
    emitEvents,
    // queue is created right below; JS closure makes the cycle safe.
    queue: undefined as unknown as JobQueue,
  };
  const queue = new JobQueue(log, {
    refine_card: makeRefineHandler(instructionDeps),
  });
  instructionDeps.queue = queue;

  const instruct = (
    orgId: string,
    senderUserId: string,
    text: string,
    priorityOverride?: CardPriority
  ) => createInstruction(instructionDeps, orgId, senderUserId, text, priorityOverride);
  hub.handleInstruction = instruct;

  const http = createHttpApp({
    db,
    config,
    log,
    registry,
    emitEvents,
    createInstruction: instruct,
  });

  const runSlaSweep = (): void => {
    for (const result of sweepOverdue(db)) {
      emitEvents(result.orgId, result.events);
      notifications.direct(result.notifications);
    }
  };
  const sweepTimer =
    config.slaSweepSeconds > 0
      ? setInterval(runSlaSweep, config.slaSweepSeconds * 1000)
      : null;
  sweepTimer?.unref?.();

  return {
    db,
    log,
    http,
    hub,
    queue,
    emitEvents,
    runSlaSweep,
    close: () => {
      if (sweepTimer) clearInterval(sweepTimer);
      hub.close();
      db.close();
    },
  };
}
