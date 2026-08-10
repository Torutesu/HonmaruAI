// Mail addressed to you in the last week.
export const gmail = {
  id: "gmail",
  label: "Gmail",
  authConfigId: "ac_XcSzdgFl91Ds",
  toolSlug: "GMAIL_FETCH_EMAILS",

  buildArgs() {
    return { query: "newer_than:7d", max_results: 10, verbose: false, include_payload: false };
  },

  // Composio wraps the payload two different ways depending on the execution
  // path, and an empty inbox is a normal result — both are handled here.
  parse(payload) {
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
  },
};
