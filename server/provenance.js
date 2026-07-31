// Every summarized card carries one-tap links back to its sources: the
// channel conversation it came from, and any documents referenced in the
// original ask (Notion, Google Docs, Figma, GitHub, …).

const KNOWN_DOMAINS = [
  [/notion\.(so|site)/, "Notion"],
  [/docs\.google\./, "Google Docs"],
  [/drive\.google\./, "Google Drive"],
  [/figma\.com/, "Figma"],
  [/slack\.com/, "Slack"],
  [/linear\.app/, "Linear"],
  [/atlassian\.net|jira\./, "Jira"],
];

const MAX_SOURCES = 4;

export function extractLinkSources(...texts) {
  const seen = new Set();
  const sources = [];

  for (const text of texts) {
    for (const match of String(text || "").matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      const url = match[0].replace(/[.,;:!?、。）]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);

      let label = null;
      const github = url.match(/github\.com\/[^/]+\/[^/]+\/(pull|issues|actions)\/?(\d+)?/);
      if (github) {
        label =
          github[1] === "pull" && github[2]
            ? `PR #${github[2]}`
            : github[1] === "issues" && github[2]
              ? `Issue #${github[2]}`
              : "GitHub";
      } else {
        for (const [pattern, name] of KNOWN_DOMAINS) {
          if (pattern.test(url)) {
            label = name;
            break;
          }
        }
      }
      if (!label) {
        try {
          label = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          label = "Link";
        }
      }

      sources.push({ kind: "link", label, url });
    }
  }

  return sources.slice(0, MAX_SOURCES);
}

/**
 * Assemble the card's source list: home-channel conversation first (with
 * the triggering message when known), then referenced documents. The
 * created-GitHub-Issue link is the card's *output* and stays separate;
 * a webhook card's GitHub URL is its *origin* and is included.
 */
export function buildSources({ card, channelStore }) {
  const sources = [];

  if (card.channelID && channelStore?.getChannel) {
    const channel = channelStore.getChannel(card.channelID);
    if (channel) {
      sources.push({
        kind: "channel",
        label: `#${channel.name}`,
        channelID: channel.id,
        ...(card.sourceMessageID ? { messageID: card.sourceMessageID } : {}),
      });
    }
  }

  const seen = new Set();
  if (card.githubIssueURL && !card.githubIssueNumber) {
    const [origin] = extractLinkSources(card.githubIssueURL);
    if (origin) {
      sources.push(origin);
      seen.add(origin.url);
    }
  }

  for (const source of extractLinkSources(card.sourceInstruction, card.summary, card.context)) {
    if (seen.has(source.url) || source.url === card.githubIssueURL) continue;
    seen.add(source.url);
    sources.push(source);
  }

  return sources.length > 0 ? sources.slice(0, MAX_SOURCES) : undefined;
}
