/// The function tools an agent may call while it researches. Few, each
/// doing one whole thing, described for the model the way OpenAI's
/// function-calling guide asks: when to use it, what comes back. Strict
/// schemas: every property required, nothing else allowed.
///
/// read_url is everyone's. The team's decisions and the asker's own Notion
/// and GitHub are offered only in a conversation with the agent: there the
/// answer is read by the one person whose they are; in a channel it would
/// be read by everyone in it.

import { readLink, isPublicUrl, linksBlock } from "./links.js";
import { searchDecisions } from "./insights.js";
import { connectedSources, searchNotion, searchGithubIssues, formatSourcesForModel } from "./context.js";

const query = (what) => ({
  type: "object",
  properties: { query: { type: "string", description: what } },
  required: ["query"],
  additionalProperties: false,
});

export async function agentTools(env, { orgId, session, language = "en", personal = false }) {
  const tools = {
    read_url: {
      description: "Open one web page and read its full text. Use it on the most relevant search results and on primary sources (official sites, filings, papers, the original post) before relying on them — search snippets are not enough. Also reads a YouTube video (title, description and transcript), a TikTok (caption, author) and a post on X (text, author, numbers). Returns the page's text, or says why it could not be read.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The full http(s) URL to open." } },
        required: ["url"],
        additionalProperties: false,
      },
      run: async ({ url }) => {
        if (!isPublicUrl(url)) return "Could not open: only public http(s) pages can be read.";
        const read = await readLink(String(url), { language }).catch(() => null);
        if (!read) return `Could not read ${url}: the site refused or had no readable text. Try another source.`;
        return linksBlock([read]).replace(/^\n<shared_links>\n|\n<\/shared_links>[\s\S]*$/g, "");
      },
    },
  };
  if (!personal) return tools;

  tools.search_team_decisions = {
    description: "Search this team's own past decisions (what was asked, who decided, approved or rejected, when). Use it whenever the request touches something the team may already have decided, before searching the web.",
    parameters: query("Two to four key words, in the language the team writes in."),
    run: async ({ query: q }) => {
      const found = await searchDecisions(env.DB, orgId, String(q || "")).catch(() => []);
      if (!found.length) return "No past decisions match.";
      return found.slice(0, 10).map((d) => `- ${d.decidedAt ? String(d.decidedAt).slice(0, 10) : "pending"}${d.recipient ? ` ${d.recipient}` : ""} ${d.status || ""}: ${String(d.title || "").slice(0, 160)}`).join("\n");
    },
  };
  const connected = await connectedSources(env, session, orgId).catch(() => ({}));
  if (connected.notion) {
    tools.search_notion = {
      description: "Search the asker's connected Notion for pages: specs, notes, plans, meeting notes. Use it for anything the team may have written down.",
      parameters: query("Key words to search Notion for."),
      run: async ({ query: q }) => formatSourcesForModel(await searchNotion(env, session.github_id, String(q || "")).catch(() => [])),
    };
  }
  if (connected.github) {
    tools.search_github = {
      description: "Search the team's GitHub issues and pull requests. Use it for bugs, features, releases and who is working on what.",
      parameters: query("Key words to search issues and pull requests for."),
      run: async ({ query: q }) => formatSourcesForModel(await searchGithubIssues(session, orgId, String(q || ""), env).catch(() => [])),
    };
  }
  return tools;
}
