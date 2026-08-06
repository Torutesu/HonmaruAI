import type { DecisionCard, ExternalRef, OrgEvent } from "@honmaru/protocol";
import { z } from "zod";
import type { Logger } from "../log.js";
import type { Integration } from "./types.js";

export const GitHubIssuesConfig = z.object({
  // "owner/name"
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  // PAT or OAuth token with repo scope; stored server-side only.
  token: z.string().min(1),
  extraLabels: z.array(z.string()).default([]),
});
export type GitHubIssuesConfig = z.infer<typeof GitHubIssuesConfig>;

const API = "https://api.github.com";

async function github(
  config: GitHubIssuesConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed (${response.status}): ${data.message ?? "unknown"}`
    );
  }
  return data;
}

function issueBody(card: DecisionCard): string {
  const lines = [
    card.summary,
    "",
    `**Context**: ${card.context}`,
    `**Priority**: ${card.priority}`,
    `**Route**: ${card.agentRoute ?? "-"}`,
  ];
  if (card.sourceInstruction) {
    lines.push(`**Original instruction**: ${card.sourceInstruction}`);
  }
  if (card.revisionNote) {
    lines.push(`**Note**: ${card.revisionNote}`);
  }
  lines.push("", "_Synced from HonmaruAI decision feed._");
  return lines.join("\n");
}

function existingRef(card: DecisionCard): ExternalRef | undefined {
  return card.externalRefs.find((ref) => ref.integration === "github_issues");
}

// Sync policy: a decision materializes as an issue once it is approved;
// completion closes the issue; rejection of an already-synced card closes
// it as not planned. Pending cards never leave the app.
export const githubIssuesIntegration: Integration<GitHubIssuesConfig> = {
  kind: "github_issues",
  configSchema: GitHubIssuesConfig,

  async onEvent(event: OrgEvent, config, log: Logger) {
    if (event.type !== "card_updated") return null;
    const card = event.payload.card;
    const ref = existingRef(card);

    if (card.status === "approved" && !ref) {
      const issue = await github(config, "POST", `/repos/${config.repo}/issues`, {
        title: card.title,
        body: issueBody(card),
        labels: [...card.labels, ...config.extraLabels],
      });
      log.info({ cardId: card.id, issue: issue.number }, "github issue created");
      return {
        cardId: card.id,
        ref: {
          integration: "github_issues",
          externalId: String(issue.number),
          url: String(issue.html_url ?? ""),
          state: "open",
        },
      };
    }

    if (ref && (card.status === "completed" || card.status === "rejected")) {
      if (ref.state === "closed") return null;
      await github(
        config,
        "PATCH",
        `/repos/${config.repo}/issues/${ref.externalId}`,
        {
          state: "closed",
          state_reason: card.status === "completed" ? "completed" : "not_planned",
        }
      );
      return {
        cardId: card.id,
        ref: { ...ref, state: "closed" },
      };
    }

    return null;
  },
};
