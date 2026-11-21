import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { containerArgs, validatePayload, validateFiles, runIsolated, IMAGE } from '../runner.mjs';
import { gatewayClient, processOne } from '../client.mjs';
import { runAcp } from '../acp.mjs';
import {WORKFLOW_EXECUTION_TIMEOUT_MS,runWorkflowIsolated} from '../workflow-runner.mjs';
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
test('workflow programs receive the Kylon-aligned fifteen-minute hard cap while generic jobs stay short',async()=>{
 let observed;
 const call=async path=>path==='claim'?{job:{id:'workflow-job',lease:'lease',workflow:true,payload:{workflowProgram:true,code:'await work()'}}}:{ok:true};
 await processOne(call,{runWorkflow:async(_payload,options)=>{observed=options.timeoutMs;return {status:'succeeded',stdout:'done',stderr:'',exitCode:0};}});
 assert.equal(WORKFLOW_EXECUTION_TIMEOUT_MS,900000);assert.equal(observed,WORKFLOW_EXECUTION_TIMEOUT_MS);
 await assert.rejects(()=>runWorkflowIsolated({code:'console.log(1)'},{timeoutMs:WORKFLOW_EXECUTION_TIMEOUT_MS+1}),/Invalid execution timeout/);
});
test('ACP progress is sent through the current job lease without affecting generic jobs',async()=>{
 const calls=[];
 const call=async(path,body)=>{calls.push([path,body]);return path==='claim'?{job:{id:'acp-job',lease:'lease',payload:{acp:true,agentKey:'fixture',prompt:'hello'}}}:{ok:true};};
 await processOne(call,{runAcpAgent:async(_payload,{onProgress})=>{await onProgress({kind:'tool',title:'Run checks',status:'in_progress'});return {status:'succeeded',stdout:'done',stderr:'',exitCode:0};}});
 assert.deepEqual(calls.find(([path])=>path==='jobs/acp-job/progress'),['jobs/acp-job/progress',{lease:'lease',progress:{kind:'tool',title:'Run checks',status:'in_progress'}}]);
 assert.equal(calls.at(-1)[0],'jobs/acp-job/finish');
});
test('local runtime failures do not leak host error details', async () => {
  let result;
  await processOne(async (path, body) => path === 'claim' ? { job: { id: 'job', lease: 'lease', payload: { code: 'x' } } } : (result = body), { run: async () => { throw new Error('/Users/private/token'); } });
  assert.equal(result.status, 'failed');
  assert.ok(!result.stderr.includes('/Users'));
});
test('a transient heartbeat failure does not abort an ACP job when a retry renews the lease', async () => {
  let heartbeats = 0, finished = false, recover;
  const recovered = new Promise(resolve => { recover = resolve; });
  const call = async path => {
    if (path === 'claim') return { job: { id: 'acp-job', lease: 'lease', payload: { acp: true, agentKey: 'opencode', prompt: 'hello' } } };
    if (path === 'jobs/acp-job/heartbeat') {
      heartbeats += 1;
      if (heartbeats === 1) throw new TypeError('temporary network failure');
      recover();
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
      await new Promise(resolve => {
        const complete = () => { signal.removeEventListener('abort', complete); resolve(); };
        signal.addEventListener('abort', complete, { once: true });
        recovered.then(complete);
      });
      assert.equal(signal.aborted, false);
      return { status: 'succeeded', stdout: 'ok', stderr: '', exitCode: 0 };
    },
  });
  assert.ok(heartbeats >= 2);
  assert.equal(finished, true);
});
test('a budget-cancelled workflow lease aborts the active isolated run', async () => {
  let aborted = false, finished = false;
  const call = async path => {
    if (path === 'claim') return { job: { id: 'workflow-job', lease: 'lease', workflow: true, payload: { code: 'await work()' } } };
    if (path === 'jobs/workflow-job/heartbeat') throw Object.assign(new Error('Execution is no longer authorized.'), { status: 409 });
    if (path === 'jobs/workflow-job/finish') finished = true;
    return { ok: true };
  };
  await processOne(call, {
    heartbeatIntervalMs: 5,
    heartbeatGraceMs: 40,
    runWorkflow: async (_payload, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'failed', stdout: '', stderr: '', exitCode: null }); }, { once: true });
    }),
  });
  assert.equal(aborted, true);
  assert.equal(finished, false);
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

test('only the trusted claim channel can supply bounded app secrets to the isolated runtime',()=>{
 assert.deepEqual(validatePayload({code:'return env.KEY',environment:{KEY:'attacker'}}),{code:'return env.KEY',input:null});
 assert.deepEqual(validatePayload({code:'return env.KEY'},{environment:{KEY:'sealed-secret'}}),{code:'return env.KEY',input:null,environment:{KEY:'sealed-secret'}});
 assert.throws(()=>validatePayload({code:'return 1'},{environment:{PATH:'host-path'}}));
 assert.throws(()=>validatePayload({code:'return 1'},{environment:{A:'x'.repeat(4001)}}));
});

test('claimed app secrets reach the sandbox without becoming part of the job payload',async()=>{
 const job={id:'job',lease:'lease',payload:{code:'return env.API_TOKEN'},environment:{API_TOKEN:'sealed-secret'}};let options;
 await processOne(async path=>path==='claim'?{job}:{ok:true},{run:async(_payload,received)=>{options=received;return{status:'succeeded',stdout:'ok',stderr:'',exitCode:0}}});
 assert.deepEqual(options.environment,{API_TOKEN:'sealed-secret'});
 assert.equal(job.payload.environment,undefined);
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
 assert.deepEqual(calls[0].body,{capabilities:['workflow-program-v1','browser-action-v1'],acpAgents:[]});
 assert.deepEqual(calls[1].body,{lease:'host-only-lease',operation:'state.get',params:{}});
 assert.equal(calls[1].path,'jobs/workflow-job/state');
 assert.equal(calls[2].path,'jobs/workflow-job/finish');
});

test('client advertises only the ACP keys configured on the local node',async()=>{
 const calls=[];const local={codex:{command:'/usr/bin/codex-acp',args:['--stdio'],cwd:'/Users/operator/project'}};
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'acp-job',lease:'lease',payload:{acp:true,agentKey:'codex',prompt:'Review'}}}:{ok:true};},{acpAgents:local,runAcpAgent:async(payload,{acpAgents})=>{assert.equal(payload.acp,true);assert.equal(acpAgents,local);return {status:'succeeded',stdout:'{}',stderr:'',exitCode:0};}});
 assert.deepEqual(calls[0].body,{capabilities:['workflow-program-v1','browser-action-v1','acp-v1'],acpAgents:['codex']});
});
test('native browser action advertises its dedicated capability and performs one leased action only',async()=>{
 const calls=[],actions=[];
 const payload={nativeBrowserAction:true,workspaceId:'org-1',browserIdentity:'agent-1',browserContext:{channel:'room-1',messageId:'turn-1'},browserAction:{type:'visible_text'}};
 await processOne(async(path,body,options)=>{
  calls.push({path,body,options});
  return path==='claim'?{job:{id:'native-browser',lease:'browser-lease',payload}}:{ok:true};
 },{runBrowser:async options=>{actions.push(options);return{url:'https://example.com',title:'Example',text:'Visible page text',extra:'discard'};}});
 assert.deepEqual(calls[0].body,{capabilities:['workflow-program-v1','browser-action-v1'],acpAgents:[]});
 assert.equal(calls[1].path,'jobs/native-browser/browser-action');
 assert.deepEqual(actions.map(({workspaceId,agentId,action})=>({workspaceId,agentId,action})),[{workspaceId:'org-1',agentId:'agent-1',action:{type:'visible_text'}}]);
 assert.equal(calls[2].path,'jobs/native-browser/finish');
 assert.deepEqual(JSON.parse(calls[2].body.stdout),{url:'https://example.com',title:'Example',text:'Visible page text'});
 assert.equal(calls[2].body.status,'succeeded');
});
test('native browser action aborts in flight when its authorization recheck is revoked',async()=>{
 const calls=[];let authorizationChecks=0,actionStarted,actionAborted=false,finished=false;
 const started=new Promise(resolve=>{actionStarted=resolve;});
 const payload={nativeBrowserAction:true,workspaceId:'org-1',browserIdentity:'agent-1',browserContext:{channel:'room-1',threadId:'thread-1',sourceMessageId:'message-1',requesterLogin:'owner'},browserAction:{type:'click',x:20,y:30}};
 const pending=processOne(async(path,body)=>{
  calls.push({path,body});
  if(path==='claim')return{job:{id:'native-revoked-in-flight',lease:'lease',payload}};
  if(path==='jobs/native-revoked-in-flight/browser-action'){
   authorizationChecks++;
   if(authorizationChecks>1)throw Object.assign(new Error('authorization revoked'),{status:403});
  }
  if(path==='jobs/native-revoked-in-flight/finish')finished=true;
  return{ok:true};
 },{
  browserAuthorizationCheckIntervalMs:2,
  runBrowser:async({signal})=>{
   actionStarted();
   await new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{actionAborted=true;reject(new Error('aborted after revoke'));},{once:true});
    if(signal.aborted){actionAborted=true;reject(new Error('aborted after revoke'));}
   });
   return{clicked:true};
  },
 });
 await started;
 assert.equal(await pending,true);
 assert.equal(authorizationChecks,2);
 assert.equal(actionAborted,true);
 assert.equal(finished,false);
});
test('native screenshot asks the local browser for a bounded visual thumbnail',async()=>{
 const calls=[],payload={nativeBrowserAction:true,workspaceId:'org-1',browserIdentity:'agent-1',browserAction:{type:'screenshot'}};
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'native-thumbnail',lease:'lease',payload}}:{ok:true};},{runBrowser:async({action})=>{
  assert.deepEqual(action,{type:'screenshot',thumbnail:true});
  return{url:'https://kylon.io/ja',image:'a'.repeat(40_000)};
 }});
 const finish=calls.find(({path})=>path==='jobs/native-thumbnail/finish')?.body;
 assert.equal(finish.status,'succeeded');
 assert.equal(JSON.parse(finish.stdout).image.length,40_000);
 assert.ok(Buffer.byteLength(JSON.stringify(finish))<70_000);
});
test('native browser action rejects malformed actions before authorization or browser access',async()=>{
 const calls=[],payload={nativeBrowserAction:true,workspaceId:'org-1',browserIdentity:'agent-1',browserAction:{type:'navigate',url:'javascript:alert(1)'}};
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'native-browser',lease:'lease',payload}}:{ok:true};},{runBrowser:async()=>assert.fail('invalid action must not reach browser')});
 assert.equal(calls.some(({path})=>path==='jobs/native-browser/browser-action'),false);
 assert.equal(calls.at(-1).path,'jobs/native-browser/finish');
 assert.equal(calls.at(-1).body.status,'failed');
});
test('native screenshot larger than the Worker result envelope is not forwarded',async()=>{
 const calls=[],payload={nativeBrowserAction:true,workspaceId:'org-1',browserIdentity:'agent-1',browserAction:{type:'screenshot'}};
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'native-screenshot',lease:'lease',payload}}:{ok:true};},{runBrowser:async()=>({url:'https://example.com',image:'a'.repeat(48_001)})});
 const finish=calls.find(({path})=>path==='jobs/native-screenshot/finish')?.body;
 assert.ok(finish);
 assert.equal(finish.status,'failed');
 assert.match(finish.stderr,/48 KB transfer limit/);
 assert.equal(finish.stdout,'');
 assert.ok(Buffer.byteLength(JSON.stringify(finish))<70_000);
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
test('each local browser action rechecks its leased Harness grant before touching the persistent profile',async()=>{
 const calls=[];let browserOptions;
 await processOne(async(path,body,options)=>{
  calls.push({path,body,options});
  return path==='claim'?{job:{id:'acp-browser',lease:'browser-lease',payload:{acp:true,browserTools:true,agentKey:'codex',browserIdentity:'agent-1',workspaceId:'org-1',prompt:'Open the release notes'}}}:{ok:true};
 },{
  runAcpAgent:async(_payload,{browserCall,signal})=>{
   const result=await browserCall({type:'screenshot'},{signal});
   assert.deepEqual(result,{url:'https://example.com'});
   return {status:'succeeded',stdout:'{}',stderr:'',exitCode:0};
  },
  runBrowser:async options=>{browserOptions=options;return {url:'https://example.com'};},
 });
 assert.deepEqual(calls.find(item=>item.path==='jobs/acp-browser/browser')?.body,{lease:'browser-lease'});
 assert.deepEqual(browserOptions,{workspaceId:'org-1',agentId:'agent-1',action:{type:'screenshot'},signal:browserOptions.signal});
 assert.ok(browserOptions.signal instanceof AbortSignal);
 assert.equal(calls.at(-1).path,'jobs/acp-browser/finish');
});
test('browser actions publish only bounded JPEG frames through the same execution lease',async()=>{
 const calls=[];const browserActions=[];
 await processOne(async(path,body)=>{calls.push({path,body});return path==='claim'?{job:{id:'acp-live',lease:'live-lease',payload:{acp:true,browserTools:true,agentKey:'codex',browserIdentity:'agent-1',workspaceId:'org-1',prompt:'Open the release notes'}}}:{ok:true};},{
  runAcpAgent:async(_payload,{browserCall,signal})=>{await browserCall({type:'click',x:20,y:30},{signal});return {status:'succeeded',stdout:'{}',stderr:'',exitCode:0};},
  runBrowser:async options=>{browserActions.push(options.action);return options.action.type==='screenshot'?{image:'/9j/AA=='}:{clicked:true};},
 });
 assert.deepEqual(browserActions,[{type:'click',x:20,y:30},{type:'screenshot'}]);
 assert.deepEqual(calls.find(item=>item.path==='jobs/acp-live/browser-frame')?.body,{lease:'live-lease',image:'/9j/AA=='});
});
test('local ACP browser accepts requester control only while its controller lease is live',async()=>{
 const calls=[],browserActions=[];let delivered=false;
 await processOne(async(path,body)=>{
  calls.push({path,body});
  if(path==='claim')return{job:{id:'acp-control',lease:'control-lease',payload:{acp:true,browserTools:true,agentKey:'codex',browserIdentity:'agent-1',workspaceId:'org-1',prompt:'Open the release notes'}}};
  if(path==='jobs/acp-control/browser-frame'&&body.poll){if(delivered)return{controls:[]};delivered=true;return{controls:[{action:{type:'click',x:42,y:84},controllerId:'controller-1',expiresAt:Date.now()+30000}]};}
  return{ok:true};
 },{
  browserControlPollIntervalMs:2,
  runAcpAgent:async(_payload,{browserCall,signal})=>{await browserCall({type:'screenshot'},{signal});await new Promise(resolve=>setTimeout(resolve,15));return{status:'succeeded',stdout:'{}',stderr:'',exitCode:0};},
  runBrowser:async options=>{browserActions.push(options.action);return options.action.type==='screenshot'?{image:'/9j/AA=='}:{clicked:true};},
 });
 assert.ok(browserActions.some(action=>action.type==='click'&&action.x===42&&action.y===84));
 assert.ok(calls.some(item=>item.path==='jobs/acp-control/browser'&&item.body.lease==='control-lease'));
 assert.ok(calls.some(item=>item.path==='jobs/acp-control/browser'&&item.body.controllerId==='controller-1'));
 assert.ok(calls.some(item=>item.path==='jobs/acp-control/browser-frame'&&item.body.image==='/9j/AA=='));
 assert.equal(calls.at(-1).path,'jobs/acp-control/finish');
});
test('a controller disconnected after polling cannot dispatch its queued browser action',async()=>{
 const calls=[];let delivered=false,signalControlCheck;
 const controlCheck=new Promise(resolve=>{signalControlCheck=resolve;});
 await processOne(async(path,body)=>{
  calls.push({path,body});
  if(path==='claim')return{job:{id:'acp-stale-control',lease:'control-lease',payload:{acp:true,browserTools:true,agentKey:'codex',browserIdentity:'agent-1',workspaceId:'org-1',prompt:'Open the release notes'}}};
  if(path==='jobs/acp-stale-control/browser-frame'&&body.poll){if(delivered)return{controls:[]};delivered=true;return{controls:[{action:{type:'click',x:42,y:84},controllerId:'controller-gone',expiresAt:Date.now()+30000}]};}
  if(path==='jobs/acp-stale-control/browser'&&body.controllerId){signalControlCheck();throw Object.assign(new Error('control released'),{status:403});}
  return{ok:true};
 },{
  browserControlPollIntervalMs:2,
  runAcpAgent:async()=>{await controlCheck;return{status:'succeeded',stdout:'done',stderr:'',exitCode:0};},
  runBrowser:async()=>assert.fail('a disconnected controller action must not reach the browser'),
 });
 assert.equal(calls.at(-1).path,'jobs/acp-stale-control/finish');
 assert.equal(calls.some(item=>item.path==='jobs/acp-stale-control/browser-frame'&&item.body.image),false);
});
test('agent and requester browser actions never overlap and requester control runs before the next agent action',async()=>{
 const calls=[],order=[];let delivered=false,active=0,maxActive=0;
 let releaseAgent,releaseHuman;
 const agentStarted=new Promise(resolve=>{releaseAgent=()=>resolve()});
 const humanStarted=new Promise(resolve=>{releaseHuman=()=>resolve()});
 let signalAgentStarted,signalHumanStarted,signalPolled;
 const agentActionStarted=new Promise(resolve=>{signalAgentStarted=resolve});
 const humanActionStarted=new Promise(resolve=>{signalHumanStarted=resolve});
 const controlWasPolled=new Promise(resolve=>{signalPolled=resolve});
 const done=processOne(async(path,body)=>{
  calls.push({path,body});
  if(path==='claim')return{job:{id:'acp-exclusive',lease:'exclusive-lease',payload:{acp:true,browserTools:true,agentKey:'codex',browserIdentity:'agent-1',workspaceId:'org-1',prompt:'Open the release notes'}}};
  if(path==='jobs/acp-exclusive/browser-frame'&&body.poll){signalPolled();if(delivered)return{controls:[]};delivered=true;return{controls:[{action:{type:'click',x:42,y:84},controllerId:'controller-exclusive',expiresAt:Date.now()+30000}]};}
  return{ok:true};
 },{
  browserControlPollIntervalMs:2,
  runAcpAgent:async(_payload,{browserCall,signal})=>{
   await browserCall({type:'click',x:10,y:10},{signal});
   await browserCall({type:'click',x:30,y:30},{signal});
   return{status:'succeeded',stdout:'{}',stderr:'',exitCode:0};
  },
  runBrowser:async({action})=>{
   active++;maxActive=Math.max(maxActive,active);
   if(action.type==='click'&&action.x===10){order.push('agent-first');signalAgentStarted();await agentStarted;}
   else if(action.type==='click'&&action.x===42){order.push('requester');signalHumanStarted();await humanStarted;}
   else if(action.type==='click'&&action.x===30)order.push('agent-next');
   active--;
   return action.type==='screenshot'?{image:'/9j/AA=='}:{clicked:true};
  },
 });
 await agentActionStarted;
 await controlWasPolled;
 assert.deepEqual(order,['agent-first']);
 releaseAgent();
 await humanActionStarted;
 assert.deepEqual(order,['agent-first','requester']);
 assert.equal(active,1);
 releaseHuman();
 await done;
 assert.deepEqual(order,['agent-first','requester','agent-next']);
 assert.equal(maxActive,1);
 assert.equal(active,0);
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

test('ACP configuration is resolved locally and permission requests follow the local policy',async()=>{
 const {execPath}=await import('node:process');
 const script=`const r=require('node:readline').createInterface({input:process.stdin}),s=x=>process.stdout.write(JSON.stringify(x)+'\\n');let p;r.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')s({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(m.method==='session/new')s({jsonrpc:'2.0',id:m.id,result:{sessionId:'s'}});if(m.method==='session/prompt'){p=m.id;s({jsonrpc:'2.0',id:88,method:'session/request_permission',params:{toolCall:{kind:process.env.TOOL_KIND||'execute'},options:['allow_once','allow_always','reject_once','reject_always'].map((kind,i)=>({kind,optionId:['allow-once','allow-always','reject-once','reject-always'][i]}))}})}if(m.id===88){s({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId}}}});s({jsonrpc:'2.0',id:p,result:{stopReason:'end_turn'}})}});`;
 // This fixture intentionally emits the permission request before its turn result.
 const result=await runAcp({agentKey:'local-test',prompt:'Do the task'}, {timeoutMs:5000,acpAgents:{'local-test':{command:execPath,args:['-e',script],cwd:process.cwd()}}});
 assert.equal(result.status,'succeeded');
 assert.equal(JSON.parse(result.stdout).text,'allow-once');
 const strictBase={command:execPath,args:['-e',script],cwd:process.cwd(),env:{TOOL_KIND:'execute'},permissionPolicy:'strict'};
 const strict=await runAcp({agentKey:'local-test',prompt:'Do the task'}, {timeoutMs:5000,acpAgents:{'local-test':strictBase}});
 assert.equal(strict.status,'succeeded');
 assert.equal(JSON.parse(strict.stdout).text,'reject-once');
 const strictRead=await runAcp({agentKey:'local-test',prompt:'Do the task'}, {timeoutMs:5000,acpAgents:{'local-test':{...strictBase,env:{TOOL_KIND:'read'}}}});
 assert.equal(strictRead.status,'succeeded');
 assert.equal(JSON.parse(strictRead.stdout).text,'allow-once');
 await assert.rejects(runAcp({agentKey:'../attacker',prompt:'Do the task'}, {acpAgents:{}}),/Unknown local ACP agent/);
});

test('virtual files are bounded canonical relative paths with no payload authority overrides',()=>{
 const files=[{path:'src/main.js',base64:Buffer.from('return 42').toString('base64')}];
 assert.deepEqual(validatePayload({code:'return 42',files,command:'sh',image:'evil',mounts:['/'],environment:{PATH:'/tmp'}}),{code:'return 42',input:null,files});
 assert.throws(()=>validateFiles([{path:'../secret',base64:'eA=='}]),/path/);
 assert.throws(()=>validateFiles([{path:'/etc/passwd',base64:'eA=='}]),/path/);
 assert.throws(()=>validateFiles([{path:'a\\\\b',base64:'eA=='}]),/path/);
 assert.throws(()=>validateFiles([{path:'a',base64:'eA==',target:'/tmp'}]),/file/);
 assert.throws(()=>validateFiles([{path:'a',base64:'eA=='} ,{path:'a/b',base64:'eA=='}]),/Conflicting/);
 assert.throws(()=>validateFiles([{path:'a',base64:'eA=='} ,{path:'a',base64:'eA=='}]),/Duplicate/);
 assert.throws(()=>validateFiles([{path:'a',base64:'!!!!'}]),/encoding/);
 assert.throws(()=>validateFiles([{path:'a',base64:'Zh=='}]),/encoding/);
 assert.throws(()=>validateFiles(Array.from({length:9},(_,i)=>({path:'f'+i,base64:''}))),/files/);
 assert.throws(()=>validateFiles([{path:'a',base64:Buffer.alloc(256*1024+1).toString('base64')}]),/large/);
 const args=containerArgs('honmaru-12345678-1234-1234-1234-123456789abc');
 assert.equal(args[args.indexOf('--tmpfs')+1],'/tmp:size=16M,mode=1777');
 assert.ok(!args.some(a=>a.includes('/Users')||a==='--volume'||a==='--mount'));
});

test('each virtual-file run removes its isolated tmpfs after success, failure, and cancellation',async()=>{
 for(const mode of ['success','failure','cancel']){
  const controls=[];let taskJson='', activeChild;
  const spawnProcess=(_binary,args,options)=>{
   if(args[0]==='delete') throw Error('delete is managed through controlProcess');
   const child=new EventEmitter();activeChild=child;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
   child.kill=()=>{setImmediate(()=>child.emit('close',137));};
   child.stdin.on('data',chunk=>taskJson+=chunk.toString());
   child.stdin.on('end',()=>{
    setImmediate(()=>{
     if(mode==='cancel') signalController.abort();
     else child.emit('close',mode==='success'?0:1);
    });
   });
   return child;
  };
  const signalController=new AbortController();
  const controlProcess=async(_binary,args)=>{controls.push(args);if(args[0]==='kill')setImmediate(()=>activeChild.emit('close',137));};
  const signal=mode==='cancel'?signalController.signal:undefined;
  const result=await runIsolated({code:'return 1',files:[{path:'input.txt',base64:'eA=='}]}, {spawnProcess,controlProcess,signal});
  assert.equal(result.status,mode==='success'?'succeeded':'failed');
  assert.deepEqual(controls.at(-1)?.slice(0,2),['delete','--force']);
  assert.ok(taskJson.includes('"files":[{"path":"input.txt","base64":"eA=="}]'));
 }
});
