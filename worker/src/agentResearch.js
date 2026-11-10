import {isControlTool, handoffOperation} from './agentToolControl.js';
/// How an agent researches: a tool loop on OpenAI's Responses API, the way
/// OpenAI's own guides describe it — a reasoning model that plans its own
/// searches (agentic search), the hosted web search tool, and function
/// tools of ours it may call as often as it needs within a budget: open a
/// page and read all of it, search the team's decisions, Notion, GitHub.
/// Each round's function results go back with `previous_response_id`, so
/// the model keeps its reasoning between rounds. It stops when it answers,
/// or when the budget is spent — then it is asked to answer from what it
/// has, saying what it could not check.

import { noteUsage, noteSearches } from "./ledger.js";

/// The research model when the workspace's own is not a reasoning one:
/// gpt-4o-mini searches once and summarises the snippets; a reasoning model
/// searches, reads, and searches again.
export const DEFAULT_AGENT_MODEL = "gpt-5-mini";
// A compacted task can start a fresh Responses chain and keep using the
// original wall-clock and tool budgets. This is a hard ceiling, not a retry
// loop; the deadline and MAX_FUNCTION_CALLS still bound provider usage.
const MAX_ROUNDS = 16;
const MAX_FUNCTION_CALLS = 16;
const COMPACT_AFTER_INPUT_TOKENS = 48000;
const MAX_CONTEXT_COMPACTIONS = 2;
// Room for a whole video transcript (links.js keeps those to 16,000).
const MAX_TOOL_OUTPUT = 20000;
const CALL_TIMEOUT_MS = 150000;

function boundedText(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const left = Math.floor((limit - 30) / 2);
  const right = limit - 30 - left;
  return `${text.slice(0, left)}\n[… middle omitted at context checkpoint …]\n${text.slice(-right)}`;
}

function contextCheckpoint(originalInput, completedTools, lastNote) {
  const original = typeof originalInput === "string" ? originalInput : JSON.stringify(originalInput ?? "");
  const steps = completedTools.map((item, index) =>
    `${index + 1}. ${item.name}(${boundedText(item.arguments, 500)})\nResult: ${boundedText(item.output, 1000)}`,
  ).join("\n\n");
  return `Continue the same task from this compacted checkpoint. The tool results below are completed work: do not repeat the exact same tool call or side effect. Use these results as facts, retain the original request and its constraints, and continue any remaining work. If the request is complete, answer the user.\n\n<original_request_and_recent_context>\n${boundedText(original, 12000)}\n</original_request_and_recent_context>\n\n<completed_tool_calls>\n${steps || "No tools completed."}\n</completed_tool_calls>\n\n<last_agent_progress>\n${boundedText(lastNote, 3000) || "No intermediate note."}\n</last_agent_progress>`;
}

async function runWithinDeadline(run, signal, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || signal?.aborted) return { kind: signal?.aborted ? "cancelled" : "deadline" };
  const controller = new AbortController();
  let timer;
  let abort;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "deadline" });
    }, remaining);
  });
  const cancelled = signal ? new Promise(resolve => {
    abort = () => {
      controller.abort();
      resolve({ kind: "cancelled" });
    };
    signal.addEventListener("abort", abort, { once: true });
  }) : new Promise(() => {});
  // Resolve either outcome as data so a late rejection remains observed even
  // after the deadline race has stopped waiting for this operation.
  const operation = new Promise(resolve => {
    try {
      Promise.resolve(run(controller.signal)).then(
        value => resolve({ kind: "value", value }),
        error => resolve({ kind: "error", error }),
      );
    } catch (error) {
      resolve({ kind: "error", error });
    }
  });
  try {
    return await Promise.race([operation, timedOut, cancelled]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

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
/// `plain`: the workspace's own model, the search tool bare, no reasoning
/// settings — nothing a model might refuse — the retry when the full call
/// is turned down. Our own tools stay.
export async function research({ provider, env, instructions, input, tools = {}, language = "en", deadline = Date.now() + 240000, effort, plain = false, onRound = null, webSearch = true, maxOutput = null, mustLook = false, authorize = null, signal = null, usageContext = null, maxRounds = MAX_ROUNDS, maxFunctionCalls = MAX_FUNCTION_CALLS, maxContextCompactions = MAX_CONTEXT_COMPACTIONS }) {
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
      type: "function", name, description: t.description, parameters: t.parameters, strict: t.strict !== false,
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
  // Provider usage is authoritative when available; this conservative
  // estimate covers compatible Responses endpoints that omit usage details.
  let estimatedContextChars = instructions.length + JSON.stringify(input ?? "").length;
  let last = null;
  let finalOnly = false;
  let compactions = 0;
  const completedTools = [];
  const cancelled = () => ({ called, answer: null, sources: [], rounds, calls, cancelled: true });
  while (rounds < maxRounds + 1 && Date.now() < deadline) {
    if (signal?.aborted || (authorize && !await authorize())) return cancelled();
    rounds += 1;
    // Still at it: whoever is watching keeps seeing the agent writing.
    if (rounds > 1 && onRound) await Promise.resolve(onRound(rounds)).catch(() => {});
    if (signal?.aborted || (authorize && !await authorize())) return cancelled();
    const body = {
      model,
      instructions,
      input: next,
      ...(definitions.length ? { tools: definitions } : {}),
      // `mustLook`: something the answer depends on could not be read, so
      // the first round goes looking instead of answering from nothing.
      ...(definitions.length ? { tool_choice: finalOnly ? "none" : (mustLook && rounds === 1 ? "required" : "auto"), parallel_tool_calls: true } : {}),
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
        signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now())))]) : AbortSignal.timeout(Math.max(1, Math.min(CALL_TIMEOUT_MS, deadline - Date.now()))),
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
      if(signal?.aborted)return cancelled();
      console.error("agent research call failed", err?.message || err);
      if (!previous) return { called, answer: null, refused: true };
      break;
    }
    called = true;
    noteUsage(provider, "agent", data, usageContext);
    noteSearches(provider, "agent", data.model || model, (Array.isArray(data.output) ? data.output : []).filter((i) => i?.type === "web_search_call").length, usageContext);
    estimatedContextChars += JSON.stringify(data.output || []).length;
    last = data;
    previous = data.id || null;
    if (signal?.aborted || (authorize && !await authorize())) return cancelled();

    for (const c of readResponse(data).sources) note(cited, c.url, c.title);
    const pending = (Array.isArray(data.output) ? data.output : []).filter((item) => item?.type === "function_call");
    if (!pending.length || finalOnly) break;
    const reportedInputTokens = Number(data?.usage?.input_tokens || 0);
    const contextInputTokens = Math.max(reportedInputTokens, Math.ceil(estimatedContextChars / 4));
    if (contextInputTokens >= COMPACT_AFTER_INPUT_TOKENS && compactions >= maxContextCompactions) {
      finalOnly = true;
      next = pending.map(call => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: "The context checkpoint limit has been reached. Do not run more tools; answer from the completed evidence already provided.",
      }));
      continue;
    }

    // Trusted ownership-changing tools run alone before ordinary siblings.
    // A committed handoff ends this turn even if the model also returned text
    // or requested writes in the same response. Normal tools remain parallel.
    const runCall = async (call) => {
      calls += 1;
      let output;
      if (calls > maxFunctionCalls) output = "Tool budget spent. Answer now from what you have.";
      else {
        const tool = tools[call.name];
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch { /* the tool says so below */ }
        const canonicalArgs = JSON.stringify(args);
        const repeatedAfterCheckpoint = compactions > 0 && completedTools.find(item => item.name === call.name && item.arguments === canonicalArgs);
        if (repeatedAfterCheckpoint) return { type: "function_call_output", call_id: call.call_id, output: "This exact tool call already completed before the context checkpoint. Use its saved result and continue without repeating the side effect." };
        try {
          if (signal?.aborted || (authorize && !await authorize())) return { type: "function_call_output", call_id: call.call_id, output: "Access changed. Execution stopped." };
          let result;
          if(!tool)result=`No tool named ${call.name}.`;
          else {
            const bounded = await runWithinDeadline(toolSignal => tool.run(args, { signal: toolSignal }), signal, deadline);
            if (bounded.kind === "cancelled") return { cancelled: true };
            if (bounded.kind === "deadline") output = "The execution deadline was reached before this tool returned.";
            else if (bounded.kind === "error") throw bounded.error;
            else result = bounded.value;
          }
          if(output)return {type:"function_call_output",call_id:call.call_id,output};
          if(signal?.aborted)return {cancelled:true};
          const operationId = isControlTool(tool) ? handoffOperation(result) : null;
          if (operationId) return {handedOff: {operationId}};
          output = typeof result === "string" ? result : JSON.stringify(result) ?? String(result);
        } catch (err) {
          if(signal?.aborted)return {cancelled:true};
          output = `The tool failed: ${String(err?.message || err).slice(0, 200)}`;
        }
        if (call.name === "read_url" && typeof args.url === "string" && !/^(Could not|No )/.test(output)) {
          note(read, args.url, (output.match(/^Title: (.+)$/m) || [])[1] || "");
        }
      }
      return { type: "function_call_output", call_id: call.call_id, output: output.slice(0, MAX_TOOL_OUTPUT) };
    };
    const results = new Map();
    for (const call of pending.filter(call => isControlTool(tools[call.name]))) {
      const result = await runCall(call);
      if(result.cancelled)return cancelled();
      if (result.handedOff) return {called, answer: null, sources: [], rounds, calls, handedOff: result.handedOff};
      results.set(call, result);
    }
    await Promise.all(pending.filter(call => !isControlTool(tools[call.name])).map(async call => results.set(call, await runCall(call))));
    if(signal?.aborted)return cancelled();
    for (const call of pending) {
      const result = results.get(call);
      if (result?.type !== "function_call_output") continue;
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch { /* retain the raw arguments below */ }
      const canonicalArgs = JSON.stringify(args);
      if (!completedTools.some(item => item.name === call.name && item.arguments === canonicalArgs)) {
        completedTools.push({ name: call.name, arguments: canonicalArgs, output: result.output });
      }
    }
    const outputsForNextRound = pending.map(call => results.get(call));
    estimatedContextChars += JSON.stringify(outputsForNextRound).length;
    const shouldCompact = contextInputTokens >= COMPACT_AFTER_INPUT_TOKENS && compactions < maxContextCompactions;
    if (shouldCompact) {
      compactions += 1;
      previous = null;
      next = contextCheckpoint(input, completedTools, readResponse(data).text);
      estimatedContextChars = instructions.length + next.length;
    } else {
      next = outputsForNextRound;
      const tokensAfterToolResults = Math.max(reportedInputTokens, Math.ceil(estimatedContextChars / 4));
      if (tokensAfterToolResults >= COMPACT_AFTER_INPUT_TOKENS && compactions >= maxContextCompactions) finalOnly = true;
    }
    if (calls >= maxFunctionCalls || rounds >= maxRounds || Date.now() > deadline - 30000) finalOnly = true;
  }

  const text = last ? readResponse(last).text : "";
  const sources = [...cited.entries(), ...[...read.entries()].filter(([url]) => !cited.has(url))].map(([url, title]) => ({ url, title }));
  return { called, answer: text.trim() ? text : null, sources, rounds, calls, compactions };
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
