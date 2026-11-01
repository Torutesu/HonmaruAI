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

test('ACP v1 initializes, opens a local session, and returns streamed assistant text', async () => {
  directory = await mkdtemp(join(tmpdir(), 'honmaru-acp-'));
  const agentFile = join(directory, 'agent.mjs');
  await writeFile(agentFile, `
    import readline from 'node:readline';
    const input = readline.createInterface({ input: process.stdin });
    for await (const line of input) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
      if (message.method === 'session/new') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{sessionId:'fixture-session'}})+'\\n');
      if (message.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:message.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP response'}}}})+'\\n');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}})+'\\n');
      }
    }
  `);
  const acpAgents = { fixture: { command: process.execPath, args: [agentFile], cwd: directory } };
  assert.deepEqual(configuredAcpAgentIds(acpAgents), ['fixture']);
  const result = await runAcp({ acp: true, agentKey: 'fixture', prompt: 'Say hello' }, { acpAgents, timeoutMs: 5000 });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(JSON.parse(result.stdout), { text: 'ACP response', sessionId: 'fixture-session', stopReason: 'end_turn' });
});

test('ACP agent launch settings must be local and valid', () => {
  assert.throws(() => validateAcpAgents({ bad: { command: 'node', args: [], cwd: '/tmp' } }), /Unknown local ACP agent/);
  assert.throws(() => validateAcpAgents({ bad: { command: '/usr/bin/node', args: ['x'], cwd: '/tmp', env: { PATH: 1 } } }), /Invalid local ACP agent configuration/);
  assert.throws(() => validateAcpAgents(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`agent-${i}`, { command: '/usr/bin/node', args: [], cwd: '/tmp' }]))), /at most 20/);
});
