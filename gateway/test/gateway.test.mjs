import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs, validatePayload, IMAGE } from '../runner.mjs';
import { gatewayClient, processOne } from '../client.mjs';
import { runAcp } from '../acp.mjs';
const token = `hgw_${'a'.repeat(72)}`;
test('remote payload cannot choose host mounts, image, environment or command', () => {
  assert.deepEqual(validatePayload({ code: 'return 42', image: 'evil', mounts: ['/Users'], env: { SECRET: 'x' } }), { code: 'return 42', input: null });
  const args = containerArgs('honmaru-12345678-1234-1234-1234-123456789abc');
  assert.ok(args.includes(IMAGE));
  for (const flag of ['--volume', '--mount', '--env', '--privileged', '--publish']) assert.ok(!args.includes(flag));
  for (const [flag, value] of [['--network', 'none'], ['--uid', '65534'], ['--memory', '512m']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.throws(() => containerArgs('$(bad)'));
  assert.throws(() => validatePayload({ code: 'x'.repeat(65537) }));
});
test('client requires encrypted transport and refuses redirects carrying node credentials', async () => {
  for (const url of ['http://example.com', 'https://name:pass@example.com', 'https://example.com?token=x']) assert.throws(() => gatewayClient(url, token));
  let observed;
  const call = gatewayClient('https://example.com', token, async (url, options) => { observed = { url, options }; return Response.json({ job: null }); });
  await call('claim');
  assert.equal(observed.options.redirect, 'error');
  assert.equal(observed.url.href, 'https://example.com/gateways/claim');
  assert.equal(observed.options.headers.authorization, `Bearer ${token}`);
});
test('execution returns only its assigned lease and structured result', async () => {
  const calls = [];
  const call = async (path, body) => { calls.push([path, body]); return path === 'claim' ? { job: { id: 'job', lease: 'lease', payload: { code: 'return 42' }, timeoutMs: 60000 } } : { ok: true }; };
  await processOne(call, { run: async (payload, options) => { assert.equal(payload.code, 'return 42'); assert.equal(options.timeoutMs, 60000); return { status: 'succeeded', stdout: '42', stderr: '', exitCode: 0 }; } });
  assert.deepEqual(calls[1], ['jobs/job/finish', { lease: 'lease', status: 'succeeded', stdout: '42', stderr: '', exitCode: 0 }]);
});
test('local runtime failures do not leak host error details', async () => {
  let result;
  await processOne(async (path, body) => path === 'claim' ? { job: { id: 'job', lease: 'lease', payload: { code: 'x' } } } : (result = body), { run: async () => { throw new Error('/Users/private/token'); } });
  assert.equal(result.status, 'failed');
  assert.ok(!result.stderr.includes('/Users'));
});
test('a transient heartbeat failure does not abort an ACP job when a retry renews the lease', async () => {
  let heartbeats = 0, finished = false;
  const call = async path => {
    if (path === 'claim') return { job: { id: 'acp-job', lease: 'lease', payload: { acp: true, agentKey: 'opencode', prompt: 'hello' } } };
    if (path === 'jobs/acp-job/heartbeat') {
      heartbeats += 1;
      if (heartbeats === 1) throw new TypeError('temporary network failure');
      return { ok: true };
    }
    if (path === 'jobs/acp-job/finish') finished = true;
    return { ok: true };
  };
  await processOne(call, {
    heartbeatIntervalMs: 5,
    heartbeatGraceMs: 40,
    retryMs: [0],
    runAcpAgent: async (_payload, { signal }) => {
      await new Promise(resolve => setTimeout(resolve, 18));
      assert.equal(signal.aborted, false);
      return { status: 'succeeded', stdout: 'ok', stderr: '', exitCode: 0 };
    },
  });
  assert.ok(heartbeats >= 2);
  assert.equal(finished, true);
});
test('repeated transient heartbeat failures stop work before the lease becomes unsafe', async () => {
  let heartbeats = 0, finished = false, aborted = false;
  const call = async path => {
    if (path === 'claim') return { job: { id: 'acp-job', lease: 'lease', payload: { acp: true, agentKey: 'opencode', prompt: 'hello' } } };
    if (path === 'jobs/acp-job/heartbeat') { heartbeats += 1; throw new TypeError('network unavailable'); }
    if (path === 'jobs/acp-job/finish') finished = true;
    return { ok: true };
  };
  await processOne(call, {
    heartbeatIntervalMs: 5,
    heartbeatGraceMs: 20,
    runAcpAgent: async (_payload, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'failed', stdout: '', stderr: '', exitCode: null }); }, { once: true });
    }),
  });
  assert.ok(heartbeats >= 2);
  assert.equal(aborted, true);
  assert.equal(finished, false);
});
test('a result whose upload fails is handed in again, without running the code again', async () => {
  const job = { id: 'job', lease: 'lease', payload: { code: 'return input * 2', input: 21 } };
  const result = { status: 'succeeded', stdout: '42', stderr: '', exitCode: 0 };
  let runs = 0;
  const run = async () => { runs += 1; return result; };
  const finishing = (reply) => {
    const sent = [];
    return { sent, call: async (path, body) => { if (path === 'claim') return { job }; sent.push(body); return reply(sent.length); } };
  };
  const failure = (status, code) => Object.assign(new Error('refused'), { status, code });
  // Fails before reaching the server, then lands.
  let f = finishing((n) => { if (n === 1) throw new TypeError('fetch failed'); return { ok: true }; });
  assert.equal(await processOne(f.call, { run, retryMs: [0, 0] }), true);
  assert.equal(runs, 1);
  assert.deepEqual(f.sent, [{ lease: 'lease', ...result }, { lease: 'lease', ...result }]);
  // Landed, but the reply was lost: the server says it already has it.
  f = finishing((n) => { throw n === 1 ? failure(502) : failure(409, 'already_finished'); });
  assert.equal(await processOne(f.call, { run, retryMs: [0, 0] }), true);
  assert.equal(f.sent.length, 2);
  // A refusal ends it at once; failures that go on stop at the bound.
  f = finishing(() => { throw failure(409); });
  await assert.rejects(processOne(f.call, { run, retryMs: [0, 0] }), { status: 409 });
  assert.equal(f.sent.length, 1);
  f = finishing(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(processOne(f.call, { run, retryMs: [0, 0] }), TypeError);
  assert.equal(f.sent.length, 3);
  assert.equal(runs, 4);
});

test('TypeScript language is explicit while legacy JavaScript payloads remain unchanged',()=>{
 assert.deepEqual(validatePayload({code:'export default () => 42',language:'typescript'}),{code:'export default () => 42',input:null,language:'typescript'});
 assert.deepEqual(validatePayload({code:'return 42',language:'javascript'}),{code:'return 42',input:null});
 assert.throws(()=>validatePayload({code:'return 42',language:'shell'}));
});

test('assigned workflow jobs use scoped state transport without placing leases in the VM payload',async()=>{
 const calls=[];const payload={code:'await state.get()',context:{workspaceId:'workspace'}};
 await processOne(async(path,body,options)=>{
  calls.push({path,body,options});
  if(path==='claim')return {job:{id:'workflow-job',lease:'host-only-lease',workflow:true,payload}};
  if(path.endsWith('/state'))return {found:false,revision:0};
  return {ok:true};
 },{run:async()=>{throw Error('Wrong runner');},runWorkflow:async(task,{stateOperation,signal})=>{
  assert.equal(task,payload);assert.ok(!JSON.stringify(task).includes('host-only-lease'));
  const result=await stateOperation('state.get',{}, {signal});assert.equal(result.revision,0);
  return {status:'succeeded',stdout:'',stderr:'',exitCode:0};
 }});
 assert.deepEqual(calls[0].body,{capabilities:['workflow-program-v1'],acpAgents:[]});
 assert.deepEqual(calls[1].body,{lease:'host-only-lease',operation:'state.get',params:{}});
 assert.equal(calls[1].path,'jobs/workflow-job/state');
 assert.equal(calls[2].path,'jobs/workflow-job/finish');
});

test('client advertises only the ACP keys configured on the local node',async()=>{
 const calls=[];const local={codex:{command:'/usr/bin/codex-acp',args:['--stdio'],cwd:'/Users/operator/project'}};
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'acp-job',lease:'lease',payload:{acp:true,agentKey:'codex',prompt:'Review'}}}:{ok:true};},{acpAgents:local,runAcpAgent:async(payload,{acpAgents})=>{assert.equal(payload.acp,true);assert.equal(acpAgents,local);return {status:'succeeded',stdout:'{}',stderr:'',exitCode:0};}});
 assert.deepEqual(calls[0].body,{capabilities:['workflow-program-v1','acp-v1'],acpAgents:['codex']});
});
test('Workspace MCP requests are forwarded with this ACP job lease only when its opt-in is present',async()=>{
 const calls=[];
 await processOne(async(path,body,options)=>{
  calls.push({path,body,options});
  if(path==='claim')return {job:{id:'acp-workspace',lease:'private-lease',payload:{acp:true,workspaceTools:true,agentKey:'codex',prompt:'Read app'}}};
  if(path.endsWith('/mcp'))return {result:{tools:[{name:'list_apps'}]}};
  return {ok:true};
 },{runAcpAgent:async(_payload,{mcpCall})=>{
  assert.deepEqual(await mcpCall('tools/list',{}),{tools:[{name:'list_apps'}]});
  return {status:'succeeded',stdout:'{}',stderr:'',exitCode:0};
 }});
 assert.deepEqual(calls.find(item=>item.path.endsWith('/mcp'))?.body,{lease:'private-lease',method:'tools/list',params:{}});
 assert.equal(calls.at(-1).path,'jobs/acp-workspace/finish');
});
test('API request cancellation propagates into the host fetch',async()=>{
 const abort=new AbortController();let signal;
 const call=gatewayClient('https://example.com',token,async(_url,options)=>{signal=options.signal;return Response.json({ok:true});});
 await call('jobs/job/state',{}, {signal:abort.signal});abort.abort();assert.equal(signal.aborted,true);
});

test('ACP v1 starts a local allowlisted agent, opens a session and collects streamed text',async()=>{
 const {execPath}=await import('node:process');
 const script=`const readline=require('node:readline');
const input=readline.createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'session-1'}});else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP answer'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})}});`;
 const result=await runAcp({acp:true,agentKey:'local-test',prompt:'Do the task',command:'/bin/false',args:['attacker'],cwd:'/tmp'}, {timeoutMs:5000,acpAgents:{'local-test':{command:execPath,args:['-e',script],cwd:process.cwd()}}});
 assert.equal(result.status,'succeeded');
 assert.deepEqual(JSON.parse(result.stdout),{text:'ACP answer',sessionId:'session-1',stopReason:'end_turn'});
});

test('ACP configuration is resolved locally and permission requests default to reject',async()=>{
 const {execPath}=await import('node:process');
 const script=`const readline=require('node:readline');const input=readline.createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let promptId;input.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'s'}});else if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',id:88,method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:'c'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'},{optionId:'reject',name:'Reject',kind:'reject_once'}]}})}else if(m.id===88){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId}}}});send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}})}});`;
 // This fixture intentionally emits the permission request before its turn result.
 const result=await runAcp({agentKey:'local-test',prompt:'Do the task'}, {timeoutMs:5000,acpAgents:{'local-test':{command:execPath,args:['-e',script],cwd:process.cwd()}}});
 assert.equal(result.status,'succeeded');
 assert.equal(JSON.parse(result.stdout).text,'reject');
 await assert.rejects(runAcp({agentKey:'../attacker',prompt:'Do the task'}, {acpAgents:{}}),/Unknown local ACP agent/);
});
