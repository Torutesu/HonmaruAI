import {fileThreadTools} from './harness/fileThreadTools.js';
import {fileAgentTools} from './harness/fileAgentTools.js';
import { executionAgentTools } from './harness/executionTools.js';
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
import { readerEnvFor } from "./orgAI.js";
import { searchDecisions } from "./insights.js";
import { accessFor } from "./access.js";
import { getUserByGithubId } from "./db.js";
import { connectedSources, searchNotion, searchGithubIssues, formatSourcesForModel } from "./context.js";
import { getMode } from "./harness/mode.js";
import { mayUseAgentSource } from "./harness/agentConnections.js";

export function agentInstructionsForTools(instructions, tools) {
  if (!["list_document_nodes", "create_document", "get_document_status"].every(name => typeof tools?.[name]?.run === "function")) return instructions;
  return `${instructions}\n\nWhen the user requests a PDF or Word document and these tools are available, use list_document_nodes, create_document, and get_document_status to complete the request in this private conversation. This capability complements your specialty. Do not ask the user to grant a capability already included in this turn's tool list, and do not claim a listed tool is unavailable unless it returns an error. Confirm success with get_document_status and include only the returned file link.`;
}

const query = (what) => ({
  type: "object",
  properties: { query: { type: "string", description: what } },
  required: ["query"],
  additionalProperties: false,
});

export async function agentTools(env, { orgId, session, language = "en", personal = false, ownAgentsOnly = false, fileScope = null, fileThreadId = null, agentId = null }) {
  const reader = await readerEnvFor(env, orgId).catch(() => env);
  // Set once one of the person's apps has answered: from then on no page is
  // opened in this answer, so nothing an app said can leave inside a link.
  const taint = { value: false };
  const tools = {
    read_url: {
      description: "Open one web page and read its full text. Use it on the most relevant search results and on primary sources (official sites, filings, papers, the original post) before relying on them — search snippets are not enough. Also reads a YouTube video (title, channel, description and — when it can — the transcript), a TikTok (caption, author) and a post on X (text, author, numbers). Returns the page's text, or says why it could not be read.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The full http(s) URL to open." } },
        required: ["url"],
        additionalProperties: false,
      },
      run: async ({ url }) => {
        if (taint.value) return "Not opened: after reading from the person's connected apps, no web pages are opened in this answer. Answer from what you have.";
        if (!isPublicUrl(url)) return "Could not open: only public http(s) pages can be read.";
        const read = await readLink(String(url), { language, env: reader }).catch(() => null);
        if (!read) return `Could not read ${url}: the site refused or had no readable text. Try another source.`;
        return linksBlock([read]).replace(/^\n<shared_links>\n|\n<\/shared_links>[\s\S]*$/g, "");
      },
    },
  };
  Object.assign(tools, await fileThreadTools(env,{orgId,session,fileScope,fileThreadId,taint}));
  if (!personal) return tools;

  tools.search_team_decisions = {
    description: "Search this team's own past decisions (what was asked, who decided, approved or rejected, when). Use it whenever the request touches something the team may already have decided, before searching the web.",
    parameters: query("Two to four key words, in the language the team writes in."),
    run: async ({ query: q }) => {
      // The person this conversation is with, and what they may open: their
      // own personal cards, the private channels they are in. Nobody else's.
      const me = session ? await getUserByGithubId(env.DB, session.github_id).catch(() => null) : null;
      const access = await accessFor(env.DB, orgId, me?.login || "");
      const found = await searchDecisions(env.DB, orgId, String(q || ""), { viewer: me?.login || null, access }).catch(() => []);
      if (!found.length) return "No past decisions match.";
      return found.slice(0, 10).map((d) => `- ${d.decidedAt ? String(d.decidedAt).slice(0, 10) : "pending"}${d.recipient ? ` ${d.recipient}` : ""} ${d.status || ""}: ${String(d.title || "").slice(0, 160)}`).join("\n");
    },
  };
  Object.assign(tools, await fileAgentTools(env,{orgId,session,personal,ownAgentsOnly,fileScope,taint}));
  Object.assign(tools, await executionAgentTools(env, { orgId, session, personal, ownAgentsOnly }));
  // A missing mode read must never turn on ungranted native sources. Simple
  // retains its old private-DM behavior; Harness requires each caller's grant.
  const workspaceMode = await getMode(env.DB, orgId).catch(() => null);
  const sourceAllowed = async source => {
    const currentMode = await getMode(env.DB, orgId).catch(() => null);
    if (currentMode === "simple") return true;
    return currentMode === "harness" && await mayUseAgentSource(env, { orgId, agentId, session, source });
  };
  const connected = await connectedSources(env, session, orgId).catch(() => ({}));
  if (connected.notion && await sourceAllowed("notion")) {
    tools.search_notion = {
      description: "Search the asker's connected Notion for pages: specs, notes, plans, meeting notes. Use it for anything the team may have written down.",
      parameters: query("Key words to search Notion for."),
      run: async ({ query: q }) => {
        if (!await sourceAllowed("notion")) return "Not searched: this Agent no longer has permission to use your Notion connection.";
        const found = await searchNotion(env, session.github_id, String(q || "")).catch(() => []);
        if (!await sourceAllowed("notion")) return "Not searched: Notion access changed while the request was running; the result was discarded.";
        if (found.length) taint.value = true;
        return formatSourcesForModel(found);
      },
    };
  }
  if (connected.github && await sourceAllowed("github")) {
    tools.search_github = {
      description: "Search the team's GitHub issues and pull requests. Use it for bugs, features, releases and who is working on what.",
      parameters: query("Key words to search issues and pull requests for."),
      run: async ({ query: q }) => {
        if (!await sourceAllowed("github")) return "Not searched: this Agent no longer has permission to use your GitHub connection.";
        const found = await searchGithubIssues(session, orgId, String(q || ""), env).catch(() => []);
        if (!await sourceAllowed("github")) return "Not searched: GitHub access changed while the request was running; the result was discarded.";
        if (found.length) taint.value = true;
        return formatSourcesForModel(found);
      },
    };
  }
  // The apps this person connected through Smithery, theirs alone: only in
  // this, their own conversation with the agent (smitheryApps.js).
  const { appTools } = await import("./smitheryApps.js");
  // A mode lookup failure must not downgrade Harness to Simple: that would
  // expose every connected app to an agent before its per-agent grant check.
  // Known Simple keeps its existing behavior; unknown mode gets no app tools.
  if (workspaceMode === "simple" || workspaceMode === "harness") {
    Object.assign(tools, await appTools(env, {
      orgId, session, taint, writes: ownAgentsOnly, agentId,
      requireAgentGrant: workspaceMode === "harness",
    }).catch(() => ({})));
  }
  return tools;
}
