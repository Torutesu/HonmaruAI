import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcp, configuredAcpAgentIds, validateAcpAgents } from '../acp.mjs';

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

test('ACP agent launch settings must be local and valid', () => {
  assert.throws(() => validateAcpAgents({ bad: { command: 'node', args: [], cwd: '/tmp' } }), /Unknown local ACP agent/);
  assert.throws(() => validateAcpAgents({ bad: { command: '/usr/bin/node', args: ['x'], cwd: '/tmp', env: { PATH: 1 } } }), /Invalid local ACP agent configuration/);
  assert.throws(() => validateAcpAgents(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`agent-${i}`, { command: '/usr/bin/node', args: [], cwd: '/tmp' }]))), /at most 20/);
});
