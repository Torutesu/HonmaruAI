import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import { research, agentModelFor, isReasoningModel, canResearch } from "../src/agentResearch.js";

beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());

const provider = () => ({ providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "sk-test", model: "gpt-4o-mini", usage: [] });

test("the research model: AGENT_MODEL, else the workspace's reasoning model, else gpt-5-mini", () => {
  expect(agentModelFor({}, { model: "gpt-4o-mini" })).toBe("gpt-5-mini");
  expect(agentModelFor({}, { model: "gpt-5" })).toBe("gpt-5");
  expect(agentModelFor({ AGENT_MODEL: "gpt-6-sol" }, { model: "gpt-5" })).toBe("gpt-6-sol");
  expect(isReasoningModel("o4-mini")).toBe(true);
  expect(isReasoningModel("gpt-4.1")).toBe(false);
  expect(canResearch(provider())).toBe(true);
  expect(canResearch({ providerName: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" })).toBe(false);
});

test("past its tool budget the loop stops calling tools and asks for the answer", async () => {
  const bodies = [];
  let n = 0;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    n += 1;
    if (body.tool_choice === "none") return { id: `r${n}`, output_text: "Best answer from what was found.", output: [] };
    return { id: `r${n}`, output: [
      { type: "function_call", call_id: `a${n}`, name: "lookup", arguments: "{\"query\":\"x\"}" },
      { type: "function_call", call_id: `b${n}`, name: "lookup", arguments: "{\"query\":\"y\"}" },
    ] };
  }).persist();
  let ran = 0;
  const out = await research({
    provider: provider(), env: {}, instructions: "i", input: "q", language: "ja",
    tools: { lookup: { description: "d", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, run: async () => { ran += 1; return "found"; } } },
  });
  expect(out.answer).toBe("Best answer from what was found.");
  expect(ran).toBe(16);
  expect(bodies.at(-1).tool_choice).toBe("none");
  expect(bodies.slice(1).every((b, i) => b.previous_response_id === `r${i + 1}`)).toBe(true);
  expect(bodies[0].tools[0]).toEqual({ type: "web_search", search_context_size: "high", user_location: { type: "approximate", country: "JP" } });
  fetchMock.get("https://api.openai.com").interceptors = [];
});

test("a tool that throws, or one that does not exist, is told to the model rather than ending the research", async () => {
  const outputs = [];
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, {
    id: "r1", output: [
      { type: "function_call", call_id: "c1", name: "boom", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "nope", arguments: "{}" },
    ],
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    outputs.push(...JSON.parse(opts.body).input);
    return { id: "r2", output_text: "Done.", output: [] };
  });
  const out = await research({ provider: provider(), env: {}, instructions: "i", input: "q", tools: { boom: { description: "d", parameters: {}, run: async () => { throw new Error("kaput"); } } } });
  expect(out.answer).toBe("Done.");
  expect(outputs).toEqual([
    { type: "function_call_output", call_id: "c1", output: "The tool failed: kaput" },
    { type: "function_call_output", call_id: "c2", output: "No tool named nope." },
  ]);
});
