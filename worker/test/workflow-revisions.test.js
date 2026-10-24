import {env} from 'cloudflare:test';
import {test,expect,beforeEach} from 'vitest';
import {upsertUser,upsertMembership,upsertBusiness} from '../src/db.js';
import {createWorkflow,updateWorkflow} from '../src/harness/workflows.js';
import {workflowRevisions} from '../src/harness/workflowRevisions.js';
let workflow;
beforeEach(async()=>{
 await upsertUser(env.DB,{githubId:'revision-user',login:'revision-user',name:'Reviewer'});
 await upsertMembership(env.DB,'revision-org','revision-user','member');
 await upsertBusiness(env.DB,'revision-org',{name:'Public',createdBy:'revision-user'});
 ({workflow}=await createWorkflow(env.DB,'revision-org',{name:'First',trigger:{type:'manual'},steps:[{type:'post',channel:'b:public',text:'First version'}]},'revision-user'));
});
const read=(options)=>workflowRevisions(env.DB,'revision-org',workflow.id,'revision-user',options);
test('all definition writers create atomic immutable versions without secrets or scheduling noise',async()=>{
 await updateWorkflow(env.DB,'revision-org',workflow.id,{name:'Second'});
 await env.DB.prepare("UPDATE hx_workflows SET next_run_at='later',last_run_at='now',hook_secret='secret' WHERE id=?1").bind(workflow.id).run();
 await env.DB.prepare("UPDATE hx_workflows SET enabled=0 WHERE id=?1").bind(workflow.id).run();
 const {items}=await read();
 expect(items.map(x=>x.revision)).toEqual([3,2,1]);
 expect(items[0].definition.enabled).toBe(false);
 expect(items[2].definition.name).toBe('First');
 expect(JSON.stringify(items)).not.toContain('secret');
 await expect(env.DB.prepare("UPDATE hx_workflow_revisions SET definition='{}' WHERE workflow_id=?1").bind(workflow.id).run()).rejects.toThrow();
});
test('versions from private resources remain hidden after the current definition becomes public',async()=>{
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,private,created_at) VALUES('revision-org','private','Private',1,'now')").run();
 await updateWorkflow(env.DB,'revision-org',workflow.id,{steps:[{type:'post',channel:'b:private',text:'Private content'}]});
 await updateWorkflow(env.DB,'revision-org',workflow.id,{steps:workflow.steps});
 const result=await read();
 expect(result.items.map(x=>x.revision)).toEqual([3,1]);
 expect(JSON.stringify(result)).not.toContain('Private content');
 expect((await workflowRevisions(env.DB,'other',workflow.id,'revision-user')).status).toBe(404);
});
test('history pagination is bounded and workflow deletion owns its cleanup',async()=>{
 for(let n=0;n<22;n++)await env.DB.prepare('UPDATE hx_workflows SET name=?1 WHERE id=?2').bind(`Name ${n}`,workflow.id).run();
 const first=await read();expect(first.items).toHaveLength(20);expect(first.nextCursor).toBe(4);
 const second=await read({before:first.nextCursor});expect(second.items.map(x=>x.revision)).toEqual([3,2,1]);expect(second.nextCursor).toBeNull();
 expect((await read({before:-1})).status).toBe(400);
 await env.DB.prepare('DELETE FROM hx_workflows WHERE id=?1').bind(workflow.id).run();
 expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_revisions').first()).n).toBe(0);
});

test('the production CREATE-prefixed migration path backfills existing definitions and is repeatable',async()=>{
 const {default:sql}=await import('../migrations.sql?raw');
 for(const name of ['hx_workflow_revision_insert','hx_workflow_revision_update','hx_workflow_revision_immutable'])await env.DB.exec(`DROP TRIGGER ${name}`);
 await env.DB.exec('DROP TABLE hx_workflow_revisions');
 const statements=sql.split(/\r?\n/).filter(line=>/^CREATE /.test(line)&&line.includes('hx_workflow_revision'));
 expect(statements).toHaveLength(4);
 for(let pass=0;pass<2;pass++)for(const statement of statements)await env.DB.exec(statement);
 expect((await read()).items.map(item=>item.revision)).toEqual([1]);
 await updateWorkflow(env.DB,'revision-org',workflow.id,{name:'After migration'});
 expect((await read()).items.map(item=>item.revision)).toEqual([2,1]);
});

test('a run records its matching frozen definition version even if the workflow has since changed',async()=>{
 const {startRun,getRun,listRuns}=await import('../src/harness/workflows.js');
 await updateWorkflow(env.DB,'revision-org',workflow.id,{enabled:false});
 const run=await startRun(env,{orgId:'revision-org',workflow,trigger:'manual',startedBy:'revision-user'});
 expect(run.status).toBe('done');
 expect(run.definitionRevision).toBe(1);
 expect((await getRun(env.DB,'revision-org',run.id)).definitionRevision).toBe(1);
 expect((await listRuns(env.DB,'revision-org',workflow.id))[0].definitionRevision).toBe(1);
 await updateWorkflow(env.DB,'revision-org',workflow.id,{name:'Newest definition'});
 expect((await getRun(env.DB,'revision-org',run.id)).definitionRevision).toBe(1);
});
