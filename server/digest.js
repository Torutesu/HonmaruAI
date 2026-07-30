import { randomUUID } from "node:crypto";

const MAX_MESSAGES_PER_CHANNEL = 30;

/**
 * Collect channel activity the user hasn't produced themselves since `since`.
 * @returns {{ channel: object, messages: object[] }[]}
 */
export function collectDigestSections({ channelStore, userID, since }) {
  const { channels } = channelStore.snapshot();
  const sections = [];

  for (const channel of Object.values(channels)) {
    const messages = channelStore
      .recentMessages(channel.id, 200)
      .filter((message) => {
        if (message.authorID === userID) return false;
        const createdAt = Date.parse(message.createdAt);
        return Number.isFinite(createdAt) && createdAt > since;
      })
      .slice(-MAX_MESSAGES_PER_CHANNEL);

    if (messages.length > 0) {
      sections.push({ channel, messages });
    }
  }

  return sections;
}

export function fallbackDigest(sections) {
  const totalMessages = sections.reduce(
    (sum, section) => sum + section.messages.length,
    0
  );
  const summary = `${totalMessages} update${totalMessages === 1 ? "" : "s"} across ${sections.length} channel${sections.length === 1 ? "" : "s"} while you were away.`;

  const context = sections
    .map((section) => {
      const last = section.messages[section.messages.length - 1];
      const preview = `${last.authorName}: ${last.text}`.slice(0, 60);
      return `#${section.channel.name}: ${section.messages.length} new · ${preview}`;
    })
    .join(" · ");

  return { summary, context };
}

const DIGEST_TOOL = [
  {
    type: "function",
    function: {
      name: "write_digest",
      description:
        "Summarize unseen channel activity for a teammate as a compact digest.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "2-3 sentences: what actually happened, decisions filed, anything that needs their attention. Concrete, no filler.",
          },
          context: {
            type: "string",
            description:
              "Per-channel facts as '#channel: detail' segments joined by ·",
          },
        },
        required: ["summary", "context"],
        additionalProperties: false,
      },
    },
  },
];

function transcriptFor(sections) {
  return sections
    .map((section) => {
      const lines = section.messages
        .map(
          (message) =>
            `${message.authorName}${message.authorKind === "agent" ? " (AI)" : ""}: ${message.text}`
        )
        .join("\n");
      return `#${section.channel.name}:\n${lines}`;
    })
    .join("\n\n");
}

export async function generateDigest({ sections, userName, openRouter }) {
  if (!openRouter?.apiKey) {
    return fallbackDigest(sections);
  }

  try {
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
              "You write channel digests for a teammate who hasn't been reading chat. Call write_digest once. Lead with what matters to them; skip pleasantries.",
          },
          {
            role: "user",
            content: `Digest for ${userName}. Unseen activity:\n\n${transcriptFor(sections)}`,
          },
        ],
        tools: DIGEST_TOOL,
        tool_choice: { type: "function", function: { name: "write_digest" } },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed.");
    }

    const call = (data?.choices?.[0]?.message?.tool_calls || []).find(
      (item) => item.function?.name === "write_digest"
    );
    if (!call) {
      return fallbackDigest(sections);
    }

    const args =
      typeof call.function.arguments === "object"
        ? call.function.arguments
        : JSON.parse(call.function.arguments || "{}");
    if (!args.summary) {
      return fallbackDigest(sections);
    }

    return {
      summary: String(args.summary).slice(0, 500),
      context: String(args.context || "").slice(0, 500) || fallbackDigest(sections).context,
    };
  } catch (error) {
    console.warn("Digest generation failed, using fallback:", error.message);
    return fallbackDigest(sections);
  }
}

export function buildDigestCard({ user, digest, sectionCount }) {
  return {
    id: `card-${randomUUID()}`,
    recipientUserID: user.id,
    senderUserID: user.id,
    type: "notification",
    title: "Team digest",
    summary: digest.summary,
    context: digest.context,
    status: "pending",
    priority: "low",
    createdAt: new Date().toISOString(),
    agentRoute: `${user.name}'s AI · channel digest`,
    routingReason: `Unseen activity in ${sectionCount} channel${sectionCount === 1 ? "" : "s"} — read here, skip the scrollback`,
  };
}
