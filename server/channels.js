import { randomUUID } from "node:crypto";
import { userNameFor } from "./agentTools.js";

const MAX_MESSAGES_PER_CHANNEL = 500;

/**
 * Channel store: the AI-native chat layer behind the decision feed.
 * Shape: { channels: { id -> channel }, messages: { channelID -> message[] } }
 */
export function createChannelStore(initial) {
  const channels = initial?.channels && typeof initial.channels === "object" ? initial.channels : {};
  const messages = initial?.messages && typeof initial.messages === "object" ? initial.messages : {};

  if (Object.keys(channels).length === 0) {
    const general = {
      id: "channel-general",
      name: "general",
      purpose: "Team-wide updates. Mention @ai to bring the team AI in.",
      createdAt: new Date().toISOString(),
    };
    channels[general.id] = general;
    messages[general.id] = [];
  }

  return {
    snapshot() {
      return { channels, messagesByChannel: messages };
    },

    serialize() {
      return { channels, messages };
    },

    getChannel(channelID) {
      return channels[channelID] || null;
    },

    createChannel({ name, purpose }) {
      const cleaned = String(name || "")
        .toLowerCase()
        .trim()
        .replace(/^#+\s*/, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9_-]/g, "")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      if (!cleaned) return null;

      const existing = Object.values(channels).find((channel) => channel.name === cleaned);
      if (existing) return existing;

      const channel = {
        id: `channel-${randomUUID()}`,
        name: cleaned,
        purpose: String(purpose || "").slice(0, 140),
        createdAt: new Date().toISOString(),
      };
      channels[channel.id] = channel;
      messages[channel.id] = [];
      return channel;
    },

    addMessage({ channelID, authorID, authorKind, authorName, text, toolCalls, cardID }) {
      if (!channels[channelID]) return null;
      const cleaned = String(text || "").trim().slice(0, 4000);
      if (!cleaned) return null;

      const message = {
        id: `msg-${randomUUID()}`,
        channelID,
        authorID,
        authorKind: authorKind === "agent" ? "agent" : "user",
        authorName: authorName || userNameFor(authorID),
        text: cleaned,
        createdAt: new Date().toISOString(),
        ...(toolCalls?.length ? { toolCalls } : {}),
        ...(cardID ? { cardID } : {}),
      };

      const list = messages[channelID] || [];
      list.push(message);
      if (list.length > MAX_MESSAGES_PER_CHANNEL) {
        list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
      }
      messages[channelID] = list;
      return message;
    },

    recentMessages(channelID, limit = 20) {
      const list = messages[channelID] || [];
      return list.slice(-limit);
    },
  };
}

/**
 * Parse an agent mention. `@ai` addresses the team AI; `@ai-alice` (or
 * `@ai.alice`) addresses Alice's personal agent.
 * @returns {{ ownerID: string | null, agentName: string } | null}
 */
export function parseAgentMention(text) {
  const match = String(text || "").match(/@ai\b(?:[-.]([a-z]+))?/i);
  if (!match) return null;

  const suffix = (match[1] || "").toLowerCase();
  if (suffix) {
    const ownerID = `user-${suffix}`;
    const ownerName = userNameFor(ownerID);
    if (ownerName !== ownerID) {
      return { ownerID, agentName: `${ownerName}'s AI` };
    }
  }
  return { ownerID: null, agentName: "Team AI" };
}

export function stripMention(text) {
  return String(text || "").replace(/@ai\b(?:[-.][a-z]+)?/gi, "").replace(/\s+/g, " ").trim();
}

const AGENT_CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "file_decision",
      description:
        "File a decision card when the conversation surfaces something a specific teammate must decide, approve, or act on. The instruction is routed to the right person automatically.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "A self-contained instruction describing what needs to be decided or done, including deadlines and context from the conversation",
          },
        },
        required: ["instruction"],
        additionalProperties: false,
      },
    },
  },
];

function agentSystemPrompt({ agentName, channelName }) {
  return `You are ${agentName}, an AI teammate inside the workplace chat channel #${channelName}. Humans and agents share this space.

Rules:
- Reply in 1-3 short sentences, concrete and helpful. No filler, no corporate tone.
- You know the team: Alice (Product Manager), Bob (Engineer), Carol (Designer), Dana (Engineering Lead).
- If the conversation surfaces something a teammate must decide, approve, or act on, call file_decision with a self-contained instruction — the platform routes it as a decision card. Mention in your reply that you filed it.
- Only file a decision when there is a clear ask; questions and banter just get a reply.`;
}

function formatTranscript(recentMessages) {
  return recentMessages
    .map((message) => `${message.authorName}${message.authorKind === "agent" ? " (AI)" : ""}: ${message.text}`)
    .join("\n");
}

function fallbackAgentReply({ text }) {
  const stripped = stripMention(text);
  const fileMatch = stripped.match(/^(?:file|card|task)\s*:\s*(.+)$/i);
  if (fileMatch) {
    return {
      text: "Filing that as a decision card.",
      instruction: fileMatch[1].trim(),
    };
  }

  return {
    text:
      "I'm in offline mode (no AI key on the relay). Say `@ai file: <instruction>` and I'll route it as a decision card.",
    instruction: null,
  };
}

/**
 * Generate an agent reply for a channel message that mentioned an agent.
 * Returns { text, instruction } — instruction, when present, should be routed
 * through the normal decision-card pipeline by the caller.
 */
export async function generateAgentReply({
  agentName,
  channelName,
  recentMessages,
  message,
  openRouter,
}) {
  if (!openRouter?.apiKey) {
    return fallbackAgentReply({ text: message.text });
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
        temperature: 0.4,
        max_tokens: 400,
        messages: [
          { role: "system", content: agentSystemPrompt({ agentName, channelName }) },
          {
            role: "user",
            content: `Recent conversation in #${channelName}:\n${formatTranscript(recentMessages)}\n\nLatest message (mentions you): ${message.authorName}: ${message.text}\n\nRespond as ${agentName}.`,
          },
        ],
        tools: AGENT_CHAT_TOOLS,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed.");
    }

    const choice = data?.choices?.[0]?.message;
    let instruction = null;
    const fileCall = (choice?.tool_calls || []).find(
      (call) => call.function?.name === "file_decision"
    );
    if (fileCall) {
      try {
        const args =
          typeof fileCall.function.arguments === "object"
            ? fileCall.function.arguments
            : JSON.parse(fileCall.function.arguments || "{}");
        if (args.instruction) instruction = String(args.instruction);
      } catch {
        instruction = null;
      }
    }

    let text = String(choice?.content || "").trim();
    if (!text) {
      text = instruction ? "Filed that as a decision card." : "Noted.";
    }

    return { text: text.slice(0, 1000), instruction };
  } catch (error) {
    console.warn("Agent reply failed, using fallback:", error.message);
    return fallbackAgentReply({ text: message.text });
  }
}
