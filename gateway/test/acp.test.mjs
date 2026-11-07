import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcp, configuredAcpAgentIds, validateAcpAgents } from '../acp.mjs';
import { processOne } from '../client.mjs';

let directory;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

test('ACP v1 keeps host capabilities disabled, reuses agent-owned auth, and preserves context blocks', async () => {
  directory = await mkdtemp(join(tmpdir(), 'honmaru-acp-'));
  const agentFile = join(directory, 'agent.mjs');
  await writeFile(agentFile, `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    const write = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
    let capabilities = null, sessionParams = null, authenticateCalled = false;
    for await (const line of input) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        capabilities = message.params.clientCapabilities;
        write({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:'local-sign-in',type:'agent'}]}});
      }
      if (message.method === 'authenticate') {
        authenticateCalled = true;
        write({jsonrpc:'2.0',id:message.id,result:{}});
      }
      if (message.method === 'session/new') {
        sessionParams = message.params;
        write({jsonrpc:'2.0',id:message.id,result:{sessionId:'fixture-session'}});
      }
      if (message.method === 'session/prompt') {
        const observed = {capabilities,sessionParams,prompt:message.params.prompt,authenticateCalled};
        write({jsonrpc:'2.0',method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(observed)}}}});
        write({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});
      }
    }
  `);
  const acpAgents = { fixture: { command: process.execPath, args: [agentFile], cwd: directory } };
  assert.deepEqual(configuredAcpAgentIds(acpAgents), ['fixture']);
  const result = await runAcp({ acp: true, agentKey: 'fixture', prompt: 'Say hello', context: ['Earlier note', 'Last reply'] }, { acpAgents, timeoutMs: 5000 });
  assert.equal(result.status, 'succeeded');
  const output = JSON.parse(result.stdout);
  const observed = JSON.parse(output.text);
  assert.equal(output.sessionId, 'fixture-session');
  assert.deepEqual(observed.capabilities, { fs: false, terminal: false });
  assert.deepEqual(observed.sessionParams, { cwd: directory, mcpServers: [] });
  assert.deepEqual(observed.prompt, [
    { type: 'text', text: 'Earlier conversation:\nEarlier note\nLast reply' },
    { type: 'text', text: 'Say hello' },
  ]);
  assert.equal(observed.authenticateCalled, false);
});

test('ACP Workspace tools use the short-lived local MCP relay only when explicitly enabled', async () => {
  directory = await mkdtemp(join(tmpdir(), 'honmaru-acp-mcp-'));
  const agentFile = join(directory, 'agent.mjs');
  await writeFile(agentFile, `
    import { spawn } from 'node:child_process';
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    const write = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
    let bridge, bridgeBuffer = '', nextId = 1;
    const pending = new Map();
    const bridgeRequest = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params}) + String.fromCharCode(10));
    });
    for await (const line of input) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') write({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
      if (message.method === 'session/new') {
        const server = message.params.mcpServers[0];
        const serverEnv = Object.fromEntries((server?.env || []).map(({name,value}) => [name,value]));
        if (!server || !serverEnv.HONMARU_ACP_MCP_URL.startsWith('http://127.0.0.1:') || !serverEnv.HONMARU_ACP_MCP_TOKEN) throw new Error('invalid MCP bridge config');
        bridge = spawn(server.command, server.args, {env:{...process.env,...serverEnv},stdio:['pipe','pipe','ignore']});
        bridge.stdout.setEncoding('utf8');
        bridge.stdout.on('data', chunk => {
          bridgeBuffer += chunk;
          for (;;) { const end=bridgeBuffer.indexOf(String.fromCharCode(10)); if(end<0)break; const item=JSON.parse(bridgeBuffer.slice(0,end)); bridgeBuffer=bridgeBuffer.slice(end+1); const waiter=pending.get(item.id); if(waiter){pending.delete(item.id); item.error?waiter.reject(new Error(item.error.message)):waiter.resolve(item.result);} }
        });
        const init = await bridgeRequest('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
        bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}) + String.fromCharCode(10));
        const listed = await bridgeRequest('tools/list');
        const called = await bridgeRequest('tools/call',{name:'read_app',arguments:{appId:'synthetic-app'}});
        write({jsonrpc:'2.0',id:message.id,result:{sessionId:'fixture-session'}});
        globalThis.observed={servers:message.params.mcpServers,init,listed,called};
      }
      if (message.method === 'session/prompt') {
        write({jsonrpc:'2.0',method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(globalThis.observed)}}}});
        write({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}});
        bridge?.kill('SIGTERM');
      }
    }
  `);
  const acpAgents = { fixture: { command: process.execPath, args: [agentFile], cwd: directory } };
  const calls = [];
  const result = await runAcp({ acp: true, agentKey: 'fixture', prompt: 'Summarize the app', workspaceTools: true }, {
    acpAgents,
    timeoutMs: 7000,
    mcpCall: async (method, params) => {
      calls.push({method,params});
      if (method === 'tools/list') return {tools:[{name:'read_app'}]};
      return {content:[{type:'text',text:'synthetic only'}],structuredContent:{app:{id:params.arguments.appId}}};
    },
  });
  assert.equal(result.status, 'succeeded');
  const observed=JSON.parse(JSON.parse(result.stdout).text);
  assert.equal(observed.servers.length,1);
  assert.equal(observed.servers[0].name,'honmaru-workspace');
  assert.deepEqual(observed.init.capabilities,{tools:{listChanged:false}});
  assert.deepEqual(observed.listed,{tools:[{name:'read_app'}]});
  assert.deepEqual(observed.called.structuredContent,{app:{id:'synthetic-app'}});
  assert.deepEqual(calls,[
    {method:'tools/list',params:{}},
    {method:'tools/call',params:{name:'read_app',arguments:{appId:'synthetic-app'}}},
  ]);
});

test('cancelling one local ACP job suppresses its late reply without stopping another job', async () => {
  directory = await mkdtemp(join(tmpdir(), 'honmaru-acp-cancel-'));
  const agentFile = join(directory, 'agent.mjs');
  const eventsFile = join(directory, 'events.jsonl');
  await writeFile(agentFile, `
    import { appendFileSync } from 'node:fs';
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    const record = event => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(event) + String.fromCharCode(10));
    const write = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
    let promptId = null, sessionId = null;
    write({jsonrpc:'2.0',method:'fixture/started',params:{pid:process.pid}});
    for await (const line of input) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') write({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
      if (message.method === 'session/new') {
        sessionId = 'fixture-' + process.pid;
        write({jsonrpc:'2.0',id:message.id,result:{sessionId}});
        record({type:'session',sessionId,pid:process.pid});
      }
      if (message.method === 'session/prompt') {
        promptId = message.id;
        const blocks = message.params.prompt || [];
        const label = String(blocks.at(-1)?.text || '').trim();
        record({type:'prompt',label,id:promptId,sessionId,pid:process.pid});
        if (label === 'job-b') {
          setTimeout(() => {
            write({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'job-b-result'}}}});
            write({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
          }, 180);
        }
      }
      if (message.method === 'session/cancel') {
        record({type:'session-cancel',sessionId:message.params.sessionId,pid:process.pid});
        // Model a provider that races cancellation and returns a normal
        // completion. Honmaru must discard it after the exact job was stopped.
        write({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'job-a-late-result'}}}});
        write({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
      }
      if (message.method === '$/cancel_request') record({type:'request-cancel',id:message.params.id,pid:process.pid});
    }
  `);

  const waitForEvents = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const events = (await readFile(eventsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (predicate(events)) return events;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const events = (await readFile(eventsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.fail(`Timed out waiting for fake ACP events: ${JSON.stringify({events,finishes})}`);
  };
  const waitForProcessExit = async pid => {
    const target = process.platform === 'win32' ? pid : -pid;
    const exists = () => {
      try { process.kill(target, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
    };
    const deadline = Date.now() + 2000;
    while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(exists(), false, `ACP process group ${pid} must exit without leaving a child behind`);
  };

  const acpAgents = { fixture: { command: process.execPath, args: [agentFile], cwd: directory, env: { FIXTURE_EVENTS: eventsFile } } };
  let nextJob = 0;
  const finishes = [];
  const call = async (path, body = {}) => {
    if (path === 'claim') {
      const id = nextJob++ === 0 ? 'job-a' : 'job-b';
      return { job: { id, lease: `lease-${id}`, payload: { acp: true, agentKey: 'fixture', prompt: id }, timeoutMs: 5000 } };
    }
    if (path.endsWith('/heartbeat')) {
      const jobId = path.split('/')[1];
      if (jobId === 'job-a') {
        await waitForEvents(events => events.some(event => event.type === 'prompt' && event.label === 'job-a'));
        throw Object.assign(new Error('Job lease was cancelled.'), { status: 409, code: 'cancelled' });
      }
      return {};
    }
    if (path.endsWith('/finish')) {
      finishes.push({ jobId: path.split('/')[1], ...body });
      return {};
    }
    throw new Error(`Unexpected fake gateway request: ${path}`);
  };

  const [jobA, jobB] = await Promise.all([
    processOne(call, { acpAgents, heartbeatIntervalMs: 5, heartbeatGraceMs: 100 }),
    processOne(call, { acpAgents, heartbeatIntervalMs: 5, heartbeatGraceMs: 100 }),
  ]);
  assert.equal(jobA, true);
  assert.equal(jobB, true);

  const events = await waitForEvents(items => items.some(event => event.type === 'session-cancel' && event.sessionId) && items.some(event => event.type === 'request-cancel'));
  const cancelledPrompt = events.find(event => event.type === 'prompt' && event.label === 'job-a');
  assert.ok(cancelledPrompt);
  assert.ok(events.some(event => event.type === 'session-cancel' && event.sessionId === cancelledPrompt.sessionId));
  assert.ok(events.some(event => event.type === 'request-cancel' && event.id === cancelledPrompt.id));
  assert.equal(finishes.filter(result => result.jobId === 'job-a').length, 0, 'cancelled job must not send a late finish/reply');
  assert.deepEqual(finishes.filter(result => result.jobId === 'job-b').map(result => ({ status: result.status, exitCode: result.exitCode, text: JSON.parse(result.stdout).text })), [
    { status: 'succeeded', exitCode: 0, text: 'job-b-result' },
  ]);
  const prompts = events.filter(event => event.type === 'prompt');
  await Promise.all(prompts.map(event => waitForProcessExit(event.pid)));
});

test('a nonresponsive local ACP agent is force-stopped after the cancellation grace', async () => {
  directory = await mkdtemp(join(tmpdir(), 'honmaru-acp-cancel-timeout-'));
  const agentFile = join(directory, 'agent.mjs');
  const eventsFile = join(directory, 'events.jsonl');
  await writeFile(agentFile, `
    import { appendFileSync } from 'node:fs';
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    const record = event => appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify(event) + String.fromCharCode(10));
    const write = message => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
    let promptId = null, sessionId = null;
    process.on('SIGTERM', () => record({type:'term',pid:process.pid}));
    for await (const line of input) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') write({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
      if (message.method === 'session/new') {
        sessionId = 'timeout-' + process.pid;
        write({jsonrpc:'2.0',id:message.id,result:{sessionId}});
      }
      if (message.method === 'session/prompt') {
        promptId = message.id;
        record({type:'prompt',id:promptId,sessionId,pid:process.pid});
      }
      if (message.method === 'session/cancel') record({type:'session-cancel',sessionId:message.params.sessionId,pid:process.pid});
      if (message.method === '$/cancel_request') record({type:'request-cancel',id:message.params.id,pid:process.pid});
    }
  `);

  const waitForEvents = async predicate => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const events = (await readFile(eventsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (predicate(events)) return events;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out waiting for nonresponsive fake ACP events.');
  };
  const acpAgents = { fixture: { command: process.execPath, args: [agentFile], cwd: directory, env: { FIXTURE_EVENTS: eventsFile } } };
  const controller = new AbortController();
  const started = Date.now();
  const pending = runAcp({ agentKey: 'fixture', prompt: 'keep running' }, { acpAgents, signal: controller.signal, timeoutMs: 5000 });
  const prompt = (await waitForEvents(events => events.some(event => event.type === 'prompt'))).find(event => event.type === 'prompt');
  controller.abort();
  await assert.rejects(pending);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1700 && elapsed < 3500, `expected the bounded grace and force-stop, got ${elapsed} ms`);
  const events = await waitForEvents(items => items.some(event => event.type === 'session-cancel') && items.some(event => event.type === 'request-cancel') && items.some(event => event.type === 'term'));
  assert.ok(events.some(event => event.type === 'session-cancel' && event.sessionId === prompt.sessionId));
  assert.ok(events.some(event => event.type === 'request-cancel' && event.id === prompt.id));
  await new Promise(resolve => setTimeout(resolve, 10));
  try { process.kill(process.platform === 'win32' ? prompt.pid : -prompt.pid, 0); assert.fail(`ACP process group ${prompt.pid} leaked`); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
});

test('ACP agent launch settings must be local and valid', () => {
  assert.throws(() => validateAcpAgents({ bad: { command: 'node', args: [], cwd: '/tmp' } }), /Unknown local ACP agent/);
  assert.throws(() => validateAcpAgents({ bad: { command: '/usr/bin/node', args: ['x'], cwd: '/tmp', env: { PATH: 1 } } }), /Invalid local ACP agent configuration/);
  assert.throws(() => validateAcpAgents(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`agent-${i}`, { command: '/usr/bin/node', args: [], cwd: '/tmp' }]))), /at most 20/);
});
