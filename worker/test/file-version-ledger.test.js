import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import sql from '../workspace-files.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createFileLedger,appendFileVersion,workspaceFilePath,listFileVersions,readFileVersionContent} from '../src/harness/fileVersionLedger.js';
const scope={orgId:'files-one',fileId:'document',createdBy:'owner'};
const content={objectKey:'org/files-one/workspace-files/object-one',contentHash:'a'.repeat(64),contentType:'text/plain',size:5};
const save=(extra={})=>appendFileVersion(env.DB,{...scope,expectedVersion:0,...content,...extra});
const versions=()=>env.DB.prepare('SELECT * FROM hx_workspace_file_versions WHERE org_id=? AND file_id=? ORDER BY version').bind(scope.orgId,scope.fileId).all();
beforeEach(async()=>{
 await env.DB.exec(sql.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:'owner',login:'file-owner',name:'Owner'});
 await upsertMembership(env.DB,'files-one','owner','member');
 await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at) VALUES('files-one','general','General','now'),('files-one','private','Private','now')").run();
 expect(await createFileLedger(env.DB,{...scope,scope:'b:general',path:'notes/report.txt'})).toEqual({created:true});
});
test('competing writes preserve one winner and immutable history',async()=>{
 const results=await Promise.all([save(),save({objectKey:'org/files-one/workspace-files/object-two',contentHash:'b'.repeat(64)})]);
 expect(results.filter(result=>result.saved)).toHaveLength(1);
 const history=(await versions()).results;expect(history).toHaveLength(1);
 expect(await save()).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT current_version FROM hx_workspace_files WHERE org_id=? AND id=?').bind(scope.orgId,scope.fileId).first()).current_version).toBe(1);
 await expect(env.DB.prepare("UPDATE hx_workspace_file_versions SET content_hash='changed'").run()).rejects.toThrow('immutable');
});
test('restore appends a new version after a deletion and refuses stale revision',async()=>{
 await save();
 expect(await save({expectedVersion:1,kind:'deleted',objectKey:null,contentHash:null,contentType:null,size:null})).toEqual({saved:true,version:2});
 expect(await save({expectedVersion:1,restoredFrom:1})).toEqual({saved:false});
 expect(await save({expectedVersion:2,restoredFrom:1,objectKey:'org/files-one/workspace-files/restored-copy'})).toEqual({saved:true,version:3});
 const rows=(await versions()).results;
 expect(rows.map(row=>row.kind)).toEqual(['content','deleted','content']);
 expect(rows[2].restored_from).toBe(1);expect(rows[0].object_key).toBe(content.objectKey);
});
test('purged history and mismatched restore metadata cannot become current',async()=>{
 await save();
 expect(await save({expectedVersion:1,restoredFrom:1,contentHash:'b'.repeat(64)})).toEqual({saved:false});
 await env.DB.prepare("INSERT INTO hx_workspace_file_purges VALUES('files-one','document',1,'owner','now','test removal')").run();
 expect(await save({expectedVersion:1,restoredFrom:1})).toEqual({saved:false});
 expect((await versions()).results).toHaveLength(1);
});
test('file identities and object metadata cannot cross workspace boundaries',async()=>{
 expect(await save({orgId:'other',objectKey:'org/other/workspace-files/object'})).toEqual({saved:false});
 await expect(save({objectKey:'org/other/workspace-files/object'})).rejects.toThrow('metadata');
 expect((await versions()).results).toHaveLength(0);
});
test('stable paths prevent duplicate identity while room scopes stay distinct',async()=>{
 expect(await createFileLedger(env.DB,{...scope,fileId:'duplicate',scope:'b:general',path:'notes/report.txt'})).toEqual({created:false});
 expect(await createFileLedger(env.DB,{...scope,fileId:'second',scope:'b:private',path:'notes/report.txt'})).toEqual({created:true});
 for(const path of ['/absolute','a/../b','a//b','a/./b','a\\b','a\n.txt'])expect(()=>workspaceFilePath(path)).toThrow();
});
test('invalid metadata and absent expected versions do not create partial records',async()=>{
 for(const extra of [{expectedVersion:undefined},{size:-1},{size:26*1024*1024},{kind:'deleted'},{restoredFrom:1}])await expect(save(extra)).rejects.toThrow();
 expect((await versions()).results).toHaveLength(0);
});

test('revoking current room or workspace access fences both creation and append',async()=>{
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id='files-one' AND slug='general'").run();
 expect(await save()).toEqual({saved:false});
 expect(await createFileLedger(env.DB,{...scope,fileId:'denied',scope:'b:general',path:'secret.txt'})).toEqual({created:false});
 await env.DB.prepare("INSERT INTO conversation_members VALUES('files-one','b:general','file-owner','file-owner','now')").run();
 expect(await save()).toEqual({saved:true,version:1});
 await env.DB.prepare("DELETE FROM memberships WHERE org_id='files-one' AND user_github_id='owner'").run();
 expect(await save({expectedVersion:1})).toEqual({saved:false});
});
test('archived, missing and unknown scopes fail closed',async()=>{
 await env.DB.prepare("UPDATE businesses SET archived_at='now' WHERE org_id='files-one'").run();
 expect(await save()).toEqual({saved:false});
 for(const scopeName of ['b:missing','unknown','g:missing','dm:file-owner|missing','ag:missing|file-owner'])
  expect(await createFileLedger(env.DB,{...scope,fileId:scopeName,scope:scopeName,path:'report.txt'})).toEqual({created:false});
});
test.each(['member','designer','engineer','triager','maintainer'])('%s standing may edit but cannot delete another creator file without administrator authority',async(role)=>{
 await upsertUser(env.DB,{githubId:'editor',login:'file-editor',name:'Editor'});
 await upsertMembership(env.DB,'files-one','editor',role);
 expect(await save({createdBy:'editor'})).toEqual({saved:true,version:1});
 expect(await save({createdBy:'editor',expectedVersion:1,kind:'deleted',objectKey:null,contentHash:null,contentType:null,size:null})).toEqual({saved:false});
 await upsertMembership(env.DB,'files-one','editor','admin');
 expect(await save({createdBy:'editor',expectedVersion:1,kind:'deleted',objectKey:null,contentHash:null,contentType:null,size:null})).toEqual({saved:true,version:2});
});

test('workspace guests cannot create files and group removal takes effect on append',async()=>{
 await upsertUser(env.DB,{githubId:'guest',login:'file-guest',name:'Guest'});
 await upsertMembership(env.DB,'files-one','guest','guest');
 expect(await createFileLedger(env.DB,{...scope,createdBy:'guest',fileId:'guest-file',scope:'workspace',path:'guest.txt'})).toEqual({created:false});
 await env.DB.prepare("INSERT INTO conversation_members VALUES('files-one','g:team','file-owner','file-owner','now')").run();
 expect(await createFileLedger(env.DB,{...scope,fileId:'group-file',scope:'g:team',path:'group.txt'})).toEqual({created:true});
 await env.DB.prepare("DELETE FROM conversation_members WHERE channel='g:team'").run();
 expect(await save({fileId:'group-file'})).toEqual({saved:false});
});
test('DM audience requires both participants current membership and cannot be impersonated',async()=>{
 await upsertUser(env.DB,{githubId:'peer',login:'file-peer',name:'Peer'});
 await upsertMembership(env.DB,'files-one','peer','member');
 expect(await createFileLedger(env.DB,{...scope,fileId:'dm-file',scope:'dm:file-owner|file-peer',path:'dm.txt'})).toEqual({created:true});
 await upsertUser(env.DB,{githubId:'outsider',login:'file-outsider',name:'Outsider'});
 await upsertMembership(env.DB,'files-one','outsider','admin');
 expect(await save({fileId:'dm-file',createdBy:'outsider'})).toEqual({saved:false});
 await env.DB.prepare("DELETE FROM memberships WHERE user_github_id='peer'").run();
 expect(await save({fileId:'dm-file'})).toEqual({saved:false});
});

const history=(extra={})=>listFileVersions(env.DB,{...scope,userId:'owner',...extra});
const readContent=(extra={})=>readFileVersionContent(env.DB,{...scope,userId:'owner',version:1,...extra});
test('history is paged newest first without disclosing internal object keys',async()=>{
 await save();await save({expectedVersion:1});await save({expectedVersion:2});
 const page=await history({limit:2});
 expect(page.map(row=>row.version)).toEqual([3,2]);expect(page[0].isCurrent).toBe(true);expect(page[1].isCurrent).toBe(false);
 expect(JSON.stringify(page)).not.toContain('object-one');expect(JSON.stringify(page)).not.toContain(content.contentHash);
 expect((await history({before:2})).map(row=>row.version)).toEqual([1]);
 expect(await readContent()).toMatchObject({objectKey:content.objectKey,version:1});
});
test('revoked readers cannot enumerate history or fetch historical content',async()=>{
 await save();
 expect(await history({orgId:'other'})).toEqual([]);expect(await readContent({orgId:'other'})).toBeNull();
 await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id='files-one'").run();
 expect(await history()).toEqual([]);expect(await readContent()).toBeNull();
});
test('tombstones and purged versions have no content receipt while history marks their state',async()=>{
 await save();await save({expectedVersion:1,kind:'deleted',objectKey:null,contentHash:null,contentType:null,size:null});
 expect(await readContent({version:2})).toBeNull();
 expect(await readContent()).not.toBeNull();
 await env.DB.prepare("INSERT INTO hx_workspace_file_purges VALUES('files-one','document',1,'owner','now','test removal')").run();
 expect(await readContent()).toBeNull();
 expect(await history()).toMatchObject([{version:2,kind:'deleted',isCurrent:true},{version:1,purged:true}]);
});

test('creation origin is atomic, cannot be reclassified by a conflicting create and filters files and folders consistently',async()=>{
 const {listWorkspaceFiles}=await import('../src/harness/fileList.js');
 const {listFileFolders}=await import('../src/harness/fileFolders.js');
 await save();
 for(const origin of ['human','agent']){
  expect(await createFileLedger(env.DB,{...scope,fileId:origin,scope:'b:general',path:`${origin}/note.txt`,origin})).toEqual({created:true});
  expect(await save({fileId:origin})).toMatchObject({saved:true});
 }
 expect(await createFileLedger(env.DB,{...scope,fileId:'human',scope:'b:general',path:'human/note.txt',origin:'agent'})).toEqual({created:false});
 expect(await createFileLedger(env.DB,{...scope,fileId:'private',scope:'g:unavailable',path:'private.txt',origin:'agent'})).toEqual({created:false});
 expect((await env.DB.prepare('SELECT source FROM hx_workspace_file_origins WHERE file_id=?').bind('human').first()).source).toBe('human');
 expect(await env.DB.prepare("SELECT 1 FROM hx_workspace_file_origins WHERE file_id='private'").first()).toBeNull();
 const identity={orgId:scope.orgId,userId:scope.createdBy,scope:'b:general'};
 for(const origin of ['human','agent','unknown']){
  const listed=await listWorkspaceFiles(env.DB,{...identity,origin});expect(listed.files).toHaveLength(1);expect(listed.files[0].origin).toBe(origin);
  expect((await listFileFolders(env.DB,{...identity,origin})).folders.map(f=>f.name)).toEqual([origin==='unknown'?'notes':origin]);
 }
 await expect(listWorkspaceFiles(env.DB,{...identity,origin:'spoof'})).rejects.toThrow('origin');
 await env.DB.prepare("DELETE FROM hx_workspace_files WHERE id='human'").run();
 expect(await env.DB.prepare("SELECT 1 FROM hx_workspace_file_origins WHERE file_id='human'").first()).toBeNull();
});

test('file change announcements target current readers without carrying file or room identifiers',async()=>{
 const {announceFileChanged}=await import('../src/harness/fileEvents.js');
 for(const [id,role] of [['peer','member'],['visitor','guest']]){await upsertUser(env.DB,{githubId:id,login:id,name:id});await upsertMembership(env.DB,scope.orgId,id,role)}
 const deliveries=[];
 const relay={idFromName:id=>id,get:()=>({fetch:async(_url,init)=>{deliveries.push(...JSON.parse(init.body).deliveries);return new Response('{}')}})};
 await announceFileChanged({...env,ORG_RELAY:relay},scope.orgId,scope.fileId);
 expect(deliveries.map(d=>d.to).sort()).toEqual(['file-owner','peer']);
 for(const d of deliveries){expect(d.event.name).toBe('workspace_files_changed');expect(d.event.value).toEqual({});}
 deliveries.length=0;
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:private' WHERE id=?").bind(scope.fileId).run();
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,'g:private','file-owner','now')").bind(scope.orgId).run();
 await announceFileChanged({...env,ORG_RELAY:relay},scope.orgId,scope.fileId);
 expect(deliveries.map(d=>d.to)).toEqual(['file-owner']);
 deliveries.length=0;
 await env.DB.prepare("DELETE FROM conversation_members WHERE channel='g:private'").run();
 await announceFileChanged({...env,ORG_RELAY:relay},scope.orgId,scope.fileId);expect(deliveries).toEqual([]);
});


test('supported engineer standing still requires a current agent grant for file access',async()=>{
 await upsertMembership(env.DB,'files-one','owner','engineer');
 await env.DB.prepare("INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES('files-one','file-agent','file-agent','Fixture Agent','','team','someone-else','now','now')").run();
 await env.DB.prepare("INSERT INTO hx_agent_profiles(org_id,agent_id,access,people,updated_at) VALUES('files-one','file-agent','private','[]','now')").run();
 const agentFile={...scope,fileId:'agent-file',scope:'ag:file-agent|file-owner',path:'agent.txt'};
 expect(await createFileLedger(env.DB,agentFile)).toEqual({created:false});
 await env.DB.prepare("INSERT INTO hx_agent_members(org_id,agent_id,user_id,role,member_since,updated_by,updated_at) SELECT org_id,'file-agent',user_github_id,'member',created_at,'owner','now' FROM memberships WHERE org_id='files-one' AND user_github_id='owner'").run();
 expect(await createFileLedger(env.DB,agentFile)).toEqual({created:true});
 expect(await save({fileId:'agent-file'})).toEqual({saved:true,version:1});
 expect(await readContent({fileId:'agent-file'})).not.toBeNull();
 await env.DB.prepare("UPDATE hx_agent_members SET member_since='stale' WHERE org_id='files-one' AND agent_id='file-agent'").run();
 expect(await readContent({fileId:'agent-file'})).toBeNull();
 expect(await save({fileId:'agent-file',expectedVersion:1})).toEqual({saved:false});
 expect(await createFileLedger(env.DB,{...agentFile,fileId:'stale-file',path:'stale.txt'})).toEqual({created:false});
});
