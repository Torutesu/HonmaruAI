import type { OrgEvent } from "@honmaru/protocol";
import { createCardFromRouting } from "./cards.js";
import { getChannel, listChatMessages } from "./chat.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { getMember, listMembers } from "./orgs.js";
import { RoutingResult } from "./routing.js";

// ---------------------------------------------------------------------------
// Chat → decision bridge, level 2: "summarize this channel". An async job
// reads the recent conversation and delivers a digest card (decisions,
// action items, open questions) to the requester's feed. LLM first,
// deterministic fallback so the feature works offline too.
// ---------------------------------------------------------------------------

export interface SummarizePayload {
  orgId: string;
  channelId: string;
  requesterUserId: string;
}

const MAX_MESSAGES = 50;

export function makeSummarizeHandler(deps: {
  db: Db;
  config: Config;
  log: Logger;
  emitEvents: (orgId: string, events: OrgEvent[]) => void;
}) {
  return async (raw: unknown): Promise<void> => {
    const payload = raw as SummarizePayload;
    const { db, config, log } = deps;
    const channel = getChannel(db, payload.channelId);
    const requester = getMember(db, payload.orgId, payload.requesterUserId);
    if (!channel || !requester) return;

    const members = listMembers(db, payload.orgId);
    const nameOf = (id: string) =>
      members.find((member) => member.userId === id)?.name ?? "Someone";
    const messages = listChatMessages(db, payload.channelId, MAX_MESSAGES);
    if (messages.length === 0) return;

    const channelLabel =
      channel.kind === "channel" ? `#${channel.name}` : "this DM";
    const transcript = messages
      .map((m) => `${nameOf(m.authorUserId)}: ${m.text}`)
      .join("\n");

    let digest: { title: string; summary: string; context: string } | null = null;
    if (config.openRouter) {
      try {
        digest = await llmDigest(config, channelLabel, transcript);
      } catch (error) {
        log.warn({ err: error }, "summarize LLM failed; using fallback");
      }
    }
    if (!digest) {
      const authors = [...new Set(messages.map((m) => nameOf(m.authorUserId)))];
      const lastLines = messages
        .slice(-3)
        .map((m) => `${nameOf(m.authorUserId)}: ${m.text}`)
        .join(" · ");
      digest = {
        title: `Digest of ${channelLabel}`,
        summary: `${messages.length} messages from ${authors.join(", ")}. Latest: ${lastLines}`.slice(0, 400),
        context: `channel: ${channelLabel} · messages: ${messages.length} · participants: ${authors.length}`,
      };
    }

    const routing = RoutingResult.parse({
      recipientUserId: payload.requesterUserId,
      cardType: "notification",
      title: digest.title.slice(0, 120),
      summary: digest.summary,
      context: digest.context,
      priority: "low",
      routingReason: `You asked for a digest of ${channelLabel}`,
      labels: ["digest"],
      agentRoute: `${channelLabel} → ${requester.name.split(" ")[0]}'s AI`,
    });
    const { events } = createCardFromRouting(
      db,
      payload.orgId,
      payload.requesterUserId,
      `Summarize ${channelLabel}`,
      routing
    );
    deps.emitEvents(payload.orgId, events);
  };
}

async function llmDigest(
  config: Config,
  channelLabel: string,
  transcript: string
): Promise<{ title: string; summary: string; context: string }> {
  const openRouter = config.openRouter!;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openRouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": openRouter.appUrl,
      "X-Title": openRouter.appName,
    },
    body: JSON.stringify({
      model: openRouter.model,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            'You digest a workplace chat into a decision-feed card. Reply with strict JSON: {"title": "3-8 words", "summary": "2-3 sentences: decisions made, action items with owners, open questions", "context": "2-4 \'label: detail\' segments joined by ·"}. No markdown, no extra keys.',
        },
        {
          role: "user",
          content: `Channel: ${channelLabel}\n\n${transcript}`,
        },
      ],
    }),
  });
  const data = (await response.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  };
  if (!response.ok) {
    throw new Error(data.error?.message ?? "summarize request failed");
  }
  const content = data.choices?.[0]?.message?.content ?? "";
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const parsed = JSON.parse((fenced ? fenced[1] : content).trim()) as {
    title?: string;
    summary?: string;
    context?: string;
  };
  if (!parsed.title || !parsed.summary) {
    throw new Error("summarize response incomplete");
  }
  return {
    title: parsed.title,
    summary: parsed.summary,
    context: parsed.context || `channel: ${channelLabel}`,
  };
}
