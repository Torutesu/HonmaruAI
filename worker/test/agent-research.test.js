import { fetchMock } from "./helpers/fetch-mock.js";
import { beforeEach, afterEach, expect, test } from "vitest";
import { research, agentModelFor, isReasoningModel, canResearch } from "../src/agentResearch.js";
import { askAgent } from "../src/customAgents.js";

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

test("each web search is on the ledger at OpenAI's per-call price, beside the tokens", async () => {
  const p = provider();
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, {
    id: "r1", model: "gpt-5-mini", output_text: "Found it.",
    output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "web_search_call" }],
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
  await research({ provider: p, env: {}, instructions: "i", input: "q" });
  const search = p.usage.find((u) => u.model === "web_search");
  expect(search).toMatchObject({ purpose: "agent", input: 0, output: 0, usd: 0.03 });
  expect(p.usage.find((u) => u.model === "gpt-5-mini")).toMatchObject({ input: 1000, output: 200 });
  const { noteSearches } = await import("../src/ledger.js");
  const q = { usage: [] };
  noteSearches(q, "agent", "gpt-4o-mini", 2);
  expect(q.usage[0].usd).toBe(0.05);
});

test('agent research starts with a skill index and reads the complete procedure only on demand', async () => {
  const { askAgent } = await import('../src/customAgents.js');
  const bodies = [];
  const procedure = 'Private full procedure with final checks';
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200, opts => {
    bodies.push(JSON.parse(opts.body));
    return {id:'skill-round-1',output:[{type:'function_call',call_id:'skill-call',name:'read_installed_skill',arguments:'{"skill_id":"one"}'}]};
  });
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200, opts => {
    bodies.push(JSON.parse(opts.body));
    return {id:'skill-round-2',output_text:'Completed using the procedure.',output:[]};
  });
  const out = await askAgent({provider:provider(),agent:{name:'Helper',handle:'helper',instructions:procedure,researchInstructions:'Catalog: one — Review a release'},request:'Review',transcript:[],tools:{read_installed_skill:{description:'Read skill',parameters:{type:'object',properties:{skill_id:{type:'string'}},required:['skill_id'],additionalProperties:false},run:async()=>({body:procedure})}}});
  expect(out.answer).toContain('Completed');
  expect(bodies[0].instructions).toContain('Catalog: one');
  expect(bodies[0].instructions).not.toContain(procedure);
  expect(JSON.stringify(bodies[1].input)).toContain(procedure);
});

test('non-research agent execution retains full instructions instead of an unreadable catalog', async () => {
  const { askAgent } = await import('../src/customAgents.js');
  let body;
  fetchMock.get('https://example.test').intercept({path:'/chat/completions',method:'POST'}).reply(200, opts => {
    body=JSON.parse(opts.body);
    return {choices:[{message:{content:'Done'}}]};
  });
  await askAgent({provider:{...provider(),providerName:'Other',endpoint:'https://example.test/chat/completions'},agent:{name:'Helper',handle:'helper',instructions:'Full procedure',researchInstructions:'Catalog only'},request:'Review',transcript:[],tools:{}});
  expect(body.messages[0].content).toContain('Full procedure');
  expect(body.messages[0].content).not.toContain('Catalog only');
});


test("revoked access prevents a research request before any model call", async () => {
  const out=await research({provider:provider(),instructions:'Check',input:'Check',authorize:async()=>false});
  expect(out).toMatchObject({called:false,answer:null,cancelled:true,rounds:0});
});

test("revocation during the model call prevents its requested tools from running", async () => {
  let allowed=true, ran=0;
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST"}).reply(200,()=>{
    allowed=false;
    return {id:'r-revoked',output:[{type:'function_call',name:'write_record',call_id:'c1',arguments:'{}'}]};
  });
  const out=await research({provider:provider(),instructions:'Check',input:'Check',authorize:async()=>allowed,
    tools:{write_record:{description:'Write',parameters:{type:'object',properties:{}},run:async()=>{ran++;return 'saved'}}}});
  expect(ran).toBe(0);expect(out).toMatchObject({called:true,answer:null,cancelled:true});
});

test("revocation while a tool runs withholds its result from subsequent model calls", async () => {
  let allowed=true, ran=0;
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST"}).reply(200,
    {id:'r1',output:[{type:'function_call',name:'read_record',call_id:'c1',arguments:'{}'}]});
  const out=await research({provider:provider(),instructions:'Check',input:'Check',authorize:async()=>allowed,
    tools:{read_record:{description:'Read',parameters:{type:'object',properties:{}},run:async()=>{ran++;allowed=false;return 'private result'}}}});
  expect(ran).toBe(1);expect(out).toMatchObject({called:true,answer:null,cancelled:true,rounds:1});
});


test("agent research passes its authorization guard and does not retry a revoked turn", async () => {
  let allowed=true;
  fetchMock.get("https://api.openai.com").intercept({path:"/v1/responses",method:"POST"}).reply(200,()=>{
    allowed=false;return {id:'r-revoked-answer',output_text:'Do not publish this answer',output:[]};
  });
  const out=await askAgent({provider:provider(),agent:{id:'a',name:'Agent',handle:'agent',instructions:'Help'},
    request:'Check',transcript:[],playbook:[],where:'room',askedBy:'member',authorize:async()=>allowed});
  expect(out.called).toBe(true);expect(out.answer).toBeNull();expect(out.cancelled).toBe(true);
});
