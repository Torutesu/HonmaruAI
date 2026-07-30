const TRANSLATE_TOOL = [
  {
    type: "function",
    function: {
      name: "translate_card",
      description:
        "Translate decision-card fields into the target language. Keep names, numbers, issue/PR IDs, and technical terms; never add or remove information. Return a field unchanged if it is already in the target language.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          context: { type: "string" },
          routingReason: { type: "string" },
          revisionNote: { type: "string" },
        },
        required: ["title", "summary"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Deliver-time translation: cards are authored in the sender's language and
 * translated into the recipient's language at the moment they land in the
 * store. Passes the card through untouched without an AI key or target.
 */
export async function translateCard({ card, targetLanguage, openRouter }) {
  if (!openRouter?.apiKey || !targetLanguage) {
    return card;
  }

  try {
    const fields = {
      title: card.title,
      summary: card.summary,
      context: card.context || "",
      routingReason: card.routingReason || "",
      ...(card.revisionNote ? { revisionNote: card.revisionNote } : {}),
    };

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
        temperature: 0,
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content: `You translate workplace decision-card fields into this language: ${targetLanguage}. Call translate_card once. Preserve meaning exactly — no additions, no omissions. Keep person names, repository names, issue/PR numbers, and 'label: detail' context structure intact. If a field is already in the target language, return it unchanged.`,
          },
          { role: "user", content: JSON.stringify(fields) },
        ],
        tools: TRANSLATE_TOOL,
        tool_choice: { type: "function", function: { name: "translate_card" } },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message || "OpenRouter request failed.");
    }

    const call = (data?.choices?.[0]?.message?.tool_calls || []).find(
      (item) => item.function?.name === "translate_card"
    );
    if (!call) return card;

    const args =
      typeof call.function.arguments === "object"
        ? call.function.arguments
        : JSON.parse(call.function.arguments || "{}");
    if (!args.title || !args.summary) return card;

    return {
      ...card,
      title: String(args.title).slice(0, 200),
      summary: String(args.summary).slice(0, 600),
      context: args.context ? String(args.context).slice(0, 600) : card.context,
      routingReason: args.routingReason
        ? String(args.routingReason).slice(0, 200)
        : card.routingReason,
      ...(card.revisionNote && args.revisionNote
        ? { revisionNote: String(args.revisionNote).slice(0, 400) }
        : {}),
    };
  } catch (error) {
    console.warn("Card translation failed, delivering original:", error.message);
    return card;
  }
}
