// Asks one question about an incoming message: does this need a decision from
// the person who received it? Most mail does not, and answering "no" is the
// point — a connector that turns every message into a card is a worse inbox.

const SYSTEM_PROMPT = `You triage the messages that reach a person into decisions.

For the message you are given, decide whether it genuinely requires a decision or
an action FROM THE RECIPIENT. Newsletters, receipts, notifications, automated
reports, marketing, chit-chat and FYI threads do NOT. Be strict: when in doubt,
say no.

Reply with JSON only:
{"needsDecision": false}
or
{"needsDecision": true, "cardType": "approval|task|notification|revision|delegation",
 "title": "3-8 words, action-oriented", "summary": "1-2 sentences, what must be decided or done",
 "context": "2-4 'label: detail' segments joined by ·, using only deadline/scope/metric/amount/action",
 "priority": "low|medium|high|urgent"}

Write title, summary and context in the reader's language, given below.`;

// Two different "no card" answers used to hide behind the same null, and they
// cost different amounts: a model that successfully answered "this needs
// nothing" was billed, a call that never landed was not. The meter has to tell
// them apart, so the result is discriminated — `called` is whether we paid,
// `card` is whether anything came of it.
const NOT_CALLED = { called: false, card: null };
const ANSWERED_NO = { called: true, card: null };

export async function triageMessage(message, { provider, readerLanguage, sourceLabel }) {
  const userPrompt = `Reader language: ${readerLanguage || "en"}
Source: ${sourceLabel || "Inbox"}
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
    if (!res.ok) return NOT_CALLED;
    data = await res.json();
  } catch {
    return NOT_CALLED;
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return NOT_CALLED;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // A model that did not answer in JSON is not a reason to invent a card —
    // but it answered, and we were billed for the answer.
    return ANSWERED_NO;
  }
  if (!parsed?.needsDecision) return ANSWERED_NO;
  return {
    called: true,
    card: {
      cardType: parsed.cardType || "task",
      title: parsed.title || message.subject,
      summary: parsed.summary || "",
      context: parsed.context || "",
      priority: parsed.priority || "medium",
    },
  };
}
