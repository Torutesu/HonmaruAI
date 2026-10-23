import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { addAgentMemory, listAgentMemories, deleteAgentMemory, prepareAgent, filterResponders } from '../src/harness/agents.js';

const org = 'memory-scope';
const agent = 'a';
test('room and DM memories stay in their source conversation; shared knowledge remains shared', async () => {
  await addAgentMemory(env.DB, org, agent, 'Shared context');
  await addAgentMemory(env.DB, org, agent, 'Private financial detail', { channel: 'b:finance', kind: 'reference' });
  await addAgentMemory(env.DB, org, agent, 'Private preference', { channel: 'dm:a|b', kind: 'preference' });
  const texts = async (channel) => (await listAgentMemories(env.DB, org, agent, { channel })).map(m => m.text);
  expect(await texts('b:finance')).toEqual(expect.arrayContaining(['Shared context', 'Private financial detail']));
  expect(await texts('b:sales')).toEqual(['Shared context']);
  expect(await texts('')).toEqual(['Shared context']);
  expect(await texts('dm:a|b')).toEqual(expect.arrayContaining(['Shared context', 'Private preference']));
  expect(await listAgentMemories(env.DB, 'other', agent, { channel: 'b:finance' })).toEqual([]);
  const prepared = await prepareAgent(env, org, { id: agent, instructions: 'Help' }, null, { channel: 'b:sales' });
  expect(prepared.agent.instructions).not.toContain('Private financial detail');
});

test('deduplication and deletion do not cross conversation boundaries', async () => {
  const first = await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:one' });
  const second = await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:two' });
  expect(first.memory.id).not.toBe(second.memory.id);
  expect((await addAgentMemory(env.DB, org, agent, 'Same text', { channel: 'b:one' })).duplicate).toBe(true);
  expect((await deleteAgentMemory(env.DB, org, agent, first.memory.id, { channel: 'b:two' })).deleted).toBe(0);
  expect((await deleteAgentMemory(env.DB, org, agent, '*', { channel: 'b:two' })).deleted).toBe(1);
  expect((await listAgentMemories(env.DB, org, agent, { channel: 'b:one' })).length).toBe(1);
});

test('legacy memories remain readable without rewriting existing data', async () => {
  await env.DB.prepare('INSERT INTO hx_agent_memories (id, org_id, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind('legacy', org, agent, 'Legacy', new Date().toISOString()).run();
  expect((await listAgentMemories(env.DB, org, agent, { channel: 'b:one' }))[0].text).toBe('Legacy');
});

test('unprofiled personal agents are still private', async () => {
  expect(await filterResponders(env.DB, org, 'outsider', [{ id: agent, scope: 'personal', ownerLogin: 'owner' }])).toEqual([]);
});

test('deferred conversation checks accept canonical DMs only for their current members', async () => {
  const { mayUseConversation } = await import('../src/harness/conversationAccess.js');
  const { upsertUser, upsertMembership } = await import('../src/db.js');
  for (const id of ['alice', 'bob', 'outsider']) {
    await upsertUser(env.DB, { githubId: id, login: id, name: id });
    await upsertMembership(env.DB, org, id, 'member');
  }
  expect(await mayUseConversation(env.DB, org, 'alice', 'dm:alice|bob')).toBe(true);
  expect(await mayUseConversation(env.DB, org, 'outsider', 'dm:alice|bob')).toBe(false);
  await env.DB.prepare('DELETE FROM memberships WHERE org_id = ?1 AND user_github_id = ?2').bind(org, 'alice').run();
  expect(await mayUseConversation(env.DB, org, 'alice', 'dm:alice|bob')).toBe(false);
});

test('adding beyond the recent memory index never deletes saved entries or their full bodies', async () => {
  const old = await addAgentMemory(env.DB, org, agent, {title:'Retained policy',description:'Long-term reference',body:'Original policy body'}, {channel:'b:ops',kind:'reference'});
  await env.DB.prepare('UPDATE hx_agent_memories SET created_at=?1 WHERE org_id=?2 AND id=?3').bind('2020-01-01T00:00:00Z',org,old.memory.id).run();
  const writes=[];
  for(let i=0;i<200;i++) {
    writes.push(env.DB.prepare('INSERT INTO hx_agent_memories (id,org_id,agent_id,text,created_at) VALUES (?1,?2,?3,?4,?5)').bind(`retained_${i}`,org,agent,`Note ${i}`,'2026-01-01T00:00:00Z'));
    writes.push(env.DB.prepare('INSERT INTO hx_memory_scopes (memory_id,org_id,channel,kind) VALUES (?1,?2,?3,?4)').bind(`retained_${i}`,org,'b:ops','context'));
  }
  await env.DB.batch(writes);
  await addAgentMemory(env.DB,org,agent,'Newest note',{channel:'b:ops'});
  const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_agent_memories WHERE org_id=?1 AND agent_id=?2').bind(org,agent).first();
  expect(count.n).toBe(202);
  expect(await env.DB.prepare('SELECT body FROM hx_memory_entries WHERE org_id=?1 AND memory_id=?2').bind(org,old.memory.id).first()).toEqual({body:'Original policy body'});
  expect(await listAgentMemories(env.DB,org,agent,{channel:'b:ops'})).toHaveLength(200);
  const repeated=await addAgentMemory(env.DB,org,agent,{title:'Retained policy',description:'Long-term reference',body:'Original policy body'},{channel:'b:ops',kind:'reference'});
  expect(repeated.duplicate).toBe(true);
  expect(repeated.memory.id).toBe(old.memory.id);
});

test('memory management pages include retained notes without crossing scope and bind cursors', async () => {
  const {memoryPage}=await import('../src/harness/memoryEntries.js');
  const writes=[];
  for(let i=0;i<205;i++) {
    writes.push(env.DB.prepare('INSERT INTO hx_agent_memories (id,org_id,agent_id,text,created_at) VALUES (?1,?2,?3,?4,?5)').bind(`page_${String(i).padStart(3,'0')}`,org,agent,`Saved ${i}`,'2026-01-01T00:00:00Z'));
    writes.push(env.DB.prepare('INSERT INTO hx_memory_scopes (memory_id,org_id,channel,kind) VALUES (?1,?2,?3,?4)').bind(`page_${String(i).padStart(3,'0')}`,org,i===0?'b:private':'','context'));
  }
  await env.DB.batch(writes);
  let cursor, ids=[];
  do {
    const page=await memoryPage(env.DB,org,agent,{cursor});
    expect(page.memories.length).toBeLessThanOrEqual(50);
    ids.push(...page.memories.map(m=>m.id));
    cursor=page.nextCursor;
  } while(cursor);
  expect(ids).toHaveLength(204);
  expect(new Set(ids).size).toBe(204);
  expect(ids).not.toContain('page_000');
  const first=await memoryPage(env.DB,org,agent);
  for(const [workspace,agentId,channel] of [['other',agent,''],[org,'other',''],[org,agent,'b:private']]) {
    expect(await memoryPage(null,workspace,agentId,{channel,cursor:first.nextCursor})).toMatchObject({status:400});
  }
  expect(await memoryPage(null,org,agent,{cursor:'invalid'})).toMatchObject({status:400});
});

test('memory management search uses full saved bodies and intersects kind with authorized scope', async()=>{
 const {memoryPage}=await import('../src/harness/memoryEntries.js');
 await addAgentMemory(env.DB,org,agent,{title:'Old policy',description:'Finance',body:'x'.repeat(600)+' retained target'},{kind:'reference'});
 await addAgentMemory(env.DB,org,agent,'retained target',{kind:'feedback'});
 await addAgentMemory(env.DB,org,agent,'retained target secret',{kind:'reference',channel:'b:private'});
 const found=await memoryPage(env.DB,org,agent,{query:'RETAINED TARGET',kind:'reference'});
 expect(found.memories).toHaveLength(1);
 expect(found.memories[0].title).toBe('Old policy');
 expect(await memoryPage(null,org,agent,{query:'x'.repeat(201)})).toMatchObject({status:400});
 expect(await memoryPage(null,org,agent,{kind:'unknown'})).toMatchObject({status:400});
 const cursor=JSON.stringify([org,agent,'','old','reference','2026-01-01T00:00:00Z','id']);
 expect(await memoryPage(null,org,agent,{query:'new',kind:'reference',cursor})).toMatchObject({status:400});
});

test('review records evidence for the checked memory version, independently of editing',async()=>{
 const {memoryPage,reviewMemoryEntry,updateMemoryEntry}=await import('../src/harness/memoryEntries.js');
 const made=await addAgentMemory(env.DB,org,agent,{title:'Policy',description:'',body:'Original'},{channel:'b:ops'});
 const input={expectedVersion:1,evidence:'Confirmed with the owner'};
 expect(await reviewMemoryEntry(env.DB,org,agent,made.memory.id,input,{channel:'b:other',by:'reviewer'})).toMatchObject({status:409});
 expect(await reviewMemoryEntry(env.DB,'other',agent,made.memory.id,input,{channel:'b:ops',by:'reviewer'})).toMatchObject({status:409});
 const checked=await reviewMemoryEntry(env.DB,org,agent,made.memory.id,input,{channel:'b:ops',by:'reviewer'});
 expect(checked.review.evidence).toBe(input.evidence);
 const before=(await memoryPage(env.DB,org,agent,{channel:'b:ops'})).memories[0];
 expect(before.review.current).toBe(true);
 expect(before.version).toBe(1);
 await updateMemoryEntry(env.DB,org,agent,made.memory.id,{expectedVersion:1,title:'Policy',description:'',body:'Changed',kind:'context'},{channel:'b:ops',by:'editor'});
 const after=(await memoryPage(env.DB,org,agent,{channel:'b:ops'})).memories[0];
 expect(after.review.current).toBe(false);
 expect(after.review.at).toBe(before.review.at);
 expect(await reviewMemoryEntry(env.DB,org,agent,made.memory.id,input,{channel:'b:ops',by:'reviewer'})).toMatchObject({status:409});
 expect(await reviewMemoryEntry(env.DB,org,agent,made.memory.id,{...input,expectedVersion:2,evidence:' '},{channel:'b:ops',by:'reviewer'})).toMatchObject({status:400});
 expect((await reviewMemoryEntry(env.DB,org,agent,made.memory.id,{...input,expectedVersion:2},{channel:'b:ops',by:'reviewer'})).review.version).toBe(2);
});


test('unsupported review verdicts are rejected before reading or changing memory',async()=>{
 const {reviewMemoryEntry}=await import('../src/harness/memoryEntries.js');
 for(const verdict of ['update','delete','unknown']) {
  expect(await reviewMemoryEntry(null,org,agent,'m',{verdict,expectedVersion:1,evidence:'Checked'},{by:'owner'})).toMatchObject({status:400});
 }
});

test('successful reviews append history while stale or out-of-scope attempts append nothing',async()=>{
 const {reviewMemoryEntry}=await import('../src/harness/memoryEntries.js');
 const made=await addAgentMemory(env.DB,org,agent,'Durable policy');
 const review=(evidence,expectedVersion=0,channel='')=>reviewMemoryEntry(env.DB,org,agent,made.memory.id,{evidence,expectedVersion},{channel,by:'owner'});
 expect((await review('First check')).review.evidence).toBe('First check');
 expect((await review('Second check')).review.evidence).toBe('Second check');
 expect(await review('Stale',1)).toMatchObject({status:409});
 expect(await review('Wrong scope',0,'b:other')).toMatchObject({status:409});
 const history=await env.DB.prepare('SELECT evidence FROM hx_memory_review_history WHERE org_id=?1 AND memory_id=?2').bind(org,made.memory.id).all();
 expect(history.results.map(r=>r.evidence).sort()).toEqual(['First check','Second check']);
 const latest=await env.DB.prepare('SELECT evidence FROM hx_memory_reviews WHERE org_id=?1 AND memory_id=?2').bind(org,made.memory.id).first();
 expect(latest.evidence).toBe('Second check');
});

test('existing latest reviews are migrated to history once without changing their evidence',async()=>{
 const made=await addAgentMemory(env.DB,org,agent,'Legacy reviewed policy');
 await env.DB.prepare('INSERT INTO hx_memory_reviews (memory_id,org_id,reviewed_version,evidence,reviewed_by,reviewed_at) VALUES (?1,?2,0,?3,?4,?5)').bind(made.memory.id,org,'Original evidence','owner','2026-01-01T00:00:00Z').run();
 const {default:schema}=await import('../schema.sql?raw');
 await env.DB.exec(schema.replace(/\n/g,' '));
 await env.DB.exec(schema.replace(/\n/g,' '));
 const rows=await env.DB.prepare('SELECT evidence,reviewed_at FROM hx_memory_review_history WHERE org_id=?1 AND memory_id=?2').bind(org,made.memory.id).all();
 expect(rows.results).toEqual([{evidence:'Original evidence',reviewed_at:'2026-01-01T00:00:00Z'}]);
});
