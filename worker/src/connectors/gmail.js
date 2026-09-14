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

  /// The reply, back on the same thread, to the address the mail came from.
  /// Null when the card does not remember enough to reply.
  replyTool(source, text) {
    const address = addressIn(source?.from);
    if (!source?.threadId || !address) return null;
    return {
      slug: "GMAIL_REPLY_TO_THREAD",
      args: { thread_id: source.threadId, recipient_email: address, message_body: text, is_html: false },
    };
  },
};

/// "Mika <mika@cafe.jp>" → "mika@cafe.jp"; a bare address as is; else null.
export function addressIn(from) {
  const text = String(from || "").trim();
  const angled = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angled) return angled[1];
  return /^[^\s@<>]+@[^\s@<>]+$/.test(text) ? text : null;
}
