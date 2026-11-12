import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { addAgentMemory, listAgentMemories, deleteAgentMemory } from "../src/harness/agents.js";
import { memoryPage, updateMemoryEntry, reviewMemoryEntry, memoryReviewHistory } from "../src/harness/memoryEntries.js";
import { agentMemoryTools } from "../src/harness/memoryReader.js";

const ORG = "personal:memory-person-scope";
let agentId;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { upsertUser, upsertMembership } = await import("../src/db.js");
  for (const [id, login] of [["9211", "owner"], ["9212", "person-a"], ["9213", "person-b"]]) {
    await upsertUser(env.DB, { githubId: id, login, name: login, avatarUrl: null, locale: "en" });
    await upsertMembership(env.DB, ORG, id, "member");
  }
  await env.DB.prepare("INSERT INTO custom_agents (id,org_id,name,handle,instructions,scope,owner_login,created_by_login,created_at,updated_at) VALUES (?1,?2,'Memory agent','memory-agent','Use memory','team','person-a','9212',datetime('now'),datetime('now'))")
    .bind("agent-person-scope", ORG).run();
  agentId = "agent-person-scope";
});

test("person memories stay private across list, page, search, read, edit, review, and delete while shared and room memories remain compatible", async () => {
  const personal = await addAgentMemory(env.DB, ORG, agentId, {
    title: "Person only", description: "private context", body: "The private account phrase"
  }, { by: "9212", userId: "9212", scope: "person", kind: "reference" });
  expect(personal.error).toBeUndefined();
  const personalId = personal.memory.id;
  const shared = await addAgentMemory(env.DB, ORG, agentId, "Shared note", { by: "9212" });
  const room = await addAgentMemory(env.DB, ORG, agentId, "Legacy room note", { by: "9212", channel: "room:legacy" });

  expect((await listAgentMemories(env.DB, ORG, agentId, { userId: "9212" })).map(m => m.id)).toContain(personalId);
  const otherList = await listAgentMemories(env.DB, ORG, agentId, { userId: "9213" });
  expect(otherList.map(m => m.id)).not.toContain(personalId);
  expect(otherList.map(m => m.id)).toContain(shared.memory.id);
  expect((await listAgentMemories(env.DB, ORG, agentId, { userId: "9213", channel: "room:legacy" })).map(m => m.id)).toContain(room.memory.id);

  const otherPage = await memoryPage(env.DB, ORG, agentId, { userId: "9213", query: "private account" });
  expect(otherPage.memories).toHaveLength(0);
  const ownerPage = await memoryPage(env.DB, ORG, agentId, { userId: "9212", query: "private account" });
  expect(ownerPage.memories.map(m => m.id)).toContain(personalId);

  const otherTools = agentMemoryTools(env.DB, ORG, agentId, { userId: "9213", channel: "" });
  const ownerTools = agentMemoryTools(env.DB, ORG, agentId, { userId: "9212", channel: "" });
  expect(JSON.parse(await otherTools.search_agent_memory.run({ query: "private account" })).memories).toHaveLength(0);
  expect(JSON.parse(await ownerTools.search_agent_memory.run({ query: "private account" })).memories.map(m => m.id)).toContain(personalId);
  expect(await otherTools.read_agent_memory.run({ memory_id: personalId })).toBe("Memory unavailable.");
  expect(JSON.parse(await ownerTools.read_agent_memory.run({ memory_id: personalId })).id).toBe(personalId);

  const deniedEdit = await updateMemoryEntry(env.DB, ORG, agentId, personalId, {
    title: "Changed", body: "Changed private account phrase", kind: "reference", expectedVersion: 1
  }, { userId: "9213", by: "9213" });
  expect(deniedEdit.status).toBe(404);
  const deniedReview = await reviewMemoryEntry(env.DB, ORG, agentId, personalId, {
    expectedVersion: 1, evidence: "not yours", verdict: "keep"
  }, { userId: "9213", by: "9213" });
  expect(deniedReview.status).toBe(404);
  expect((await memoryReviewHistory(env.DB, ORG, agentId, personalId, { userId: "9213" })).reviews).toHaveLength(0);
  expect((await deleteAgentMemory(env.DB, ORG, agentId, personalId, { userId: "9213" })).deleted).toBe(0);
  expect((await listAgentMemories(env.DB, ORG, agentId, { userId: "9212" })).map(m => m.id)).toContain(personalId);
  expect((await reviewMemoryEntry(env.DB, ORG, agentId, personalId, {
    expectedVersion: 1, evidence: "Owner confirms retained scope", verdict: "keep"
  }, { userId: "9212", by: "9212" })).review).toBeDefined();
  expect((await memoryReviewHistory(env.DB, ORG, agentId, personalId, { userId: "9212" })).reviews).toHaveLength(1);
  expect((await memoryReviewHistory(env.DB, ORG, agentId, personalId, { userId: "9213" })).reviews).toHaveLength(0);
  expect((await deleteAgentMemory(env.DB, ORG, agentId, personalId, { userId: "9212" })).deleted).toBe(1);
  expect((await memoryReviewHistory(env.DB, ORG, agentId, personalId, { userId: "9212" })).reviews).toHaveLength(1);
  expect((await memoryReviewHistory(env.DB, ORG, agentId, personalId, { userId: "9213" })).reviews).toHaveLength(0);
});

test("personal memory edit fails closed if ownership changes between read and write", async () => {
  const personal = await addAgentMemory(env.DB, ORG, agentId, {
    title: "Race protected", description: "private", body: "Original body"
  }, { by: "9212", userId: "9212", scope: "person" });
  const racedDb = {
    prepare: (...args) => env.DB.prepare(...args),
    batch: async statements => {
      await env.DB.prepare("UPDATE hx_memory_scopes SET user_github_id='9213' WHERE org_id=?1 AND memory_id=?2")
        .bind(ORG, personal.memory.id).run();
      return env.DB.batch(statements);
    },
  };
  const result = await updateMemoryEntry(racedDb, ORG, agentId, personal.memory.id, {
    title: "Overwritten", description: "", body: "Must not be saved", kind: "context", expectedVersion: 1
  }, { userId: "9212", by: "9212" });
  expect(result).toMatchObject({ error: "This memory changed. Reload before saving.", status: 409 });
  const visibleToNewOwner = await listAgentMemories(env.DB, ORG, agentId, { userId: "9213" });
  expect(visibleToNewOwner.find(memory => memory.id === personal.memory.id)).toMatchObject({
    title: "Race protected", body: "Original body", version: 1
  });
});

test('typed review cadence flags due memory and lets only its authorized owner record an evidence-backed Agent review',async()=>{
  const made=await addAgentMemory(env.DB,ORG,agentId,{title:'Monthly planning',description:'Preference',body:'Use a monthly planning cycle.'},{by:'9212',userId:'9212',scope:'person',kind:'preference'});
  const old=new Date(Date.now()-20*86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE hx_agent_memories SET created_at=?1 WHERE org_id=?2 AND id=?3').bind(old,ORG,made.memory.id),
    env.DB.prepare('UPDATE hx_memory_entries SET updated_at=?1 WHERE org_id=?2 AND memory_id=?3').bind(old,ORG,made.memory.id),
  ]);
  const due=(await listAgentMemories(env.DB,ORG,agentId,{userId:'9212'})).find(memory=>memory.id===made.memory.id);
  expect(due).toMatchObject({reviewDue:true,reviewIntervalDays:15,version:1});
  const ownerTools=agentMemoryTools(env.DB,ORG,agentId,{userId:'9212'});
  const otherTools=agentMemoryTools(env.DB,ORG,agentId,{userId:'9213'});
  expect(await otherTools.review_agent_memory.run({memory_id:made.memory.id,expected_version:1,verdict:'keep',evidence:'Checked'})).toBe('Memory unavailable.');
  const evidence='Checked against the source conversation dated this month.';
  const settled=JSON.parse(await ownerTools.review_agent_memory.run({memory_id:made.memory.id,expected_version:1,verdict:'keep',evidence}));
  expect(settled).toMatchObject({reviewed:true,verdict:'keep',memoryId:made.memory.id});
  const current=(await listAgentMemories(env.DB,ORG,agentId,{userId:'9212'})).find(memory=>memory.id===made.memory.id);
  expect(current).toMatchObject({reviewDue:false,reviewIntervalDays:15,review:{version:1,current:true,evidence}});
  const audit=await env.DB.prepare('SELECT reviewed_by,verdict,evidence FROM hx_memory_review_audit WHERE org_id=?1 AND memory_id=?2').bind(ORG,made.memory.id).first();
  expect(audit).toEqual({reviewed_by:`agent:${agentId}`,verdict:'keep',evidence});
});
