import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import worker from "../src/index.js";

// The harness over MCP (docs/kylon-gap-plan.md): an outside agent reads and
// writes the workspace's apps and tables, runs its workflows and schedules
// follow-ups — in a harness workspace only, and writing only with "write".

const ORG = "personal:hxmcp";
let toru;
const call = (path, init) => worker.fetch(new Request("https://example.com" + path, init), env);
const headers = (token) => ({ "content-type": "application/json", "x-session-token": token });
let seq = 0;
const rpc = (bearer, method, params) => call("/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, ...(params ? { params } : {}) }),
});
const tool = async (bearer, name, args = {}) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json());
const mint = async (scopes) => (await (await call("/tokens", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: "Claude Code", scopes }) })).json()).token;
const names = async (token) => (await (await rpc(token, "tools/list")).json()).result.tools.map((t) => t.name);

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  const { createSession, upsertUser, upsertMembership } = await import("../src/db.js");
  await upsertUser(env.DB, { githubId: "9401", login: "toru", name: "Toru", avatarUrl: null, locale: "en" });
  await upsertMembership(env.DB, ORG, "9401", "admin");
  toru = await createSession(env.DB, "9401", "gho_toru");
});

test("a simple workspace's agents see the tools they always did", async () => {
  const token = await mint(["read", "write"]);
  expect(await names(token)).toEqual(["request_decision", "get_decision", "list_pending", "search_decisions", "list_members", "get_playbook"]);
  expect((await tool(token, "list_apps")).error.message).toContain("Unknown tool");
});

test('Harness MCP exposes scoped Skill reads and permission-checked Agent assignment while Simple hides them', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?1,'skill-agent','skill-agent','Ops Agent','Help','personal','toru','now','now')").bind(ORG).run();
  const { createSkill } = await import('../src/harness/skills.js');
  const created = await createSkill(env.DB, ORG, { name: 'Release guide', description: 'Ship safely', body: 'Check the deployment and alert the owner.' }, '9401');
  expect(created.skill).toMatchObject({ name: 'Release guide', visibility: 'workspace' });
  const reader = await mint(['read']);
  const writer = await mint(['read', 'write']);
  expect(await names(reader)).toEqual(expect.arrayContaining(['list_skills', 'get_skill', 'list_agent_skills']));
  expect(await names(reader)).not.toContain('assign_skill_to_agent');
  expect(await names(reader)).not.toContain('share_skills_with_agents');
  expect(await names(writer)).toEqual(expect.arrayContaining(['assign_skill_to_agent', 'remove_skill_from_agent', 'share_skills_with_agents']));
  const listed = (await tool(reader, 'list_skills')).result.structuredContent;
  expect(listed.skills).toEqual([expect.objectContaining({ id: created.skill.id, name: 'Release guide' })]);
  expect(listed.skills[0]).not.toHaveProperty('body');
  expect((await tool(reader, 'get_skill', { skillId: created.skill.id })).result.structuredContent.skill.body).toContain('alert the owner');
  expect((await tool(reader, 'list_agent_skills', { agentId: 'missing-agent' })).result.isError).toBe(true);
  expect((await tool(writer, 'assign_skill_to_agent', { agentId: 'skill-agent', skillId: created.skill.id })).result.structuredContent).toMatchObject({ assigned: true });
  expect((await tool(reader, 'list_agent_skills', { agentId: 'skill-agent' })).result.structuredContent.skills).toHaveLength(1);

  const { createSession, upsertUser, upsertMembership } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'mika', name: 'Mika', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9402', 'member');
  const mikaSession = await createSession(env.DB, '9402', 'gho_mika');
  const mikaToken = (await (await call('/tokens', { method: 'POST', headers: headers(mikaSession), body: JSON.stringify({ orgId: ORG, name: 'Read only', scopes: ['read', 'write'] }) })).json()).token;
  const deniedShare = (await tool(mikaToken, 'share_skills_with_agents', { skillIds: [created.skill.id], agentIds: ['skill-agent'], confirm: true })).result.structuredContent;
  expect(deniedShare).toMatchObject({ complete: false, assigned: [] });
  expect(deniedShare.failed[0].message).toMatch(/maker or an admin/);
  expect((await tool(mikaToken, 'list_agent_skills', { agentId: 'skill-agent' })).result.isError).toBe(true);
  expect((await tool(mikaToken, 'assign_skill_to_agent', { agentId: 'skill-agent', skillId: created.skill.id })).result.isError).toBe(true);

  await env.DB.prepare("UPDATE custom_agents SET owner_login='someone-else' WHERE org_id=? AND id='skill-agent'").bind(ORG).run();
  expect((await tool(writer, 'remove_skill_from_agent', { agentId: 'skill-agent', skillId: created.skill.id })).result.isError).toBe(true);
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(writer)).not.toContain('list_skills');
  expect((await tool(writer, 'list_skills')).error.message).toContain('Unknown tool');
});

test('Harness MCP creates private Skill packages and version-fences package replacement and shareable lists', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?1,'package-agent','package-agent','Package Agent','Help','personal','toru','now','now')").bind(ORG).run();
  const writer = await mint(['read', 'write']);
  const markdown = '---\nname: Release Guide\ndescription: Release checklist\nmetadata:\n  team: platform\n---\n\nCheck the deployment.';
  const encoded = btoa('release gates');
  const created = (await tool(writer, 'create_skill', { skillMarkdown: markdown, files: [{ path: 'references/gates.md', base64: encoded }] })).result.structuredContent.skill;
  expect(created).toMatchObject({ name: 'Release Guide', visibility: 'private', body: 'Check the deployment.' });
  const privateRows = await env.DB.prepare('SELECT path FROM hx_skill_files WHERE org_id=? AND skill_id=? ORDER BY path').bind(ORG, created.id).all();
  expect(privateRows.results.map(row => row.path)).toEqual(['references/gates.md']);
  const ownerFiltered = (await tool(writer, 'list_skills', { ownerId: '9401' })).result.structuredContent.skills;
  expect(ownerFiltered.map(skill => skill.id)).toContain(created.id);
  expect((await tool(writer, 'list_skills', { publishedOnly: true })).result.structuredContent.skills.map(skill => skill.id)).not.toContain(created.id);
  expect(await names(writer)).toContain('set_skill_visibility');
  expect((await tool(writer, 'set_skill_visibility', { skillId: created.id, visibility: 'workspace', version: created.accessVersion })).result.isError).toBe(true);
  expect((await tool(writer, 'get_skill', { skillId: created.id })).result.structuredContent.skill.visibility).toBe('private');
  const publishedAccess = (await tool(writer, 'set_skill_visibility', { skillId: created.id, visibility: 'workspace', version: created.accessVersion, confirmWorkspaceAccess: true })).result.structuredContent;
  expect(publishedAccess).toMatchObject({ skillId: created.id, visibility: 'workspace', version: created.accessVersion + 1 });
  expect((await tool(writer, 'set_skill_visibility', { skillId: created.id, visibility: 'private', version: created.accessVersion })).result.isError).toBe(true);
  const unpublishedAccess = (await tool(writer, 'set_skill_visibility', { skillId: created.id, visibility: 'private', version: publishedAccess.version })).result.structuredContent;
  expect(unpublishedAccess).toMatchObject({ skillId: created.id, visibility: 'private', version: publishedAccess.version + 1 });
  const published = (await tool(writer, 'create_skill', { skillMarkdown: markdown, visibility: 'workspace' })).result.structuredContent.skill;
  const shareable = (await tool(writer, 'list_shareable_skills', { agentId: 'package-agent' })).result.structuredContent.skills;
  expect(shareable.map(skill => skill.id)).toEqual(expect.arrayContaining([created.id, published.id]));

  const updatedMarkdown = '---\nname: Release Guide v2\ndescription: Current release checklist\n---\n\nVerify rollback before publishing.';
  const updated = (await tool(writer, 'update_skill', { skillId: created.id, expectedUpdatedAt: created.updatedAt, skillMarkdown: updatedMarkdown, files: [{ path: 'references/rollback.md', base64: btoa('Rollback steps') }] })).result.structuredContent.skill;
  expect(updated).toMatchObject({ name: 'Release Guide v2', visibility: 'private', body: 'Verify rollback before publishing.' });
  const replacedRows = await env.DB.prepare('SELECT path FROM hx_skill_files WHERE org_id=? AND skill_id=? ORDER BY path').bind(ORG, created.id).all();
  expect(replacedRows.results.map(row => row.path)).toEqual(['references/rollback.md']);
  const stale = await tool(writer, 'update_skill', { skillId: created.id, expectedUpdatedAt: created.updatedAt, skillMarkdown: markdown, files: [] });
  expect(stale.result.isError).toBe(true);
  expect((await tool(writer, 'get_skill', { skillId: created.id })).result.structuredContent.skill.body).toContain('Verify rollback');
  expect((await tool(writer, 'assign_skill_to_agent', { agentId: 'package-agent', skillId: published.id })).result.structuredContent.assigned).toBe(true);
  expect((await tool(writer, 'list_shareable_skills', { agentId: 'package-agent' })).result.structuredContent.skills.map(skill => skill.id)).toEqual([created.id]);
  const noConfirm = await tool(writer, 'share_skills_with_agents', { skillIds: [published.id], agentIds: ['package-agent'] });
  expect(noConfirm.result.isError).toBe(true);
  const shared = (await tool(writer, 'share_skills_with_agents', { skillIds: [published.id], agentIds: ['package-agent', 'missing-agent'], confirm: true })).result.structuredContent;
  expect(shared).toMatchObject({ complete: false, assigned: [{ agentId: 'package-agent', skillId: published.id }] });
  expect(shared.failed).toEqual([expect.objectContaining({ agentId: 'missing-agent', skillId: published.id })]);
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(writer)).not.toContain('create_skill');
  expect(await names(writer)).not.toContain('set_skill_visibility');
  expect(await names(writer)).not.toContain('share_skills_with_agents');
  expect((await tool(writer, 'create_skill', { skillMarkdown: markdown })).error.message).toContain('Unknown tool');
});

test('Harness Skill share management lists metadata only and revokes only after owner confirmation', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { createSkill } = await import('../src/harness/skills.js');
  const created = await createSkill(env.DB, ORG, { name: 'Shareable guide', description: 'Instructions', body: 'Keep it current.' }, '9401');
  const shareId = 'skill-share-safe-test';
  await env.DB.prepare(`INSERT INTO hx_skill_shares
    (id,org_id,skill_id,token_hash,snapshot,created_by,created_at,expires_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
    .bind(shareId, ORG, created.skill.id, 'hashed-secret-only', JSON.stringify({ fileCount: 2, totalBytes: 123 }), '9401', '2026-11-14T00:00:00.000Z', '2099-01-01T00:00:00.000Z').run();
  const reader = await mint(['read']);
  const writer = await mint(['read', 'write']);
  expect(await names(reader)).toContain('list_skill_shares');
  expect(await names(reader)).not.toContain('revoke_skill_share');
  expect(await names(reader)).not.toContain('set_skill_visibility');
  const listed = await tool(reader, 'list_skill_shares', { skillId: created.skill.id });
  expect(listed.result.structuredContent.shares).toEqual([expect.objectContaining({ id: shareId, fileCount: 2, totalBytes: 123, revokedAt: null })]);
  expect(JSON.stringify(listed.result.structuredContent)).not.toContain('hashed-secret-only');
  expect((await tool(writer, 'revoke_skill_share', { skillId: created.skill.id, shareId, confirm: false })).result.isError).toBe(true);
  expect((await env.DB.prepare('SELECT revoked_at FROM hx_skill_shares WHERE id=?1').bind(shareId).first()).revoked_at).toBeNull();
  expect((await tool(writer, 'revoke_skill_share', { skillId: created.skill.id, shareId, confirm: true })).result.structuredContent).toMatchObject({ skillId: created.skill.id, shareId, revoked: true });
  expect((await env.DB.prepare('SELECT revoked_at FROM hx_skill_shares WHERE id=?1').bind(shareId).first()).revoked_at).toBeTruthy();

  const { upsertUser, upsertMembership, createSession } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'mika', name: 'Mika', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9402', 'member');
  const mikaSession = await createSession(env.DB, '9402', 'gho_mika');
  const mikaToken = (await (await call('/tokens', { method: 'POST', headers: headers(mikaSession), body: JSON.stringify({ orgId: ORG, name: 'Mika', scopes: ['read', 'write'] }) })).json()).token;
  expect((await tool(mikaToken, 'list_skill_shares', { skillId: created.skill.id })).result.isError).toBe(true);
  expect((await tool(mikaToken, 'set_skill_visibility', { skillId: created.skill.id, visibility: 'workspace', version: 0, confirmWorkspaceAccess: true })).result.isError).toBe(true);
  expect((await tool(mikaToken, 'revoke_skill_share', { skillId: created.skill.id, shareId, confirm: true })).result.isError).toBe(true);
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(writer)).not.toContain('list_skill_shares');
});

test('MCP CLI reserves, uploads, replays and downloads binary workspace-file versions under live ACL', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?1,'binary-private','Binary private','9401','2026-11-11',1)").bind(ORG).run();
  await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES(?1,'b:binary-private','toru','9401','2026-11-11')").bind(ORG).run();
  const writer = await mint(['read', 'write']);
  const bytes = new Uint8Array([0, 255, 13, 10, 42, 128]);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const requestId = 'file-123e4567-e89b-12d3-a456-426614174000';
  const args = { scope: 'b:binary-private', path: 'assets/opaque.bin', requestId, contentType: 'application/octet-stream', size: bytes.byteLength, sha256 };
  const reserved = (await tool(writer, 'create_file_upload', args)).result.structuredContent;
  expect(reserved).toMatchObject({ fileId: requestId, method: 'PUT', size: bytes.byteLength });
  const uploaded = await call(reserved.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${writer}`, 'content-type': args.contentType, 'content-length': String(bytes.byteLength) }, body: bytes });
  expect(uploaded.status).toBe(200);
  expect(await uploaded.json()).toMatchObject({ fileId: requestId, version: 1, saved: true });

  const replayedReservation = (await tool(writer, 'create_file_upload', args)).result.structuredContent;
  expect(replayedReservation).toMatchObject({ fileId: requestId, version: 1, saved: true, replayed: true });
  const metadata = (await tool(writer, 'get_workspace_file', { fileId: requestId })).result.structuredContent.file;
  expect(metadata).toMatchObject({ id: requestId, path: 'assets/opaque.bin', version: 1, size: bytes.byteLength });

  const downloaded = await call(`/mcp/workspace-files/${encodeURIComponent(requestId)}/versions/1/content`, { headers: { authorization: `Bearer ${writer}` } });
  expect(downloaded.status).toBe(200);
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  const changed = await call(reserved.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${writer}`, 'content-type': args.contentType, 'content-length': String(bytes.byteLength) }, body: new Uint8Array([1, 2, 3, 4, 5, 6]) });
  expect(changed.status).toBe(400);

  const reader = await mint(['read']);
  const deniedUpload = await call(reserved.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${reader}`, 'content-type': args.contentType, 'content-length': String(bytes.byteLength) }, body: bytes });
  expect(deniedUpload.status).toBe(403);
  const { upsertUser, upsertMembership, createSession } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'mika', name: 'Mika', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9402', 'member');
  const mikaSession = await createSession(env.DB, '9402', 'gho_mika');
  const secondMember = (await (await call('/tokens', { method: 'POST', headers: headers(mikaSession), body: JSON.stringify({ orgId: ORG, name: 'Mika', scopes: ['read'] }) })).json()).token;
  const hiddenDownload = await call(`/mcp/workspace-files/${encodeURIComponent(requestId)}/versions/1/content`, { headers: { authorization: `Bearer ${secondMember}` } });
  expect(hiddenDownload.status).toBe(404);
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  const simpleModeDownload = await call(`/mcp/workspace-files/${encodeURIComponent(requestId)}/versions/1/content`, { headers: { authorization: `Bearer ${writer}` } });
  expect(simpleModeDownload.status).toBe(403);
});

test("in a harness workspace an agent reads an app's numbers, adds a row, and needs write to change anything", async () => {
  await call("/orgs/mode", { method: "PUT", headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: "harness" }) });
  const { app } = await (await call("/apps", { method: "POST", headers: headers(toru), body: JSON.stringify({ orgId: ORG, template: "crm" }) })).json();
  const writer = await mint(["read", "write"]);
  const reader = await mint(["read"]);
  expect(await names(writer)).toEqual(expect.arrayContaining(["list_apps", "read_app", "query_rows", "add_row", "run_workflow", "schedule_followup"]));
  expect(await names(reader)).not.toContain("add_row");

  const listed = (await tool(reader, "list_apps")).result.structuredContent;
  expect(listed.apps).toEqual([expect.objectContaining({ id: app.id, name: "Sales CRM" })]);
  const read = (await tool(reader, "read_app", { appId: app.id })).result.structuredContent;
  expect(read.views.find((v) => v.name === "Forecast").metrics).toEqual(expect.arrayContaining([{ label: "Open pipeline", value: 42000 }]));

  expect((await tool(reader, "add_row", { tableId: app.tableId, values: { Company: "Hooli" } })).result.isError).toBe(true);
  const added = (await tool(writer, "add_row", { tableId: app.tableId, values: { Company: "Hooli", Stage: "Lead", Value: "9,000" } })).result.structuredContent;
  expect(added.row).toMatchObject({ company: "Hooli", stage: "Lead", value: 9000 });
  const found = (await tool(reader, "query_rows", { tableId: app.tableId, where: { Stage: "Lead" } })).result.structuredContent;
  expect(found.rows.map((r) => r.company).sort()).toEqual(["Hooli", "Initech"]);
});

test('MCP workflow draft tools are Harness-only, maker-scoped, version-fenced and never enable creation or edits', async () => {
  const writer = await mint(['read', 'write']);
  const reader = await mint(['read']);
  expect((await names(writer)).map(name => name).filter(name => /workflow/.test(name))).toEqual([]);
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  expect(await names(writer)).toEqual(expect.arrayContaining(['create_workflow', 'update_workflow', 'pause_workflow']));
  expect(await names(reader)).not.toContain('create_workflow');

  const made = await tool(writer, 'create_workflow', {
    name: 'Paused draft',
    trigger: { type: 'manual' },
    steps: [{ type: 'approval', to: 'toru', title: 'Review the release' }],
  });
  expect(made.result.structuredContent.workflow).toMatchObject({ name: 'Paused draft', enabled: false, trigger: { type: 'manual' } });
  const workflowId = made.result.structuredContent.workflow.id;
  expect(made.result.structuredContent.workflow).not.toHaveProperty('hookSecret');
  expect((await tool(writer, 'run_workflow', { workflowId })).result.content[0].text).toContain('off');
  const original = (await tool(writer, 'get_workflow', { workflowId })).result.structuredContent.workflow;

  expect((await tool(writer, 'update_workflow', { workflowId, name: 'Unfenced try' })).result.isError).toBe(true);
  const updated = await tool(writer, 'update_workflow', {
    workflowId,
    expectedUpdatedAt: original.updatedAt,
    name: 'Edited paused draft',
    steps: [{ type: 'approval', to: 'toru', title: 'Review the release tomorrow' }],
  });
  expect(updated.result.structuredContent.workflow).toMatchObject({ name: 'Edited paused draft', enabled: false });

  // Simulate an explicitly enabled trigger without starting any work. Pause
  // uses the fresh updatedAt as a CAS and only disables future triggers.
  await env.DB.prepare("UPDATE hx_workflows SET enabled=1,updated_at='2026-11-12T00:00:00.000Z' WHERE org_id=?1 AND id=?2").bind(ORG, workflowId).run();
  const enabled = (await tool(writer, 'get_workflow', { workflowId })).result.structuredContent.workflow;
  expect((await tool(writer, 'update_workflow', { workflowId, expectedUpdatedAt: enabled.updatedAt, name: 'Edit while enabled' })).result.content[0].text).toContain('Pause');
  const paused = await tool(writer, 'pause_workflow', { workflowId, expectedUpdatedAt: enabled.updatedAt });
  expect(paused.result.structuredContent).toMatchObject({ workflowId, enabled: false, activeRunsContinue: true });
  expect((await tool(writer, 'pause_workflow', { workflowId, expectedUpdatedAt: enabled.updatedAt })).result.isError).toBe(true);

  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(writer)).not.toContain('create_workflow');
  expect((await tool(writer, 'create_workflow', { name: 'No simple access', trigger: { type: 'manual' }, steps: [{ type: 'approval', to: 'toru', title: 'No' }] })).error.message).toContain('Unknown tool');
});

test('MCP rows keep system identity separate from colliding user fields across reads and writes', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { app } = await (await call('/apps', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: 'ID collision', columns: [
    { name: 'Name', type: 'text' }, { name: 'ID', type: 'text' }, { name: 'values', type: 'text' }, { name: 'recordId', type: 'text' },
  ] }) })).json();
  const writer = await mint(['read', 'write']);
  const other = (await tool(writer, 'add_row', { tableId: app.tableId, values: { Name: 'Other' } })).result.structuredContent;
  const source = (await tool(writer, 'add_row', { tableId: app.tableId, values: { Name: 'Source', ID: other.row.id, values: 'user value', recordId: 'business ID' } })).result.structuredContent;
  const id = source.row.id;
  expect(id).not.toBe(other.row.id);
  expect(source.row).toMatchObject({ id, recordId: id, name: 'Source', recordid: 'business ID', values: { id: other.row.id, values: 'user value' } });
  expect(source.rowVersions[id]).toBeTruthy();

  for (const [name, args] of [['query_rows', { tableId: app.tableId }], ['read_app', { appId: app.id }]]) {
    const result = (await tool(writer, name, args)).result.structuredContent;
    expect(result.rows.find(row => row.id === id)).toMatchObject({ recordId: id, values: { id: other.row.id, values: 'user value' } });
    expect(result.rowVersions[id]).toBe(source.rowVersions[id]);
  }
  const changed = (await tool(writer, 'update_row', { tableId: app.tableId, rowId: id, expectedUpdatedAt: source.rowVersions[id], values: { Name: 'Changed' } })).result.structuredContent;
  expect(changed.row).toMatchObject({ id, recordId: id, name: 'Changed', values: { id: other.row.id, values: 'user value' } });
  const rows = (await tool(writer, 'query_rows', { tableId: app.tableId })).result.structuredContent.rows;
  expect(rows.find(row => row.id === other.row.id).name).toBe('Other');
  expect(rows.find(row => row.id === id).name).toBe('Changed');
});

test('node execution requires execute scope, preserves ownership and leaves Simple unchanged', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { gateway, token: nodeToken } = await (await call('/gateways', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: 'Mac mini' }) })).json();
  const writer = await mint(['read', 'write']), executor = await mint(['read', 'execute']);
  expect(await names(writer)).not.toContain('run_javascript');
  expect(await names(executor)).toContain('run_javascript');
  const args = { gatewayId: gateway.id, requestId: 'agent-op-1', code: 'return input * 2', input: 21 };
  expect((await tool(writer, 'run_javascript', args)).result.isError).toBe(true);
  const queued = (await tool(executor, 'run_javascript', args)).result.structuredContent.job;
  expect(queued.status).toBe('queued');
  expect((await tool(executor, 'run_javascript', args)).result.structuredContent.job.id).toBe(queued.id);
  expect((await tool(executor, 'run_javascript', { ...args, code: 'return 0' })).result.isError).toBe(true);
  const nodeCall = async (path, body) => {
    const response = await call('/gateways/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const { job } = await nodeCall('claim', {});
  expect(job.id).toBe(queued.id);
  await nodeCall(`jobs/${job.id}/finish`, { lease: job.lease, status: 'succeeded', stdout: '42', exitCode: 0 });
  expect((await tool(executor, 'get_execution', { jobId: job.id })).result.structuredContent.job).toMatchObject({ status: 'succeeded', result: { stdout: '42' } });
  const { upsertUser, upsertMembership } = await import('../src/db.js');
  const { callExecutionTool, executionAgentTools } = await import('../src/harness/executionTools.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'other', name: 'Other' });
  await upsertMembership(env.DB, ORG, '9402', 'admin');
  const other = { orgId: ORG, githubId: '9402' };
  expect((await callExecutionTool(env, other, 'get_execution', { jobId: job.id })).isError).toBe(true);
  expect((await callExecutionTool(env, other, 'cancel_execution', { jobId: job.id })).isError).toBe(true);
  const context = { orgId: ORG, session: { github_id: '9401' }, personal: true, ownAgentsOnly: true };
  expect(Object.keys(await executionAgentTools(env, context))).toContain('run_javascript');
  expect(await executionAgentTools(env, { ...context, personal: false })).toEqual({});
  expect(await executionAgentTools(env, { ...context, ownAgentsOnly: false })).toEqual({});
  const next = (await tool(executor, 'run_javascript', { ...args, requestId: 'cancel-me' })).result.structuredContent.job;
  expect((await tool(executor, 'cancel_execution', { jobId: next.id })).result.structuredContent.job.status).toBe('cancelled');
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'simple' }) });
  expect(await names(executor)).not.toContain('run_javascript');
  expect(await executionAgentTools(env, context)).toEqual({});
});

test('cancelling an agent stops its running JavaScript and published app action', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { gateway, token: nodeToken } = await (await call('/gateways', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: 'Mac mini' }) })).json();
  const { app } = await (await call('/apps', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, template: 'crm' }) })).json();
  const { saveAction } = await import('../src/harness/appCapabilities.js');
  expect(await saveAction(env.DB, ORG, app.id, { name: 'agent_task', version: 0, action: 'draft', code: 'return input' }, '9401')).toMatchObject({ saved: true, version: 1 });
  expect(await saveAction(env.DB, ORG, app.id, { name: 'agent_task', version: 1, action: 'publish' }, '9401')).toMatchObject({ saved: true, version: 2 });
  const actor = { orgId: ORG, githubId: '9401' };
  const { callExecutionTool, executionAgentTools } = await import('../src/harness/executionTools.js');
  const tools = await executionAgentTools(env, { orgId: ORG, session: { github_id: '9401' }, personal: true, ownAgentsOnly: true });
  const nodeCall = async (path, body) => {
    const response = await call('/gateways/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };

  const startAndCancel = async (toolName, args) => {
    const controller = new AbortController();
    const started = JSON.parse(await tools[toolName].run(args, { signal: controller.signal }));
    expect(started.job.status).toBe('queued');
    const claimed = await nodeCall('claim', {});
    expect(claimed.job.id).toBe(started.job.id);
    controller.abort();
    let latest;
    for (let attempt = 0; attempt < 40; attempt++) {
      latest = await callExecutionTool(env, actor, 'get_execution', { jobId: started.job.id });
      if (latest.structuredContent?.job?.status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(latest.structuredContent.job.status).toBe('cancelled');
    const heartbeat = await nodeCall(`jobs/${started.job.id}/heartbeat`, { lease: claimed.job.lease });
    expect(heartbeat.status).toBe(409);
  };

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const stoppedBeforeQueueReply = JSON.parse(await tools.run_javascript.run(
    { gatewayId: gateway.id, requestId: 'agent-cancel-race', code: 'return input', input: 2 },
    { signal: alreadyAborted.signal },
  ));
  expect(stoppedBeforeQueueReply.job.status).toBe('cancelled');
  await startAndCancel('run_javascript', { gatewayId: gateway.id, requestId: 'agent-cancel-js', code: 'return input', input: 1 });
  await startAndCancel('run_app_action', { appId: app.id, name: 'agent_task', version: 2, gatewayId: gateway.id, requestId: 'agent-cancel-app', input: { ok: true } });
});

test('assignment stop waits for queued execution lease invalidation before completing', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { gateway, token: nodeToken } = await (await call('/gateways', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, name: 'Mac mini' }) })).json();
  let releaseCancellation, cancellationStarted;
  const cancellationGate = new Promise(resolve => { releaseCancellation = resolve; });
  const started = new Promise(resolve => { cancellationStarted = resolve; });
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property !== 'prepare') return Reflect.get(target, property, target);
      return sql => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("UPDATE hx_gateway_jobs SET status = 'cancelled'")) return statement;
        return new Proxy(statement, {
          get(prepared, method) {
            if (method !== 'bind') return Reflect.get(prepared, method, prepared);
            return (...args) => {
              const bound = prepared.bind(...args);
              return new Proxy(bound, {
                get(query, operation) {
                  if (operation !== 'run') return Reflect.get(query, operation, query);
                  return async (...runArgs) => {
                    cancellationStarted();
                    await cancellationGate;
                    return query.run(...runArgs);
                  };
                },
              });
            };
          },
        });
      };
    },
  });
  const { executionAgentTools } = await import('../src/harness/executionTools.js');
  const tools = await executionAgentTools({ ...env, DB: db }, { orgId: ORG, session: { github_id: '9401' }, personal: true, ownAgentsOnly: true });
  const controller = new AbortController();
  const created = JSON.parse(await tools.run_javascript.run({ gatewayId: gateway.id, requestId: 'stop-drain', code: 'return input', input: 1 }, { signal: controller.signal }));
  const nodeCall = async (path, body) => {
    const response = await call('/gateways/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` }, body: JSON.stringify(body) });
    return { status: response.status, ...(await response.json()) };
  };
  const claimed = await nodeCall('claim', {});
  expect(claimed.job.id).toBe(created.job.id);

  const { AgentRunner } = await import('../src/agentRunner.js');
  const runner = new AgentRunner({ storage: {} }, env);
  runner.registerAssignment({ orgId: ORG, assignmentId: 'assignment-stop', generation: 0 }, controller);
  let stopCompleted = false;
  const stop = runner.fetch(new Request('https://agents/cancel-assignment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: ORG, assignmentId: 'assignment-stop', generation: 0 }) })).then(response => { stopCompleted = true; return response; });
  await started;
  expect(stopCompleted).toBe(false);
  expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(created.job.id).first()).status).toBe('running');

  releaseCancellation();
  expect((await stop).status).toBe(200);
  expect((await env.DB.prepare('SELECT status,lease_hash FROM hx_gateway_jobs WHERE id=?1').bind(created.job.id).first())).toEqual({ status: 'cancelled', lease_hash: null });
  expect((await nodeCall(`jobs/${created.job.id}/heartbeat`, { lease: claimed.job.lease })).status).toBe(409);
});

test('MCP reports an overlapping workflow trigger as skipped without dereferencing a nonexistent run', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { createWorkflow } = await import('../src/harness/workflows.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Approval gate', enabled: true, trigger: { type: 'manual' },
    steps: [{ type: 'approval', to: 'toru', title: 'Proceed?' }],
  }, '9401');
  const token = await mint(['read', 'write']);
  const first = await tool(token, 'run_workflow', { workflowId: workflow.id });
  expect(JSON.parse(first.result.content[0].text).run.status).toBe('waiting');
  const second = await tool(token, 'run_workflow', { workflowId: workflow.id });
  expect(second.result.isError).not.toBe(true);
  expect(JSON.parse(second.result.content[0].text)).toEqual({ status: 'skipped', reason: 'already_running' });
});

test('workflow MCP exposes lifecycle reads, gates webhook payloads, and applies explicit event actions', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { createWorkflow } = await import('../src/harness/workflows.js');
  const { app } = await (await call('/apps', { method: 'POST', headers: headers(toru), body: JSON.stringify({ orgId: ORG, template: 'crm' }) })).json();
  const made = await createWorkflow(env.DB, ORG, {
    name: 'Held input review', enabled: false, trigger: { type: 'webhook' },
    steps: [{ type: 'add_row', tableId: app.tableId, values: { Company: '{{input.note}}' } }],
  }, '9401');
  const eventId = 'held_mcp_lifecycle';
  await env.DB.prepare('INSERT INTO hx_workflow_held_events(id,org_id,workflow_id,input,received_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)')
    .bind(eventId, ORG, made.workflow.id, JSON.stringify({ note: 'review me' }), new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()).run();
  const ownerToken = await mint(['read', 'write']);
  const shown = (await tool(ownerToken, 'get_workflow', { workflowId: made.workflow.id })).result.structuredContent;
  expect(shown.workflow).toMatchObject({ id: made.workflow.id, enabled: false, trigger: { type: 'webhook' } });
  expect(shown.workflow.hookSecret).toBeUndefined();
  expect(shown.webhook).toEqual({ active: true, signatureRequired: true });
  expect(JSON.stringify(shown)).not.toContain(made.workflow.hookSecret);
  const listedTools = (await (await rpc(ownerToken, 'tools/list')).json()).result.tools;
  for (const name of ['discard_held_workflow_events', 'replay_held_workflow_events', 'rotate_workflow_webhook', 'revoke_workflow_webhook']) {
    expect(listedTools.find(item => item.name === name).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  }
  expect((await tool(ownerToken, 'list_held_workflow_events', { workflowId: made.workflow.id })).result.structuredContent.events).toEqual([
    expect.objectContaining({ id: eventId }),
  ]);
  expect((await tool(ownerToken, 'get_held_workflow_event', { workflowId: made.workflow.id, eventId })).result.structuredContent.event.input)
    .toEqual({ note: 'review me' });
  expect((await tool(ownerToken, 'discard_held_workflow_events', { workflowId: made.workflow.id, eventIds: [eventId] })).result.structuredContent)
    .toEqual({ discarded: 1 });
  expect(await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action='workflow.webhook_discarded'").bind(ORG).first('action'))
    .toBe('workflow.webhook_discarded');
  const rotated = (await tool(ownerToken, 'rotate_workflow_webhook', {
    workflowId: made.workflow.id, expectedUpdatedAt: shown.workflow.updatedAt,
  })).result.structuredContent;
  expect(rotated).toMatchObject({ workflowId: made.workflow.id, active: true, secret: expect.stringMatching(/^[0-9a-f]{48}$/) });
  const rotateAudit = await env.DB.prepare("SELECT body FROM audit_events WHERE org_id=?1 AND action='workflow.webhook_rotated' ORDER BY seq DESC LIMIT 1").bind(ORG).first();
  expect(rotateAudit.body).not.toContain(rotated.secret);

  const { upsertUser, upsertMembership, createSession } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId: '9402', login: 'mika', name: 'Mika', avatarUrl: null, locale: 'en' });
  await upsertMembership(env.DB, ORG, '9402', 'member');
  const mikaSession = await createSession(env.DB, '9402', 'gho_mika');
  const memberToken = (await (await call('/tokens', { method: 'POST', headers: headers(mikaSession), body: JSON.stringify({ orgId: ORG, name: 'Mika', scopes: ['read', 'write'] }) })).json()).token;
  const memberView = (await tool(memberToken, 'get_workflow', { workflowId: made.workflow.id })).result.structuredContent;
  expect(memberView.webhook).toBeUndefined();
  expect((await tool(memberToken, 'get_held_workflow_event', { workflowId: made.workflow.id, eventId })).result.isError).toBe(true);
  expect((await tool(memberToken, 'discard_held_workflow_events', { workflowId: made.workflow.id, eventIds: [eventId] })).result.isError).toBe(true);
  expect((await tool(memberToken, 'revoke_workflow_webhook', {
    workflowId: made.workflow.id, expectedSecret: rotated.secret, expectedUpdatedAt: rotated.updatedAt,
  })).result.isError).toBe(true);
  const revoked = (await tool(ownerToken, 'revoke_workflow_webhook', {
    workflowId: made.workflow.id, expectedSecret: rotated.secret, expectedUpdatedAt: rotated.updatedAt,
  })).result.structuredContent;
  expect(revoked).toMatchObject({ workflowId: made.workflow.id, active: false });
  const revokeAudit = await env.DB.prepare("SELECT body FROM audit_events WHERE org_id=?1 AND action='workflow.webhook_revoked' ORDER BY seq DESC LIMIT 1").bind(ORG).first();
  expect(revokeAudit.body).not.toContain(rotated.secret);
  expect((await tool(ownerToken, 'list_workflow_runs', { workflowId: made.workflow.id })).result.structuredContent.runs).toEqual([]);
});

test('workflow MCP exposes revision restore, safety resume and no-replay stalled recovery with maker safeguards', async () => {
  await call('/orgs/mode', { method: 'PUT', headers: headers(toru), body: JSON.stringify({ orgId: ORG, mode: 'harness' }) });
  const { createWorkflow, updateWorkflow } = await import('../src/harness/workflows.js');
  const { ensureWorkflowSafety } = await import('../src/harness/workflowSafety.js');
  const { workflow } = await createWorkflow(env.DB, ORG, {
    name: 'Version one', enabled: true, trigger: { type: 'manual' },
    steps: [{ type: 'approval', to: 'toru', title: 'Proceed?' }],
  }, '9401');
  const ownerToken = await mint(['read', 'write']);
  expect(await names(ownerToken)).toEqual(expect.arrayContaining([
    'list_workflow_revisions', 'restore_workflow_revision', 'resume_workflow_safety', 'recover_stalled_workflow_run',
  ]));
  const first = await (await tool(ownerToken, 'get_workflow', { workflowId: workflow.id })).result.structuredContent.workflow;
  const changed = await updateWorkflow(env.DB, ORG, workflow.id, {
    name: 'Version two', enabled: true, trigger: first.trigger, steps: first.steps, expectedUpdatedAt: first.updatedAt,
  }, '9401');
  expect(changed.workflow.name).toBe('Version two');
  const revisions = (await tool(ownerToken, 'list_workflow_revisions', { workflowId: workflow.id })).result.structuredContent.items;
  const listedTools = (await (await rpc(ownerToken, 'tools/list')).json()).result.tools;
  expect(listedTools.find(item => item.name === 'restore_workflow_revision').annotations).toMatchObject({ destructiveHint: true });
  expect(listedTools.find(item => item.name === 'resume_workflow_safety').annotations).toMatchObject({ destructiveHint: false });
  expect(revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revision: expect.any(Number), definition: expect.objectContaining({ name: 'Version one' }) })]));
  const restored = await tool(ownerToken, 'restore_workflow_revision', {
    workflowId: workflow.id, revision: revisions.find(item => item.definition.name === 'Version one').revision,
    expectedUpdatedAt: changed.workflow.updatedAt,
  });
  expect(restored.result.structuredContent.workflow.name).toBe('Version one');
  const staleRestore = await tool(ownerToken, 'restore_workflow_revision', {
    workflowId: workflow.id, revision: revisions.find(item => item.definition.name === 'Version one').revision,
    expectedUpdatedAt: changed.workflow.updatedAt,
  });
  expect(staleRestore.result.isError).toBe(true);
  expect(await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action='workflow.revision_restored'").bind(ORG).first('action'))
    .toBe('workflow.revision_restored');

  const safety = await ensureWorkflowSafety(env.DB, ORG, workflow.id);
  await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at=?1,pause_reason='repeated_failures' WHERE org_id=?2 AND workflow_id=?3")
    .bind(new Date().toISOString(), ORG, workflow.id).run();
  const resumed = await tool(ownerToken, 'resume_workflow_safety', { workflowId: workflow.id, generation: safety.generation });
  expect(resumed.result.structuredContent.safety.paused_at).toBeNull();
  expect(await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action='workflow.safety_resumed'").bind(ORG).first('action'))
    .toBe('workflow.safety_resumed');
  await env.DB.prepare("UPDATE hx_workflow_safety SET paused_at=?1,pause_reason='budget_daily' WHERE org_id=?2 AND workflow_id=?3")
    .bind(new Date().toISOString(), ORG, workflow.id).run();
  const budgetResume = await tool(ownerToken, 'resume_workflow_safety', { workflowId: workflow.id, generation: safety.generation });
  expect(budgetResume.result.isError).toBe(true);
  expect(budgetResume.result.content[0].text).toContain('budget');

  const runId = 'run-stalled-mcp-recovery';
  const startedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO hx_workflow_runs(id,org_id,workflow_id,trigger,status,input,log,next_step,started_by,started_at)
    VALUES(?1,?2,?3,'manual','running','{}','[]',0,'9401',?4)`).bind(runId, ORG, workflow.id, startedAt).run();
  const recovered = await tool(ownerToken, 'recover_stalled_workflow_run', {
    workflowId: workflow.id, runId, expectedStartedAt: startedAt, confirmNoReplay: true,
  });
  expect(recovered.result.structuredContent.run).toMatchObject({ status: 'failed', log: [expect.objectContaining({ status: 'interrupted', outcome: 'unknown' })] });
  expect(await env.DB.prepare("SELECT action FROM audit_events WHERE org_id=?1 AND action='workflow.run_reconciled'").bind(ORG).first('action'))
    .toBe('workflow.run_reconciled');
  const unsafe = await tool(ownerToken, 'recover_stalled_workflow_run', {
    workflowId: workflow.id, runId: 'missing', expectedStartedAt: startedAt, confirmNoReplay: false,
  });
  expect(unsafe.result.isError).toBe(true);
});

test('file read tools use token identity, exact versions and live room access',async()=>{
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 const fileSql=(await import('../workspace-files.sql?raw')).default;await env.DB.exec(fileSql.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const reader=await mint(['read']),writerOnly=await mint(['write']);
 expect(await names(reader)).toEqual(expect.arrayContaining(['list_workspace_files','list_workspace_folders','list_file_versions','read_file_text']));
 expect(await names(writerOnly)).not.toContain('read_file_text');
 expect((await tool(writerOnly,'read_file_text',{fileId:'notes',version:1})).result.isError).toBe(true);
 await createFileLedger(env.DB,{orgId:ORG,fileId:'notes',scope:'workspace',path:'Team/notes.txt',createdBy:'9401'});
 for(const [expectedVersion,text] of [[0,'old notes'],[1,'new notes']])expect(await uploadFileVersion(env,{orgId:ORG,fileId:'notes',userId:'9401',expectedVersion,size:text.length,contentType:'text/plain',stream:new Blob([text]).stream()})).toMatchObject({saved:true});
 const listed=(await tool(reader,'list_workspace_files',{scope:'workspace',orgId:'other',userId:'other'})).result.structuredContent;
 expect(listed.files.map(file=>file.path)).toEqual(['Team/notes.txt']);
 const definition=(await (await rpc(reader,'tools/list')).json()).result.tools.find(t=>t.name==='list_workspace_files');
 expect(definition.inputSchema.properties.type.enum).toContain('pdf');expect(definition.inputSchema.properties.since.type).toBe('string');
 const filtered=async filters=>(await tool(reader,'list_workspace_files',{scope:'workspace',...filters})).result;
 expect((await filtered({type:'doc',createdBy:'9401',since:'1900-01-01',until:'2999-01-01'})).structuredContent.files.map(f=>f.id)).toEqual(['notes']);
 expect((await filtered({since:'$start_of_today',until:'$start_of_tomorrow'})).structuredContent.files.map(f=>f.id)).toEqual(['notes']);
 expect((await filtered({until:'$start_of_yesterday'})).structuredContent.files).toEqual([]);
 expect((await filtered({since:'$start_of_unknown'})).isError).toBe(true);
 for(const filters of [{type:'pdf'},{createdBy:'another-user'},{since:'2999-01-01'},{until:'1900-01-01'}])expect((await filtered(filters)).structuredContent.files).toEqual([]);
 for(const filters of [{type:'invalid'},{since:'not-a-date'},{since:'2026-02-01',until:'2026-01-01'}])expect((await filtered(filters)).isError).toBe(true);

 expect((await tool(reader,'list_workspace_folders',{scope:'workspace'})).result.structuredContent.folders).toEqual([{name:'Team',path:'Team/'}]);
 expect((await tool(reader,'list_file_versions',{fileId:'notes'})).result.structuredContent.versions.map(v=>v.version)).toEqual([2,1]);
 const content=(await tool(reader,'read_file_text',{fileId:'notes',version:1})).result;
 expect(content.structuredContent).toMatchObject({text:'old notes',version:1,untrustedContent:true});
 expect(JSON.stringify(content)).not.toContain('objectKey');expect(JSON.stringify(content)).not.toContain('org/');
 expect((await tool(reader,'list_workspace_files',{})).result.isError).toBe(true);
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:private' WHERE id='notes'").run();
 expect((await tool(reader,'list_workspace_files',{scope:'all'})).result.structuredContent.files).toEqual([]);
 expect((await tool(reader,'list_file_versions',{fileId:'notes'})).result.structuredContent.versions).toEqual([]);
 expect((await tool(reader,'read_file_text',{fileId:'notes',version:1})).result.isError).toBe(true);
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'simple'})});
 expect(await names(reader)).not.toContain('read_file_text');
 expect((await tool(reader,'read_file_text',{fileId:'notes',version:1})).error.message).toContain('Unknown tool');
});

test('file text tools reject large, binary, malformed UTF-8 and purged versions',async()=>{
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 const fileSql=(await import('../workspace-files.sql?raw')).default;await env.DB.exec(fileSql.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const reader=await mint(['read']);
 for(const [id,bytes,mime] of [['large',new Uint8Array(128*1024+1),'text/plain'],['binary',new Uint8Array([1,2]),'image/png'],['invalid',new Uint8Array([255]),'text/plain'],['purged',new TextEncoder().encode('private'),'text/plain']]){
  await createFileLedger(env.DB,{orgId:ORG,fileId:id,scope:'workspace',path:id,createdBy:'9401'});
  await uploadFileVersion(env,{orgId:ORG,fileId:id,userId:'9401',expectedVersion:0,size:bytes.length,contentType:mime,stream:new Blob([bytes]).stream()});
 }
 await env.DB.prepare('INSERT INTO hx_workspace_file_purges VALUES(?,?,?,?,?,?)').bind(ORG,'purged',1,'9401','now','test').run();
 for(const id of ['large','binary','invalid','purged'])expect((await tool(reader,'read_file_text',{fileId:id,version:1})).result.isError).toBe(true);
 expect((await tool(reader,'read_file_text',{fileId:'invalid',version:0})).result.isError).toBe(true);
});

test('file edits require write scope and preserve history while rejecting stale or inaccessible writes',async()=>{
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const reader=await mint(['read']),writer=await mint(['read','write']);
 expect(await names(reader)).not.toContain('update_file_text');expect(await names(writer)).toContain('update_file_text');
 await createFileLedger(env.DB,{orgId:ORG,fileId:'edit',scope:'workspace',path:'note.md',createdBy:'9401'});
 await uploadFileVersion(env,{orgId:ORG,fileId:'edit',userId:'9401',expectedVersion:0,size:3,contentType:'text/markdown',stream:new Blob(['old']).stream()});
 const args={fileId:'edit',expectedVersion:1,text:'新しい内容',orgId:'spoof',userId:'spoof'};
 expect((await tool(reader,'update_file_text',args)).result.isError).toBe(true);
 expect((await tool(writer,'update_file_text',args)).result.structuredContent).toEqual({fileId:'edit',version:2,saved:true});
 expect((await tool(reader,'read_file_text',{fileId:'edit',version:1})).result.structuredContent.text).toBe('old');
 expect((await tool(reader,'read_file_text',{fileId:'edit',version:2})).result.structuredContent).toMatchObject({text:'新しい内容',contentType:'text/markdown'});
 expect((await tool(writer,'update_file_text',args)).result.isError).toBe(true);
 for(const text of ['あ'.repeat(50000),'\ud800'])expect((await tool(writer,'update_file_text',{...args,expectedVersion:2,text})).result.isError).toBe(true);
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:removed' WHERE id='edit'").run();
 expect((await tool(writer,'update_file_text',{...args,expectedVersion:2})).result.isError).toBe(true);
 expect((await env.DB.prepare("SELECT current_version FROM hx_workspace_files WHERE id='edit'").first()).current_version).toBe(2);
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'simple'})});
 expect(await names(writer)).not.toContain('update_file_text');
});

test('file delete and restore are version-fenced, reversible and require live write authority',async()=>{
 const {createFileLedger,listFileVersions}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const reader=await mint(['read']),writer=await mint(['read','write']);
 expect(await names(writer)).toEqual(expect.arrayContaining(['delete_file','restore_file_version']));
 expect(await names(reader)).not.toContain('delete_file');
 await createFileLedger(env.DB,{orgId:ORG,fileId:'reversible',scope:'workspace',path:'notes/reversible.md',createdBy:'9401'});
 await uploadFileVersion(env,{orgId:ORG,fileId:'reversible',userId:'9401',expectedVersion:0,size:3,contentType:'text/markdown',stream:new Blob(['old']).stream()});
 await uploadFileVersion(env,{orgId:ORG,fileId:'reversible',userId:'9401',expectedVersion:1,size:3,contentType:'text/markdown',stream:new Blob(['new']).stream()});
 const deleteArgs={fileId:'reversible',expectedVersion:2,orgId:'spoof',userId:'spoof'};
 expect((await tool(reader,'delete_file',deleteArgs)).result.isError).toBe(true);
 expect((await tool(writer,'delete_file',{...deleteArgs,expectedVersion:1})).result.isError).toBe(true);
 expect((await tool(writer,'delete_file',deleteArgs)).result.structuredContent).toEqual({fileId:'reversible',version:3,deleted:true});
 expect((await tool(writer,'delete_file',deleteArgs)).result.isError).toBe(true);
 expect((await tool(reader,'list_workspace_files',{scope:'workspace'})).result.structuredContent.files).toEqual([]);
 expect((await tool(reader,'list_workspace_files',{scope:'workspace',includeDeleted:true})).result.structuredContent.files).toEqual([expect.objectContaining({id:'reversible',deleted:true})]);
 expect((await tool(reader,'read_file_text',{fileId:'reversible',version:1})).result.structuredContent.text).toBe('old');
 expect((await tool(reader,'restore_file_version',{fileId:'reversible',expectedVersion:3,version:1})).result.isError).toBe(true);
 expect((await tool(writer,'restore_file_version',{fileId:'reversible',expectedVersion:2,version:1})).result.isError).toBe(true);
 expect((await tool(writer,'restore_file_version',{fileId:'reversible',expectedVersion:3,version:1})).result.structuredContent).toEqual({fileId:'reversible',version:4,restoredFrom:1,saved:true});
 expect((await tool(reader,'read_file_text',{fileId:'reversible',version:4})).result.structuredContent.text).toBe('old');
 expect((await listFileVersions(env.DB,{orgId:ORG,fileId:'reversible',userId:'9401'})).map(v=>[v.version,v.kind,v.isCurrent])).toEqual([[4,'content',true],[3,'deleted',false],[2,'content',false],[1,'content',false]]);
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'simple'})});
 expect(await names(writer)).not.toContain('delete_file');
});

test('file editing rejects binary files and current permission loss',async()=>{
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 const {callFileWriteTool}=await import('../src/harness/fileWriteTools.js');
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const writer=await mint(['read','write']);
 await createFileLedger(env.DB,{orgId:ORG,fileId:'binary-edit',scope:'workspace',path:'photo.png',createdBy:'9401'});
 await uploadFileVersion(env,{orgId:ORG,fileId:'binary-edit',userId:'9401',expectedVersion:0,size:1,contentType:'image/png',stream:new Blob(['x']).stream()});
 expect((await tool(writer,'update_file_text',{fileId:'binary-edit',expectedVersion:1,text:'text'})).result.isError).toBe(true);
 await env.DB.prepare("UPDATE memberships SET role='guest' WHERE org_id=? AND user_github_id='9401'").bind(ORG).run();
 expect((await callFileWriteTool(env,{orgId:ORG,githubId:'9401'},'update_file_text',{fileId:'binary-edit',expectedVersion:1,text:'text'})).isError).toBe(true);
 expect((await env.DB.prepare("SELECT current_version FROM hx_workspace_files WHERE id='binary-edit'").first()).current_version).toBe(1);
});

test('agent creates text with trusted provenance, retries without duplicate versions and cannot replace existing paths',async()=>{
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const writer=await mint(['read','write']),reader=await mint(['read']);
 const args={scope:'workspace',path:'Generated/report.md',requestId:`file-${crypto.randomUUID()}`,text:'\ufeff# レポート',contentType:'text/markdown',origin:'human'};
 expect(await names(reader)).not.toContain('create_file_text');
 expect((await tool(reader,'create_file_text',args)).result.isError).toBe(true);
 const created=(await tool(writer,'create_file_text',args)).result.structuredContent;
 expect(created).toEqual({fileId:args.requestId,version:1,saved:true,replayed:false});
 expect((await tool(writer,'create_file_text',args)).result.structuredContent).toMatchObject({fileId:args.requestId,version:1,replayed:true});
 expect((await tool(reader,'list_workspace_files',{scope:'workspace',origin:'agent'})).result.structuredContent.files).toEqual([expect.objectContaining({id:args.requestId,origin:'agent',version:1})]);
 expect((await tool(reader,'read_file_text',{fileId:args.requestId,version:1})).result.structuredContent.text).toBe(args.text);
 for(const altered of [{text:'different'},{contentType:'text/plain'},{path:'elsewhere.txt'},{requestId:`file-${crypto.randomUUID()}`}])expect((await tool(writer,'create_file_text',{...args,...altered})).result.isError).toBe(true);
 expect((await tool(reader,'list_file_versions',{fileId:args.requestId})).result.structuredContent.versions).toHaveLength(1);
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:lost' WHERE id=?").bind(args.requestId).run();
 expect((await tool(writer,'create_file_text',args)).result.isError).toBe(true);
 expect((await tool(writer,'create_file_text',{...args,requestId:`file-${crypto.randomUUID()}`,scope:'g:private'})).result.isError).toBe(true);
});

test('agent file creation resumes its reservation, rejects human reservations and keeps one version under concurrent retries',async()=>{
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const writer=await mint(['read','write']);
 const args={scope:'workspace',path:'resumed.txt',requestId:`file-${crypto.randomUUID()}`,text:'resumed',contentType:'text/plain'};
 await createFileLedger(env.DB,{orgId:ORG,fileId:args.requestId,scope:args.scope,path:args.path,createdBy:'9401',origin:'agent'});
 const results=await Promise.all([tool(writer,'create_file_text',args),tool(writer,'create_file_text',args)]);
 expect(results.some(r=>r.result.structuredContent?.saved)).toBe(true);
 expect((await tool(writer,'list_file_versions',{fileId:args.requestId})).result.structuredContent.versions).toHaveLength(1);
 expect((await tool(writer,'create_file_text',args)).result.structuredContent.replayed).toBe(true);
 const human={...args,path:'human.txt',requestId:`file-${crypto.randomUUID()}`};
 await createFileLedger(env.DB,{orgId:ORG,fileId:human.requestId,scope:human.scope,path:human.path,createdBy:'9401',origin:'human'});
 expect((await tool(writer,'create_file_text',human)).result.isError).toBe(true);
 for(const change of [{requestId:'invalid'},{path:'../escape.txt'},{contentType:'image/png'},{text:'あ'.repeat(50000)}])expect((await tool(writer,'create_file_text',{...args,requestId:`file-${crypto.randomUUID()}`,path:'invalid.txt',...change})).result.isError).toBe(true);
 expect((await tool(writer,'list_file_versions',{fileId:human.requestId})).result.structuredContent.versions).toEqual([]);
});

test('own-agent conversation tools create files in their bound scope and cannot reach other rooms',async()=>{
 const {fileAgentTools}=await import('../src/harness/fileAgentTools.js');
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,'file-agent','file-agent','Files','Help','personal','toru','now','now')").bind(ORG).run();
 const context={orgId:ORG,session:{github_id:'9401'},personal:true,ownAgentsOnly:true,fileScope:'ag:file-agent|toru',taint:{value:false}};
 for(const change of [{personal:false},{ownAgentsOnly:false},{fileScope:'workspace'}])expect(await fileAgentTools(env,{...context,...change})).toEqual({});
 const tools=await fileAgentTools({...env,APP_WEB_URL:'https://workspace.example.test/app/'},context);
 expect(tools.create_file_text.parameters.properties.scope).toBeUndefined();
 const args={requestId:`file-${crypto.randomUUID()}`,path:'report.md',text:'local tool output',contentType:'text/markdown',scope:'workspace'};
 const created=JSON.parse(await tools.create_file_text.run(args));expect(created.saved).toBe(true);
 const link=new URL(created.openUrl);expect(link.origin).toBe('https://workspace.example.test');expect(link.pathname).toBe('/app/');expect(link.hash).toContain(`file=${args.requestId}`);expect(link.hash).not.toContain('scope=workspace');
 expect((await env.DB.prepare('SELECT scope FROM hx_workspace_files WHERE id=?').bind(created.fileId).first()).scope).toBe(context.fileScope);
 expect(context.taint.value).toBe(true);
 expect(JSON.parse(await tools.read_file_text.run({fileId:created.fileId,version:1})).text).toBe(args.text);
 const writer=await mint(['read','write']);
 const outside=(await tool(writer,'create_file_text',{...args,requestId:`file-${crypto.randomUUID()}`})).result.structuredContent;
 expect(JSON.parse(await tools.read_file_text.run({fileId:outside.fileId,version:1})).error).toContain('not in');
 expect(JSON.parse(await tools.update_file_text.run({fileId:outside.fileId,expectedVersion:1,text:'overwrite'})).error).toContain('not in');
 const {agentTools}=await import('../src/agentTools.js');
 const assembled=await agentTools(env,context);
 expect(assembled.create_file_text).toBeDefined();
 expect(JSON.parse(await assembled.read_file_text.run({fileId:created.fileId,version:1})).text).toBe(args.text);
 expect(await assembled.read_url.run({url:'https://example.com/'})).toContain('Not opened');
 await env.DB.prepare("UPDATE custom_agents SET owner_login='someone-else' WHERE id='file-agent'").run();
 expect(JSON.parse(await tools.create_file_text.run({...args,requestId:`file-${crypto.randomUUID()}`})).error).toContain('no longer');
});

test('conversation file links use configured deployments and exclude inherited credentials',async()=>{
 const {conversationFileUrl}=await import('../src/harness/fileAgentTools.js');
 const target={orgId:'team:files',fileScope:'ag:writer|toru',fileId:'file-123'};
 const url=new URL(conversationFileUrl('http://localhost:4173/app/?token=secret#old',target));
 expect(url.origin).toBe('http://localhost:4173');expect(url.pathname).toBe('/app/');expect(url.search).toBe('');
 expect(url.hash).toBe('#/c/ag%3Awriter?org=team%3Afiles&file=file-123');
 for(const address of [undefined,'invalid','javascript:alert(1)','https://user:password@example.test'])expect(conversationFileUrl(address,target)).toBeNull();
});

test('MCP record writes handle 39 valid relation fields',async()=>{
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const {app}=await(await call('/apps',{method:'POST',headers:headers(toru),body:JSON.stringify({orgId:ORG,name:'MCP Relations',columns:[{name:'Task',type:'text'}]})})).json();
 const relations=Array.from({length:39},(_,i)=>({name:`Link ${i}`,type:'relation',targetEntity:'primary',multiple:i%2===1}));
 const migration=await call(`/apps/${app.id}/database`,{method:'POST',headers:headers(toru),body:JSON.stringify({orgId:ORG,action:'migrate',id:'mcp_many_relations',version:0,operations:[{op:'add_columns',entity:'primary',columns:relations}]})});expect(migration.status).toBe(200);
 const token=await mint(['read','write']);const seed=(await tool(token,'add_row',{tableId:app.tableId,values:{task:'Seed'}})).result.structuredContent;
 const values={task:'MCP'};for(let i=0;i<39;i++)values[`link_${i}`]=i%2?[seed.row.id]:seed.row.id;
 const inserted=(await tool(token,'add_row',{tableId:app.tableId,values})).result;expect(inserted.isError).not.toBe(true);expect(inserted.structuredContent.row.link_38).toBe(seed.row.id);
 const updated=(await tool(token,'update_row',{tableId:app.tableId,rowId:inserted.structuredContent.row.id,values})).result;expect(updated.isError).not.toBe(true);expect(updated.structuredContent.row.link_37).toEqual([seed.row.id]);
});

test('MCP file sharing can only stage a stable approval request and read token-free owned-file requests',async()=>{
 await env.DB.exec((await import('../workspace-files.sql?raw')).default.replace(/\n/g,' '));
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'harness'})});
 const {createFileLedger}=await import('../src/harness/fileVersionLedger.js');
 const {uploadFileVersion}=await import('../src/harness/fileUpload.js');
 await createFileLedger(env.DB,{orgId:ORG,fileId:'share-cli-file',scope:'workspace',path:'reports/quarterly.txt',createdBy:'9401'});
 await uploadFileVersion(env,{orgId:ORG,fileId:'share-cli-file',userId:'9401',expectedVersion:0,size:7,contentType:'text/plain',stream:new Blob(['quarter']).stream()});
 const reader=await mint(['read']),writer=await mint(['read','write']);
 expect(await names(reader)).not.toContain('request_public_file_share');
 expect(await names(reader)).toContain('list_file_share_requests');
 expect(await names(writer)).toContain('request_public_file_share');
 const args={fileId:'share-cli-file',version:1,requestKey:'share-request-key-1234',expiresIn:604800,allowDownload:false};
 const staged=(await tool(writer,'request_public_file_share',args)).result.structuredContent;
 expect(staged).toMatchObject({status:'pending',fileId:args.fileId,version:1,allowDownload:false,created:true});
 expect(staged).not.toHaveProperty('url');
 expect(JSON.stringify(staged)).not.toContain('/hx/public-file-shares/');
 expect((await env.DB.prepare('SELECT status FROM hx_file_share_requests WHERE org_id=? AND id=?').bind(ORG,staged.requestId).first()).status).toBe('pending');
 expect((await env.DB.prepare('SELECT count(*) AS count FROM hx_public_file_shares WHERE org_id=?').bind(ORG).first()).count).toBe(0);
 const replay=(await tool(writer,'request_public_file_share',args)).result.structuredContent;
 expect(replay).toMatchObject({requestId:staged.requestId,status:'pending',created:false});
 const listed=(await tool(reader,'list_file_share_requests',{fileId:args.fileId})).result.structuredContent;
 expect(listed.requests).toHaveLength(1);
 expect(listed.requests[0]).toMatchObject({id:staged.requestId,fileId:args.fileId,filePath:'reports/quarterly.txt',status:'pending'});
 expect(JSON.stringify(listed)).not.toContain('/hx/public-file-shares/');
 expect((await tool(writer,'request_public_file_share',{...args,version:2})).result.isError).toBe(true);
 await call('/orgs/mode',{method:'PUT',headers:headers(toru),body:JSON.stringify({orgId:ORG,mode:'simple'})});
 expect(await names(writer)).not.toContain('request_public_file_share');
 expect(await names(writer)).not.toContain('list_file_share_requests');
});
