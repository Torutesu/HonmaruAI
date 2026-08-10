// Turns whatever Composio returns into a flat, boring shape the rest of the
// code can rely on. Composio wraps the payload two different ways depending on
// the execution path, and an empty inbox is a normal result — both are handled
// here so nothing downstream has to know.
export function parseMessages(payload) {
  const fromWrapped = payload?.results?.[0]?.response?.data?.messages;
  const fromPlain = payload?.data?.messages ?? payload?.messages;
  const raw = fromWrapped ?? fromPlain ?? [];
  return raw.map((m) => ({
    id: m.messageId || m.id,
    threadId: m.threadId || null,
    from: m.sender || m.from || "",
    subject: m.subject || "",
    snippet: m.preview?.body || m.snippet || "",
    date: m.messageTimestamp || m.internalDate || "",
  }));
}
