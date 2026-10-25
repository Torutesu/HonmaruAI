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
  const nodeCall = async (path, body) => (await call('/gateways/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${nodeToken}` }, body: JSON.stringify(body) })).json();
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
 const tools=await fileAgentTools(env,context);
 expect(tools.create_file_text.parameters.properties.scope).toBeUndefined();
 const args={requestId:`file-${crypto.randomUUID()}`,path:'report.md',text:'local tool output',contentType:'text/markdown',scope:'workspace'};
 const created=JSON.parse(await tools.create_file_text.run(args));expect(created.saved).toBe(true);
 const link=new URL(created.openUrl);expect(link.origin).toBe('https://app.honmaruai.com');expect(link.hash).toContain(`file=${args.requestId}`);expect(link.hash).not.toContain('scope=workspace');
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
