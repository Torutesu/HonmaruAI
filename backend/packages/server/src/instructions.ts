import type { CardPriority, DecisionCard, OrgEvent } from "@honmaru/protocol";
import { applyRefinement, createCardFromRouting } from "./cards.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { JobQueue } from "./jobs.js";
import type { Logger } from "./log.js";
import { listEdges, listMembers, listTeams, requireMember } from "./orgs.js";
import { routeInstruction, routeLocally, type RoutingInput } from "./routing.js";

export interface InstructionDeps {
  db: Db;
  config: Config;
  log: Logger;
  queue: JobQueue;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
}

// Two-phase pipeline, built for rally speed:
//   1. FAST PATH (sync, a few ms): deterministic routing creates the card
//      and it is on the recipient's screen immediately.
//   2. REFINEMENT (async job): the LLM re-routes/rewrites; if it disagrees
//      and nobody has touched the card yet, a card_updated event upgrades
//      it in place (re-route carries previousRecipientUserId so the old
//      recipient's feed drops it).
// The sender is never blocked on model latency.
export function createInstruction(
  deps: InstructionDeps,
  orgId: string,
  senderUserId: string,
  text: string,
  priorityOverride?: CardPriority
): { card: DecisionCard; events: OrgEvent[] } {
  const { db } = deps;
  const sender = requireMember(db, orgId, senderUserId);
  const input: RoutingInput = {
    text,
    sender,
    members: listMembers(db, orgId),
    teams: listTeams(db, orgId),
    edges: listEdges(db, orgId),
    priorityOverride,
  };
  const routing = routeLocally(input);
  const result = createCardFromRouting(db, orgId, senderUserId, text, routing);

  if (deps.config.openRouter) {
    deps.queue.enqueue("refine_card", {
      cardId: result.card.id,
      orgId,
      senderUserId,
      text,
      priorityOverride,
    });
  }
  return result;
}

export interface RefinePayload {
  cardId: string;
  orgId: string;
  senderUserId: string;
  text: string;
  priorityOverride?: CardPriority;
}

export function makeRefineHandler(deps: InstructionDeps) {
  return async (raw: unknown): Promise<void> => {
    const payload = raw as RefinePayload;
    const { db } = deps;
    const sender = requireMember(db, payload.orgId, payload.senderUserId);
    const routing = await routeInstruction(
      {
        text: payload.text,
        sender,
        members: listMembers(db, payload.orgId),
        teams: listTeams(db, payload.orgId),
        edges: listEdges(db, payload.orgId),
        priorityOverride: payload.priorityOverride,
      },
      deps.config.openRouter,
      deps.log
    );
    const refined = applyRefinement(db, payload.cardId, routing);
    if (refined) {
      deps.emitEvents(payload.orgId, refined.events);
    }
  };
}
