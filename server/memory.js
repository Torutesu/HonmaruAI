const MAX_ENTRIES_PER_USER = 50;
const MIN_HISTORY = 3;

/**
 * Per-user decision memory: what kinds of requests, from whom, they
 * approved / rejected / sent back. Feeds the recommendation on new cards.
 */
export function createMemoryStore(initial) {
  const entries =
    initial?.entries && typeof initial.entries === "object" ? initial.entries : {};

  return {
    serialize() {
      return { entries };
    },

    record(userID, entry) {
      if (!userID || !entry?.action) return false;
      const list = entries[userID] || [];
      list.push(entry);
      if (list.length > MAX_ENTRIES_PER_USER) {
        list.splice(0, list.length - MAX_ENTRIES_PER_USER);
      }
      entries[userID] = list;
      return true;
    },

    entriesFor(userID) {
      return entries[userID] || [];
    },
  };
}

/** Map a card status transition to a memory action, or null. */
export function recordableTransition(before, after) {
  if (before !== "pending") return null;
  if (after === "approved") return "approve";
  if (after === "rejected") return "reject";
  if (after === "revised") return "revise";
  return null;
}

/**
 * Offline recommendation: a strong pattern in similar past decisions
 * (same sender or same card type), never below 3 data points.
 */
export function heuristicRecommendation({ card, history }) {
  const relevant = (history || []).filter(
    (entry) => entry.senderUserID === card.senderUserID || entry.type === card.type
  );
  if (relevant.length < MIN_HISTORY) return null;

  const counts = { approve: 0, reject: 0, revise: 0 };
  for (const entry of relevant) {
    counts[entry.action] = (counts[entry.action] || 0) + 1;
  }

  for (const action of ["approve", "reject"]) {
    if (counts[action] / relevant.length >= 0.75) {
      return {
        action,
        reason: `You ${action === "approve" ? "approved" : "declined"} ${counts[action]} of your last ${relevant.length} similar decisions`,
      };
    }
  }
  return null;
}

const RECOMMEND_TOOL = [
  {
    type: "function",
    function: {
      name: "recommend_decision",
      description:
        "Predict how this person will likely decide the new card, based on their past decisions. Recommend only on a clear pattern; otherwise answer none.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["approve", "reject", "revise", "none"] },
          reason: {
            type: "string",
            description:
              "One short sentence grounded in their history, e.g. 'You approved the last 3 review requests from Alice'. Empty when action is none.",
          },
        },
        required: ["action", "reason"],
        additionalProperties: false,
      },
    },
  },
];

function historyTranscript(history) {
  return history
    .slice(-15)
    .map(
      (entry) =>
        `- ${entry.action} · ${entry.type} · from ${entry.senderUserID} · "${entry.title}"`
    )
    .join("\n");
}

/**
 * Recommendation for a freshly delivered card, in the recipient's language.
 * Falls back to the pattern heuristic without an AI key.
 */
export async function recommendDecision({ card, history, language, openRouter }) {
  if ((history || []).length < MIN_HISTORY) return null;

  if (!openRouter?.apiKey) {
    return heuristicRecommendation({ card, history });
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
        temperature: 0.1,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You are this person's decision memory. Call recommend_decision once. Recommend only when their history shows a clear pattern for this kind of request — when unsure, action is none. The recommendation is advisory; the human always decides." +
              (language ? ` Write the reason in this language: ${language}.` : ""),
          },
          {
            role: "user",
            content: `Their recent decisions:\n${historyTranscript(history)}\n\nNew card:\n- type: ${card.type}\n- from: ${card.senderUserID}\n- title: ${card.title}\n- summary: ${card.summary}`,
          },
        ],
        tools: RECOMMEND_TOOL,
        tool_choice: { type: "function", function: { name: "recommend_decision" } },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed.");
    }

    const call = (data?.choices?.[0]?.message?.tool_calls || []).find(
      (item) => item.function?.name === "recommend_decision"
    );
    if (!call) return heuristicRecommendation({ card, history });

    const args =
      typeof call.function.arguments === "object"
        ? call.function.arguments
        : JSON.parse(call.function.arguments || "{}");

    if (!["approve", "reject", "revise"].includes(args.action)) return null;
    const reason = String(args.reason || "").trim();
    if (!reason) return null;
    return { action: args.action, reason: reason.slice(0, 200) };
  } catch (error) {
    console.warn("Recommendation failed, using heuristic:", error.message);
    return heuristicRecommendation({ card, history });
  }
}
