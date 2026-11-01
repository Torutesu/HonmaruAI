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

test('ACP agent launch settings must be local and valid', () => {
  assert.throws(() => validateAcpAgents({ bad: { command: 'node', args: [], cwd: '/tmp' } }), /Unknown local ACP agent/);
  assert.throws(() => validateAcpAgents({ bad: { command: '/usr/bin/node', args: ['x'], cwd: '/tmp', env: { PATH: 1 } } }), /Invalid local ACP agent configuration/);
  assert.throws(() => validateAcpAgents(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`agent-${i}`, { command: '/usr/bin/node', args: [], cwd: '/tmp' }]))), /at most 20/);
});
