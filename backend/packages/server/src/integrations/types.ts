import type {
  ExternalRef,
  IntegrationKind,
  OrgEvent,
} from "@honmaru/protocol";
import type { z } from "zod";
import type { Logger } from "../log.js";

// An integration mirrors finalized decisions into an external system.
// It reacts to org events and may return an external ref to record on the
// card. Integrations never mutate domain state directly — the registry
// records refs through the cards module so every change stays in the event
// log.
export interface Integration<C = unknown> {
  kind: IntegrationKind;
  configSchema: z.ZodType<C, z.ZodTypeDef, unknown>;
  onEvent(
    event: OrgEvent,
    config: C,
    log: Logger
  ): Promise<{ cardId: string; ref: ExternalRef } | null>;
}
