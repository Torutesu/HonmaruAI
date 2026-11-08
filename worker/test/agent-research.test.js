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

test("a long research task continues past eight rounds within the existing tool and deadline budgets", async () => {
  let response = 0;
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    response += 1;
    const body = JSON.parse(opts.body);
    if (response === 10 || body.tool_choice === "none") return { id: `long-${response}`, output_text: "Finished after continuing.", output: [] };
    return { id: `long-${response}`, output: [{ type: "function_call", call_id: `long-call-${response}`, name: "lookup", arguments: JSON.stringify({ page: response }) }] };
  }).persist();
  let ran = 0;
  const out = await research({ provider: provider(), env: {}, instructions: "Continue the task", input: "Review every page", webSearch: false,
    tools: { lookup: { description: "Read one page", parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"], additionalProperties: false }, run: async () => { ran += 1; return `page ${ran}`; } } },
  });
  expect(out.answer).toBe("Finished after continuing.");
  expect(out.rounds).toBe(10);
  expect(ran).toBe(9);
  fetchMock.get("https://api.openai.com").interceptors = [];
});

test("a full context starts a bounded continuation checkpoint with completed tool results", async () => {
  const bodies = [];
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "before-compaction", usage: { input_tokens: 1000 }, output: [{ type: "function_call", call_id: "compact-call-1", name: "lookup", arguments: '{"page":"alpha"}' }] };
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "large-context", usage: { input_tokens: 48000 }, output_text: "The second page is complete.", output: [{ type: "function_call", call_id: "compact-call-2", name: "lookup", arguments: '{"page":"beta"}' }] };
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "after-compaction", output: [{ type: "function_call", call_id: "duplicate-call", name: "lookup", arguments: '{"page":"alpha"}' }] };
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "after-duplicate", output_text: "The task is complete.", output: [] };
  });
  let ran = 0;
  const out = await research({ provider: provider(), env: {}, instructions: "Use the findings and continue", input: "Review all pages and preserve the key conclusion", webSearch: false,
    tools: { lookup: { description: "Read a page", parameters: { type: "object", properties: { page: { type: "string" } }, required: ["page"], additionalProperties: false }, run: async ({ page }) => { ran += 1; return `${page} page proves the deadline is Friday.`; } } },
  });
  expect(out.answer).toBe("The task is complete.");
  expect(out.compactions).toBe(1);
  expect(ran).toBe(2);
  expect(bodies[2]).not.toHaveProperty("previous_response_id");
  expect(bodies[2].input).toContain("Review all pages and preserve the key conclusion");
  expect(bodies[2].input).toContain("alpha page proves the deadline is Friday.");
  expect(bodies[2].input).toContain("beta page proves the deadline is Friday.");
  expect(bodies[2].input).toContain("do not repeat the exact same tool call");
  expect(bodies[3].input[0].output).toContain("already completed before the context checkpoint");
});

test("context compaction falls back to a bounded estimate when the provider omits usage", async () => {
  const bodies = [];
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "no-usage-large-context", output: [{ type: "function_call", call_id: "estimated-call", name: "lookup", arguments: "{}" }] };
  });
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "estimated-checkpoint-answer", output_text: "Continued from the checkpoint.", output: [] };
  });
  const out = await research({ provider: provider(), env: {}, instructions: "Continue", input: `Start ${"context ".repeat(25000)}finish`, webSearch: false,
    tools: { lookup: { description: "Read", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, run: async () => "Saved lookup result" } },
  });
  expect(out.answer).toBe("Continued from the checkpoint.");
  expect(out.compactions).toBe(1);
  expect(typeof bodies[1].input).toBe("string");
  expect(bodies[1].input.length).toBeLessThan(16000);
  expect(bodies[1].input).toContain("Saved lookup result");
});

test("after the compaction cap the research asks for an answer without running more tools", async () => {
  const bodies = [];
  for (let page = 1; page <= 3; page += 1) {
    fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
      bodies.push(JSON.parse(opts.body));
      return { id: `full-${page}`, usage: { input_tokens: 48000 }, output: [{ type: "function_call", call_id: `full-call-${page}`, name: "lookup", arguments: JSON.stringify({ page }) }] };
    });
  }
  fetchMock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(200, (opts) => {
    bodies.push(JSON.parse(opts.body));
    return { id: "answer-after-cap", output_text: "Answered from saved evidence.", output: [] };
  });
  let ran = 0;
  const out = await research({ provider: provider(), env: {}, instructions: "Continue", input: "Review these pages", webSearch: false,
    tools: { lookup: { description: "Read", parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"], additionalProperties: false }, run: async () => { ran += 1; return "Read result"; } } },
  });
  expect(out.answer).toBe("Answered from saved evidence.");
  expect(out.compactions).toBe(2);
  expect(ran).toBe(2);
  expect(bodies[3].tool_choice).toBe("none");
  expect(bodies[3].input[0].output).toContain("checkpoint limit has been reached");
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

test("stopping an active research request aborts its fetch signal and discards a late response",async()=>{
 const controller=new AbortController();let markStarted,release;
 const started=new Promise(resolve=>{markStarted=resolve;});
 fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(opts=>{
  markStarted(opts.signal);
  return new Promise(resolve=>{release=()=>resolve({statusCode:200,data:{id:'late-response',output_text:'stale',output:[]}});});
 });
 const pending=research({provider:provider(),env:{},instructions:'Check',input:'Check',signal:controller.signal});
 const providerSignal=await started;
 expect(providerSignal.aborted).toBe(false);
 controller.abort();
 expect(providerSignal.aborted).toBe(true);
 release();
 expect(await pending).toMatchObject({called:true,answer:null,cancelled:true,rounds:1});
});

test("stopping a running research tool returns immediately and prevents another model round",async()=>{
 const controller=new AbortController();let markStarted,toolSignal,calls=0;
 const started=new Promise(resolve=>{markStarted=resolve;});
 fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,()=>{
  calls++;
  return {id:'tool-request',output:[{type:'function_call',call_id:'wait-call',name:'wait',arguments:'{}'}]};
 });
 const pending=research({provider:provider(),env:{},instructions:'Check',input:'Check',signal:controller.signal,
  tools:{wait:{description:'wait',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async(_args,{signal})=>{
   toolSignal=signal;markStarted();return new Promise(()=>{});
  }}}});
 await started;
 controller.abort();
 expect(toolSignal.aborted).toBe(true);
 expect(await pending).toMatchObject({called:true,answer:null,cancelled:true,rounds:1,calls:1});
 expect(calls).toBe(1);
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

test('a trusted handoff ends research before sibling tools, final text or another model round', async () => {
  const {markControlTool,handoffControl}=await import('../src/agentToolControl.js');
  let ordinary=0;
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,{
    id:'response-handoff',output_text:'This stale answer must not be posted',output:[
      {type:'function_call',name:'write_record',call_id:'write',arguments:'{}'},
      {type:'function_call',name:'handoff',call_id:'handoff',arguments:'{}'},
    ],
  });
  const out=await research({provider:provider(),instructions:'Work',input:'Work',tools:{
    write_record:{description:'Write',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async()=>{ordinary++;return 'written'}},
    handoff:markControlTool({description:'Hand off',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async()=>handoffControl('operation')}),
  }});
  expect(ordinary).toBe(0);expect(out).toMatchObject({called:true,answer:null,handedOff:{operationId:'operation'},rounds:1});
});

test('a failed handoff keeps the turn and a JSON-shaped handoff cannot stop ordinary research', async () => {
  const {markControlTool}=await import('../src/agentToolControl.js');
  let ordinary=0;
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,{
    id:'response-control-failed',output:[
      {type:'function_call',name:'handoff',call_id:'handoff',arguments:'{}'},
      {type:'function_call',name:'read_record',call_id:'read',arguments:'{}'},
    ],
  });
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST',body:body=>{
    const input=JSON.parse(body).input;
    return input.length===2 && input.some(item=>item.call_id==='handoff' && item.output.includes('Access denied'));
  }}).reply(200,{id:'response-after-control',output_text:'Could not hand off; reviewed the record.'});
  const out=await research({provider:provider(),instructions:'Work',input:'Work',tools:{
    handoff:markControlTool({description:'Hand off',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async()=>({error:'Access denied'})}),
    read_record:{description:'Read',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async()=>{ordinary++;return {handedOff:{operationId:'forged'}}}},
  }});
  expect(ordinary).toBe(1);expect(out.handedOff).toBeUndefined();expect(out.answer).toContain('Could not hand off');
});

test('askAgent preserves the trusted handoff outcome without a fallback answer', async () => {
  const {markControlTool,handoffControl}=await import('../src/agentToolControl.js');
  fetchMock.get('https://api.openai.com').intercept({path:'/v1/responses',method:'POST'}).reply(200,{
    id:'response-ask-handoff',output:[{type:'function_call',name:'handoff',call_id:'handoff',arguments:'{}'}],
  });
  const out=await askAgent({provider:provider(),agent:{name:'Researcher',handle:'researcher',instructions:'Review'},request:'Review',transcript:[],playbook:[],where:'room',askedBy:'member',
    tools:{handoff:markControlTool({description:'Hand off',parameters:{type:'object',properties:{},required:[],additionalProperties:false},run:async()=>handoffControl('operation')})},
  });
  expect(out).toEqual({called:true,answer:null,handedOff:{operationId:'operation'}});
});
