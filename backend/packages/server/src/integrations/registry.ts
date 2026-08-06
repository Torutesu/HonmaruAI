import type { IntegrationKind, OrgEvent } from "@honmaru/protocol";
import { setExternalRef } from "../cards.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { Integration } from "./types.js";

export interface StoredIntegrationConfig {
  kind: IntegrationKind;
  enabled: boolean;
  config: Record<string, unknown>;
}

export function listIntegrationConfigs(
  db: Db,
  orgId: string
): StoredIntegrationConfig[] {
  const rows = db
    .prepare("SELECT kind, enabled, config FROM integration_configs WHERE org_id = ?")
    .all(orgId) as { kind: IntegrationKind; enabled: number; config: string }[];
  return rows.map((row) => ({
    kind: row.kind,
    enabled: row.enabled === 1,
    config: JSON.parse(row.config),
  }));
}

export function saveIntegrationConfig(
  db: Db,
  orgId: string,
  kind: IntegrationKind,
  enabled: boolean,
  config: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO integration_configs (org_id, kind, enabled, config)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (org_id, kind) DO UPDATE SET
       enabled = excluded.enabled, config = excluded.config`
  ).run(orgId, kind, enabled ? 1 : 0, JSON.stringify(config));
}

export class IntegrationRegistry {
  private integrations = new Map<IntegrationKind, Integration>();

  constructor(
    private db: Db,
    private log: Logger,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    integrations: Integration<any>[]
  ) {
    for (const integration of integrations) {
      this.integrations.set(integration.kind, integration as Integration);
    }
  }

  get(kind: IntegrationKind): Integration | undefined {
    return this.integrations.get(kind);
  }

  // Fans events out to every enabled integration for the org. Runs after
  // the transaction that produced the events has committed; failures are
  // logged and never break the user-facing write. Ref updates produced
  // here are appended to the event log and handed to `emit` for realtime
  // broadcast (broadcast only — they are not re-dispatched, and the
  // adapters themselves are idempotent against already-synced cards).
  async dispatch(
    orgId: string,
    events: OrgEvent[],
    emit: (orgId: string, events: OrgEvent[]) => void
  ): Promise<void> {
    const configs = listIntegrationConfigs(this.db, orgId).filter(
      (item) => item.enabled
    );
    if (configs.length === 0) return;

    for (const stored of configs) {
      const integration = this.integrations.get(stored.kind);
      if (!integration) continue;
      const parsed = integration.configSchema.safeParse(stored.config);
      if (!parsed.success) {
        this.log.warn(
          { orgId, kind: stored.kind },
          "integration config invalid; skipping"
        );
        continue;
      }
      for (const event of events) {
        try {
          const result = await integration.onEvent(event, parsed.data, this.log);
          if (result) {
            const { events: refEvents } = setExternalRef(
              this.db,
              result.cardId,
              result.ref
            );
            emit(orgId, refEvents);
          }
        } catch (error) {
          this.log.error(
            { err: error, orgId, kind: stored.kind, eventSeq: event.seq },
            "integration dispatch failed"
          );
        }
      }
    }
  }
}
