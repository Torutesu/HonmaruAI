// Asks one question about an incoming message: does this need a decision from
// the person who received it? Most mail does not, and answering "no" is the
// point — a connector that turns every message into a card is a worse inbox.

const SYSTEM_PROMPT = `You triage a person's incoming mail into decisions.

For the message you are given, decide whether it genuinely requires a decision or
an action FROM THE RECIPIENT. Newsletters, receipts, notifications, automated
reports, marketing, and FYI threads do NOT. Be strict: when in doubt, say no.

Reply with JSON only:
{"needsDecision": false}
or
{"needsDecision": true, "cardType": "approval|task|notification|revision|delegation",
 "title": "3-8 words, action-oriented", "summary": "1-2 sentences, what must be decided or done",
 "context": "2-4 'label: detail' segments joined by ·, using only deadline/scope/metric/amount/action",
 "priority": "low|medium|high|urgent"}

Write title, summary and context in the reader's language, given below.`;

export async function triageMessage(message, { provider, readerLanguage }) {
  const userPrompt = `Reader language: ${readerLanguage || "en"}
From: ${message.from}
Subject: ${message.subject}
Received: ${message.date}
Body preview: ${message.snippet}`;

  let data;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.1, max_tokens: 400,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A model that did not answer in JSON is not a reason to invent a card.
    return null;
  }
  if (!parsed?.needsDecision) return null;
  return {
    cardType: parsed.cardType || "task",
    title: parsed.title || message.subject,
    summary: parsed.summary || "",
    context: parsed.context || "",
    priority: parsed.priority || "medium",
  };
}
