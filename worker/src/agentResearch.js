/// How an agent researches: a tool loop on OpenAI's Responses API, the way
/// OpenAI's own guides describe it — a reasoning model that plans its own
/// searches (agentic search), the hosted web search tool, and function
/// tools of ours it may call as often as it needs within a budget: open a
/// page and read all of it, search the team's decisions, Notion, GitHub.
/// Each round's function results go back with `previous_response_id`, so
/// the model keeps its reasoning between rounds. It stops when it answers,
/// or when the budget is spent — then it is asked to answer from what it
/// has, saying what it could not check.

import { noteUsage } from "./ledger.js";

/// The research model when the workspace's own is not a reasoning one:
/// gpt-4o-mini searches once and summarises the snippets; a reasoning model
/// searches, reads, and searches again.
export const DEFAULT_AGENT_MODEL = "gpt-5-mini";
const MAX_ROUNDS = 8;
const MAX_FUNCTION_CALLS = 16;
const MAX_TOOL_OUTPUT = 12000;
const CALL_TIMEOUT_MS = 150000;

/// A reasoning model: the ones that plan tool calls themselves and take
/// `reasoning.effort`.
export function isReasoningModel(model) {
  return /^(gpt-5|gpt-6|o\d)/i.test(String(model || ""));
}

/// The model an agent researches with. AGENT_MODEL names one outright; a
/// workspace that chose a reasoning model keeps it; otherwise the default.
export function agentModelFor(env, provider) {
  if (env?.AGENT_MODEL) return String(env.AGENT_MODEL);
  return isReasoningModel(provider?.model) ? provider.model : DEFAULT_AGENT_MODEL;
}

/// Whether this provider speaks the Responses API: OpenAI itself.
export function canResearch(provider) {
  return Boolean(provider && provider.providerName === "OpenAI" && /api\.openai\.com\/v1\/chat\/completions$/.test(String(provider.endpoint || "")));
}

const COUNTRY = { ja: "JP", en: "US", es: "ES", fr: "FR", de: "DE", ko: "KR", zh: "CN", pt: "BR", it: "IT" };

/// The loop. `tools` are ours: { name: { description, parameters, run } }.
/// Returns { called, answer, sources, rounds, calls } — `called` is whether
/// any model was paid for; `answer` null when none came back.
/// `plain`: the workspace's own model, the search tool bare, nothing a
/// model might refuse — the retry when the full call is turned down.
export async function research({ provider, env, instructions, input, tools = {}, language = "en", deadline = Date.now() + 240000, effort, plain = false, onRound = null, webSearch = true, maxOutput = null }) {
  const endpoint = provider.endpoint.replace(/\/chat\/completions$/, "/responses");
  const model = plain ? provider.model : agentModelFor(env, provider);
  const reasoning = isReasoningModel(model);
  const country = COUNTRY[String(language || "").slice(0, 2).toLowerCase()];
  const definitions = [
    ...(!webSearch ? [] : [plain ? { type: "web_search" } : {
      type: "web_search",
      search_context_size: "high",
      ...(country ? { user_location: { type: "approximate", country } } : {}),
    }]),
    ...Object.entries(tools).map(([name, t]) => ({
      type: "function", name, description: t.description, parameters: t.parameters, strict: true,
    })),
  ];
  // What it cited in the answer, then the pages it read in full: the
  // sources a reader can check. Pages a search merely listed are not.
  const cited = new Map();
  const read = new Map();
  const note = (map, url, title) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    if (!map.has(url) || (!map.get(url) && title)) map.set(url, String(title || "").slice(0, 120));
  };

  let called = false;
  let calls = 0;
  let rounds = 0;
  let previous = null;
  let next = input;
  let last = null;
  let finalOnly = false;
  while (rounds < MAX_ROUNDS + 1) {
    rounds += 1;
    // Still at it: whoever is watching keeps seeing the agent writing.
    if (rounds > 1 && onRound) await Promise.resolve(onRound(rounds)).catch(() => {});
    const body = {
      model,
      instructions,
      input: next,
      ...(definitions.length ? { tools: definitions } : {}),
      ...(definitions.length ? { tool_choice: finalOnly ? "none" : "auto", parallel_tool_calls: true } : {}),
      max_output_tokens: maxOutput || (reasoning ? 12000 : 3000),
      ...(previous ? { previous_response_id: previous } : {}),
      ...(reasoning ? { reasoning: { effort: effort || env?.AGENT_REASONING || "medium" } } : {}),
      // Verbosity is the GPT-5 family's; an o-series model refuses it.
      ...(/^gpt-(5|6)/i.test(model) ? { text: { verbosity: "medium" } } : {}),
    };
    let data;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(10000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()))),
      });
      if (!res.ok) {
        const reason = await res.text().catch(() => "");
        console.error("agent research call failed", res.status, reason.slice(0, 300));
        // The first call refused (a model this key cannot use, a parameter
        // it does not take): the caller answers the ordinary way.
        if (!previous) return { called, answer: null, refused: true, status: res.status };
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error("agent research call failed", err?.message || err);
      if (!previous) return { called, answer: null, refused: true };
      break;
    }
    called = true;
    noteUsage(provider, "agent", data);
    last = data;
    previous = data.id || null;

    for (const c of readResponse(data).sources) note(cited, c.url, c.title);
    const pending = (Array.isArray(data.output) ? data.output : []).filter((item) => item?.type === "function_call");
    if (!pending.length || finalOnly) break;

    // Our tools, run side by side; past the budget, the model is told so
    // and asked for its answer next round.
    const outputs = await Promise.all(pending.map(async (call) => {
      calls += 1;
      let output;
      if (calls > MAX_FUNCTION_CALLS) output = "Tool budget spent. Answer now from what you have.";
      else {
        const tool = tools[call.name];
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { /* the tool says so below */ }
        try {
          output = tool ? String(await tool.run(args)) : `No tool named ${call.name}.`;
        } catch (err) {
          output = `The tool failed: ${String(err?.message || err).slice(0, 200)}`;
        }
        if (call.name === "read_url" && typeof args.url === "string" && !/^(Could not|No )/.test(output)) {
          note(read, args.url, (output.match(/^Title: (.+)$/m) || [])[1] || "");
        }
      }
      return { type: "function_call_output", call_id: call.call_id, output: output.slice(0, MAX_TOOL_OUTPUT) };
    }));
    next = outputs;
    if (calls >= MAX_FUNCTION_CALLS || rounds >= MAX_ROUNDS || Date.now() > deadline - 30000) finalOnly = true;
  }

  const text = last ? readResponse(last).text : "";
  const sources = [...cited.entries(), ...[...read.entries()].filter(([url]) => !cited.has(url))].map(([url, title]) => ({ url, title }));
  return { called, answer: text.trim() ? text : null, sources, rounds, calls };
}

/// The text of a Responses API reply, and the pages its citations point to.
export function readResponse(data) {
  let text = typeof data?.output_text === "string" ? data.output_text : "";
  const sources = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type !== "output_text") continue;
      if (!data?.output_text) text += part.text || "";
      for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
        if (a?.type === "url_citation" && typeof a.url === "string" && !sources.some((x) => x.url === a.url)) {
          sources.push({ url: a.url, title: String(a.title || "").slice(0, 120) });
        }
      }
    }
  }
  return { text, sources };
}
