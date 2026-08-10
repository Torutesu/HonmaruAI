// Slack messages addressed to you. `to:me` is the modifier that means
// "addressed to or mentioning me" — it is absent from the tool's own docs and
// was confirmed by calling the live API.

function daysAgo(n) {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
}

export const slack = {
  id: "slack",
  label: "Slack",
  authConfigId: "ac_qv8jozIjt29D",
  toolSlug: "SLACK_SEARCH_MESSAGES",

  buildArgs() {
    return { query: `to:me after:${daysAgo(7)}`, count: 10, sort: "timestamp", sort_dir: "desc" };
  },

  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.messages?.matches;
    const plain = payload?.data?.messages?.matches;
    const matches = wrapped ?? plain ?? [];
    return matches.map((m) => ({
      // permalink encodes channel + timestamp and is stable across searches;
      // iid is a per-search id and would re-ingest the same message forever.
      id: m.permalink || `${m.channel?.id || ""}-${m.ts}`,
      from: m.username || m.user || "",
      subject: m.channel?.name ? `#${m.channel.name}` : "Slack",
      snippet: m.text || "",
      date: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : "",
    }));
  },
};
