import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchMock } from "./helpers/fetch-mock.js";
import { askAgent } from "../src/customAgents.js";
import { agentSubagentTool, helperReadTools } from "../src/agentSubagents.js";

beforeEach(() => fetchMock.activate());
afterEach(() => { vi.restoreAllMocks(); fetchMock.assertNoPendingInterceptors(); });

const provider = { providerName: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", apiKey: "test", model: "test/free" };
const fn = (name, args) => ({ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const response = (message, check = () => {}) => fetchMock.get("https://openrouter.ai")
  .intercept({ path: "/api/v1/chat/completions", method: "POST" }).reply(200, opts => {
    check(JSON.parse(opts.body));
    return { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  });
const tool = run => ({ description: "scoped read", parameters: { type: "object", properties: {}, additionalProperties: false }, run });

test("Harness Agent delegates two private parallel helpers with read-only tools", async () => {
  let finishParent;
  response({ tool_calls: [fn("delegate_subagents", { tasks: [
    { title: "Decision", task: "Find the decision" }, { title: "Thread", task: "Find the thread" },
  ] })] }, body => expect(body.tools.map(item => item.function.name)).toContain("delegate_subagents"));
  const childStarted = [];
  fetchMock.get("https://openrouter.ai").intercept({ path: "/api/v1/chat/completions", method: "POST" }).reply(opts => {
    const body = JSON.parse(opts.body);
    const input = body.messages[1].content;
    const child = input.includes("Find the decision") ? "decision" : "thread";
    childStarted.push(child);
    expect(body.tools.map(item => item.function.name)).toEqual(["search_team_decisions"]);
    expect(body.tools.some(item => /write|post|browser|execute|delegate/.test(item.function.name))).toBe(false);
    return new Promise(resolve => {
      finishParent = finishParent || [];
      finishParent.push(() => resolve({ statusCode: 200, data: { choices: [{ message: { content: `finding ${child}` } }], usage: { prompt_tokens: 5, completion_tokens: 2 } } }));
    });
  }).times(2);
  const tools = {
    search_team_decisions: tool(async () => "decision source"),
    write_record: tool(async () => { throw new Error("must not be exposed"); }),
  };
  const pending = askAgent({ provider, agent: { name: "Researcher", handle: "researcher", instructions: "" }, request: "Research", transcript: [], harnessTools: true, tools });
  await vi.waitFor(() => expect(childStarted).toHaveLength(2));
  expect(childStarted).toEqual(["decision", "thread"]);
  finishParent.forEach(resolve => resolve());
  // The helpers return their private findings to the parent, which then answers.
  response({ content: "Combined findings." }, body => {
    expect(body.messages.at(-1).content).toContain("finding decision");
    expect(body.messages.at(-1).content).toContain("finding thread");
  });
  expect(await pending).toMatchObject({ answer: "Combined findings." });
});

test("helper tool allowlist excludes every non-read tool and invalid batches do not call providers", async () => {
  const filtered = helperReadTools({
    search_team_decisions: tool(async () => "ok"),
    read_agent_memory: tool(async () => "ok"),
    write_record: tool(async () => "bad"),
    execute_code: tool(async () => "bad"),
    delegate_subagents: tool(async () => "bad"),
  });
  expect(Object.keys(filtered)).toEqual(["search_team_decisions", "read_agent_memory"]);
  const delegate = agentSubagentTool({ provider, agent: { name: "A" }, parentInput: "task", tools: {} });
  await expect(delegate.run({ tasks: [
    { title: "one", task: "1" }, { title: "two", task: "2" }, { title: "three", task: "3" },
  ] })).resolves.toBe("Delegate one or two tasks.");
  fetchMock.assertNoPendingInterceptors();
});

test("OpenAI helper calls the Responses API without hosted web search", async () => {
  const openAi = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "test", model: "gpt-4o-mini" };
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, opts => {
    const body = JSON.parse(opts.body);
    expect(body.tools.map(item => item.name)).toEqual(["search_team_decisions"]);
    expect(body.tools.some(item => item.type === "web_search")).toBe(false);
    expect(body.max_output_tokens).toBe(1600);
    return { id: "helper-answer", output_text: "Private finding", output: [] };
  });
  const delegate = agentSubagentTool({ provider: openAi, agent: { name: "A", instructions: "Research safely" }, parentInput: "task", tools: { search_team_decisions: tool(async () => "source") } });
  await expect(delegate.run({ tasks: [{ title: "Decision", task: "Find it" }] })).resolves.toContain("Private finding");
});

test("OpenAI helper read tool cannot hold the run beyond its deadline", async () => {
  const openAi = { providerName: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", apiKey: "test", model: "gpt-4o-mini" };
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, {
    id: "helper-tool-request", output: [{ type: "function_call", call_id: "lookup-1", name: "search_team_decisions", arguments: "{}" }],
  });
  let toolSignal;
  const delegate = agentSubagentTool({ provider: openAi, agent: { name: "A" }, parentInput: "task", deadline: Date.now() + 40,
    tools: { search_team_decisions: tool(async (_args, { signal }) => { toolSignal = signal; return new Promise(() => {}); }) } });
  const started = Date.now();
  await expect(delegate.run({ tasks: [{ title: "Stuck read", task: "Wait" }] })).resolves.toContain("No result was returned.");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(toolSignal.aborted).toBe(true);
});

test("Simple Agent path never advertises helper delegation", async () => {
  response({ content: "Simple answer" }, body => expect(body.tools).toBeUndefined());
  const out = await askAgent({ provider, agent: { name: "A", handle: "a", instructions: "" }, request: "task", transcript: [], tools: { search_team_decisions: tool(async () => "ok") } });
  expect(out.answer).toBe("Simple answer");
});

