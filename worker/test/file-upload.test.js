import {pruneEmptyFileReservations} from '../src/harness/fileReservations.js';
import {env} from 'cloudflare:test';
import {beforeEach,test,expect,vi} from 'vitest';
import sql from '../workspace-files.sql?raw';
import {upsertUser,upsertMembership} from '../src/db.js';
import {createFileLedger,readFileVersionContent,appendFileVersion} from '../src/harness/fileVersionLedger.js';
import {uploadFileVersion,restoreFileVersion} from '../src/harness/fileUpload.js';
import {handleFileWrites} from '../src/harness/fileWriteRoutes.js';
import {handleFileReads} from '../src/harness/fileReadRoutes.js';
import {pruneHistoricalFiles,expireCurrentFiles,maintainFileRetention} from '../src/harness/fileRetention.js';
import {retryMediaDeletions} from '../src/files.js';
import {maintainWorkspaceFiles} from '../src/harness/fileMaintenance.js';
import {anonymizeFileAccount,queueFileAccountErasure,recoverFileAccountErasures} from '../src/harness/fileAccount.js';
import {exportAccount,deleteAccount} from '../src/account.js';
import {purgeWorkspace} from '../src/workspaceDeletion.js';
import {listWorkspaceFiles} from '../src/harness/fileList.js';
import {purgeFileVersion,purgeDeletedFile} from '../src/harness/filePurge.js';
import {downloadFileVersion} from '../src/harness/fileDownload.js';
import {recoverFileUploads} from '../src/harness/fileUploadRecovery.js';
const base={orgId:'upload-org',fileId:'file',userId:'writer',expectedVersion:0};
const stream=text=>new Blob([text]).stream();
const upload=(extra={},environment=env)=>uploadFileVersion(environment,{...base,stream:stream('hello'),size:5,contentType:'text/plain',...extra});
const read=()=>readFileVersionContent(env.DB,{...base,version:1});
beforeEach(async()=>{
 await env.DB.exec(sql.replace(/\n/g,' '));
 await upsertUser(env.DB,{githubId:'writer',login:'file-writer',name:'Writer'});
 await upsertMembership(env.DB,'upload-org','writer','member');
 await createFileLedger(env.DB,{...base,scope:'workspace',path:'report.txt',createdBy:'writer'});
});
test('stored bytes, hash and immutable version agree before success is returned',async()=>{
 expect(await upload()).toEqual({saved:true,version:1});
 const version=await read();expect(version.contentHash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
 expect(await (await env.MEDIA.get(version.objectKey)).text()).toBe('hello');
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').all()).results).toEqual([]);
});
test('short or long streams never commit a version',async()=>{
 for(const text of ['bad','too long'])await expect(upload({stream:stream(text)})).rejects.toThrow();
 expect(await read()).toBeNull();expect((await env.MEDIA.list()).objects).toHaveLength(0);
 const stages=(await env.DB.prepare('SELECT status FROM hx_workspace_file_uploads').all()).results;
 expect(stages).toHaveLength(2);expect(stages.every(row=>row.status==='cleanup')).toBe(true);
});
test('membership revoked while bytes are in flight prevents commit and cleans the uploaded object',async()=>{
 const media={put:async(...args)=>{const result=await env.MEDIA.put(...args);await env.DB.prepare("DELETE FROM memberships WHERE org_id='upload-org'").run();return result;},head:(...args)=>env.MEDIA.head(...args),delete:(...args)=>env.MEDIA.delete(...args)};
 expect(await upload({}, {...env,MEDIA:media})).toEqual({saved:false});
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(0);
});
test('racing uploads retain only the winning content and never delete its object',async()=>{
 const results=await Promise.all([upload(),upload({stream:stream('world')})]);
 expect(results.filter(result=>result.saved)).toHaveLength(1);
 const version=await read(),object=await env.MEDIA.get(version.objectKey);
 expect(['hello','world']).toContain(await object.text());expect((await env.MEDIA.list()).objects).toHaveLength(1);
});
test('failed cleanup is tracked for retry without publishing content',async()=>{
 const media={put:async()=>{throw Error('storage failed')},delete:async()=>{throw Error('delete failed')}};
 await expect(upload({}, {...env,MEDIA:media})).rejects.toThrow('storage failed');
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
 expect((await env.DB.prepare('SELECT status FROM hx_workspace_file_uploads').first()).status).toBe('cleanup');
 expect(await read()).toBeNull();
});
test('empty files are stored with their real empty-content hash',async()=>{
 expect(await upload({stream:stream(''),size:0})).toEqual({saved:true,version:1});
 const version=await read();expect(version.size).toBe(0);
 expect(version.contentHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
 expect(await (await env.MEDIA.get(version.objectKey)).text()).toBe('');
});
test('lost commit response does not delete successfully committed content',async()=>{
 const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{await env.DB.batch(statements);throw Error('commit response lost');}};
 expect(await upload({}, {...env,DB:db})).toEqual({saved:true,version:1});
 const version=await read();expect(await (await env.MEDIA.get(version.objectKey)).text()).toBe('hello');
 expect((await env.DB.prepare('SELECT status FROM hx_workspace_file_uploads').first()).status).toBe('uploading');
 expect(await recoverFileUploads(env,{now:Date.now()+600000})).toEqual({examined:1,cleaned:0,committed:1,failed:0});
 expect(await (await env.MEDIA.get(version.objectKey)).text()).toBe('hello');
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').all()).results).toHaveLength(0);
});
test('expired in-flight upload cannot commit after recovery claims its key',async()=>{
 let started,release;const ready=new Promise(resolve=>{started=resolve}),hold=new Promise(resolve=>{release=resolve});
 const media={put:async(...args)=>{started();await hold;return env.MEDIA.put(...args);},head:(...args)=>env.MEDIA.head(...args),delete:(...args)=>env.MEDIA.delete(...args)};
 const pending=upload({}, {...env,MEDIA:media});await ready;
 const now=Date.now()+600000;
 expect(await recoverFileUploads(env,{now})).toEqual({examined:1,cleaned:1,committed:0,failed:0});
 release();expect(await pending).toEqual({saved:false});
 expect(await read()).toBeNull();expect((await env.MEDIA.list()).objects).toHaveLength(0);
 const stage=await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').first();
 // Simulate a delayed storage completion after request-side cleanup/crash.
 await env.MEDIA.put(stage.object_key,'late');
 expect((await recoverFileUploads(env,{now:now+3600001})).cleaned).toBe(1);
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').all()).results).toHaveLength(1);
});
test('cleanup identity survives file deletion and active leases are left alone',async()=>{
 const now=Date.now();
 await env.DB.prepare(`INSERT INTO hx_workspace_file_uploads VALUES ('upload-org','orphan','file','org/upload-org/workspace-files/orphan','writer',0,?,?,'uploading')`).bind(now,now+300000).run();
 await env.MEDIA.put('org/upload-org/workspace-files/orphan','orphan');
 expect(await recoverFileUploads(env,{now})).toEqual({examined:0,cleaned:0,committed:0,failed:0});
 await env.DB.prepare("DELETE FROM hx_workspace_files WHERE org_id='upload-org'").run();
 expect((await recoverFileUploads(env,{now:now+300001})).cleaned).toBe(1);
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
test('recovery bounds each pass and records failed deletion without reporting success',async()=>{
 const now=Date.now();
 for(const id of ['a','b'])await env.DB.prepare(`INSERT INTO hx_workspace_file_uploads VALUES ('upload-org',?,'file',?,'writer',0,?,?,'uploading')`).bind(id,`org/upload-org/workspace-files/${id}`,now,now).run();
 const media={delete:async()=>{throw Error('storage unavailable');}};
 expect(await recoverFileUploads({...env,MEDIA:media},{now,limit:1})).toEqual({examined:1,cleaned:0,committed:0,failed:1});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
 expect(await recoverFileUploads(env,{now,limit:1})).toEqual({examined:1,cleaned:1,committed:0,failed:0});
 expect((await env.DB.prepare("SELECT * FROM hx_workspace_file_uploads WHERE status='cleanup'").all()).results).toHaveLength(2);
});

test('restoring deleted content appends independent bytes and preserves the source',async()=>{
 await upload();const original=await read();
 await appendFileVersion(env.DB,{...base,createdBy:base.userId,expectedVersion:1,kind:'deleted'});
 expect(await restoreFileVersion(env,{...base,expectedVersion:2,version:1})).toEqual({saved:true,version:3});
 const restored=await readFileVersionContent(env.DB,{...base,version:3});
 expect(restored.objectKey).not.toBe(original.objectKey);
 expect(await (await env.MEDIA.get(restored.objectKey)).text()).toBe('hello');
 expect((await env.DB.prepare('SELECT restored_from FROM hx_workspace_file_versions WHERE version=3').first()).restored_from).toBe(1);
 expect(await restoreFileVersion(env,{...base,expectedVersion:2,version:1})).toEqual({saved:false});
 expect((await env.MEDIA.list()).objects).toHaveLength(2);
});
test('corrupted source bytes cannot become a restored version',async()=>{
 await upload();const original=await read();await env.MEDIA.put(original.objectKey,'other');
 expect(await restoreFileVersion(env,{...base,expectedVersion:1,version:1})).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(1);
 expect((await env.MEDIA.list()).objects).toHaveLength(1);
});
test('purge occurring while restore copies bytes prevents the new version',async()=>{
 await upload();
 const media={get:(...args)=>env.MEDIA.get(...args),head:(...args)=>env.MEDIA.head(...args),delete:(...args)=>env.MEDIA.delete(...args),put:async(...args)=>{
  const result=await env.MEDIA.put(...args);
  await env.DB.prepare("INSERT INTO hx_workspace_file_purges VALUES ('upload-org','file',1,'writer','2026-10-25','test purge')").run();return result;
 }};
 expect(await restoreFileVersion({...env,MEDIA:media},{...base,expectedVersion:1,version:1})).toEqual({saved:false});
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(1);
 expect((await env.MEDIA.list()).objects).toHaveLength(1);
});
test('revoked readers cannot retrieve source bytes for restoration',async()=>{
 await upload();await env.DB.prepare("DELETE FROM memberships WHERE org_id='upload-org'").run();
 let accessed=false;const media={get:async()=>{accessed=true;throw Error('must not read');}};
 expect(await restoreFileVersion({...env,MEDIA:media},{...base,expectedVersion:1,version:1})).toEqual({saved:false});expect(accessed).toBe(false);
});

test('download verifies content and returns a non-cacheable attachment',async()=>{
 await upload();const response=await downloadFileVersion(env,{...base,version:1});
 expect(await response.text()).toBe('hello');expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(response.headers.get('content-disposition')).toBe('attachment; filename="file-v1"');
 expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
test('download rechecks access after reading storage',async()=>{
 await upload();const media={get:async key=>{const object=await env.MEDIA.get(key);await env.DB.prepare("DELETE FROM memberships WHERE org_id='upload-org'").run();return object;}};
 expect(await downloadFileVersion({...env,MEDIA:media},{...base,version:1})).toBeNull();
});
test('download rechecks purge after reading storage',async()=>{
 await upload();const media={get:async key=>{const object=await env.MEDIA.get(key);await env.DB.prepare("INSERT INTO hx_workspace_file_purges VALUES ('upload-org','file',1,'writer','2026-10-25','test purge')").run();return object;}};
 expect(await downloadFileVersion({...env,MEDIA:media},{...base,version:1})).toBeNull();
});
test('download refuses corrupt bytes even if their size matches',async()=>{
 await upload();const source=await read();await env.MEDIA.put(source.objectKey,'other');
 await expect(downloadFileVersion(env,{...base,version:1})).rejects.toThrow('Stored file content differs.');
});

const purge=(reason='Remove obsolete file')=>purgeFileVersion(env.DB,{...base,version:1,reason});
const makeHistorical=async()=>{await upload();await upload({expectedVersion:1,stream:stream('newer')});};
test('purge refuses current content and records authorized historical deletion',async()=>{
 await upload();expect(await purge()).toEqual({purged:false});
 await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id='upload-org'").run();
 expect(await purge()).toEqual({purged:false});
 await upload({expectedVersion:1,stream:stream('newer')});
 expect(await purge()).toEqual({purged:true});expect(await read()).toBeNull();
 const audit=await env.DB.prepare('SELECT * FROM hx_workspace_file_purges').first();expect(audit.reason).toBe('Remove obsolete file');expect(audit.created_by).toBe('writer');
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
 expect(await restoreFileVersion(env,{...base,expectedVersion:2,version:1})).toEqual({saved:false});
});
test('active person or scope holds prevent purge and deletion queue creation',async()=>{
 await makeHistorical();await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id='upload-org'").run();
 for(const [kind,target] of [['person','file-writer'],['channel','workspace']]){
  await env.DB.prepare("INSERT INTO message_holds VALUES (?, 'upload-org', ?, ?, 'preserve', 'writer', '2026-10-25', NULL, NULL)").bind(kind,kind,target).run();
  expect(await purge()).toEqual({purged:false});
  expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
  await env.DB.prepare('UPDATE message_holds SET released_at=? WHERE id=?').bind('2026-10-26',kind).run();
 }
 expect(await purge()).toEqual({purged:true});
});
test('purge rejects absent reasons and member requests on historical versions',async()=>{
 await makeHistorical();await expect(purge(' ')).rejects.toThrow();
 await upsertUser(env.DB,{githubId:'other',login:'other',name:'Other'});await upsertMembership(env.DB,'upload-org','other','member');
 expect(await purgeFileVersion(env.DB,{...base,userId:'other',version:1,reason:'Not my file'})).toEqual({purged:false});
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_purges').all()).results).toHaveLength(0);
});

test('shared historical storage is retained until every reference is purged and cannot be reused',async()=>{
 await upload();const source=await read();
 await appendFileVersion(env.DB,{...base,createdBy:'writer',expectedVersion:1,...source});
 await appendFileVersion(env.DB,{...base,createdBy:'writer',expectedVersion:2,kind:'deleted'});
 await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id='upload-org'").run();
 expect(await purge()).toEqual({purged:true});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
 expect(await appendFileVersion(env.DB,{...base,createdBy:'writer',expectedVersion:3,...source})).toEqual({saved:false});
 expect(await purgeFileVersion(env.DB,{...base,version:2,reason:'Remove final reference'})).toEqual({purged:true});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
});
test('administrator role does not bypass inaccessible file scope for purge',async()=>{
 await makeHistorical();await env.DB.prepare("UPDATE memberships SET role='admin' WHERE org_id='upload-org'").run();
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:private-room' WHERE org_id='upload-org'").run();
 expect(await purge()).toEqual({purged:false});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
});

test('file creator can purge historical content without workspace administrator role',async()=>{
 await makeHistorical();expect(await purge()).toEqual({purged:true});
});

const purgeAll=expectedVersion=>purgeDeletedFile(env.DB,{...base,expectedVersion,reason:'Erase deleted file history'});
const tombstone=expectedVersion=>appendFileVersion(env.DB,{...base,createdBy:'writer',expectedVersion,kind:'deleted'});
test('whole-file purge requires the expected deleted current version and is repeatable',async()=>{
 await makeHistorical();expect(await purgeAll(2)).toEqual({purgedCount:0});
 await tombstone(2);expect(await purgeAll(2)).toEqual({purgedCount:0});
 expect(await purgeAll(3)).toEqual({purgedCount:2});expect(await purgeAll(3)).toEqual({purgedCount:0});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(2);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_purges').all()).results).toHaveLength(2);
 expect((await env.DB.prepare('SELECT current_version FROM hx_workspace_files').first()).current_version).toBe(3);
});
test('restoration invalidates a pending whole-file purge confirmation',async()=>{
 await makeHistorical();await tombstone(2);
 expect(await restoreFileVersion(env,{...base,expectedVersion:3,version:1})).toEqual({saved:true,version:4});
 expect(await purgeAll(3)).toEqual({purgedCount:0});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
});
test('a hold on any historical writer blocks the whole-file purge atomically',async()=>{
 await upload();await upsertUser(env.DB,{githubId:'editor',login:'held-editor',name:'Editor'});await upsertMembership(env.DB,'upload-org','editor','member');
 await upload({userId:'editor',expectedVersion:1,stream:stream('other')});await tombstone(2);
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-editor','upload-org','person','held-editor','preserve','writer','2026-10-25',NULL,NULL)").run();
 expect(await purgeAll(3)).toEqual({purgedCount:0});
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_purges').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
});

test('historical writer hold survives a renamed or removed user identity',async()=>{
 await upload();await upsertUser(env.DB,{githubId:'editor',login:'old-editor',name:'Editor'});await upsertMembership(env.DB,'upload-org','editor','member');
 await upload({userId:'editor',expectedVersion:1,stream:stream('other')});await tombstone(2);
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-old','upload-org','person','old-editor','preserve','writer','2026-10-25',NULL,NULL)").run();
 await env.DB.prepare("UPDATE users SET login='new-editor' WHERE github_id='editor'").run();
 expect(await purgeAll(3)).toEqual({purgedCount:0});
 await env.DB.prepare("DELETE FROM memberships WHERE user_github_id='editor'").run();
 await env.DB.prepare("DELETE FROM users WHERE github_id='editor'").run();
 expect(await purgeAll(3)).toEqual({purgedCount:0});
 expect(await purgeFileVersion(env.DB,{...base,version:2,reason:'Remove historical copy'})).toEqual({purged:false});
});

const list=extra=>listWorkspaceFiles(env.DB,{...base,scope:'workspace',...extra});
test('file listing returns current metadata only and preserves literal search characters',async()=>{
 await upload();const result=await list({query:'REPORT',type:'doc'});expect(result.files).toHaveLength(1);expect(result.files[0].path).toBe('report.txt');
 expect(JSON.stringify(result)).not.toContain('objectKey');expect(JSON.stringify(result)).not.toContain('contentHash');
 expect((await list({query:'%'})).files).toHaveLength(0);expect((await list({type:'image'})).files).toHaveLength(0);
 expect((await list({directory:'repo'})).files).toHaveLength(1);expect((await list({createdBy:'other'})).files).toHaveLength(0);
 expect((await list({since:'2099-01-01'})).files).toHaveLength(0);
});
test('file search excludes inaccessible scopes, revoked readers, drafts and deleted files by default',async()=>{
 expect((await list({})).files).toHaveLength(0);await upload();
 await tombstone(1);expect((await list({})).files).toHaveLength(0);expect((await list({includeDeleted:true})).files[0].deleted).toBe(true);
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:private-room' WHERE org_id='upload-org'").run();
 expect((await list({scope:null,includeDeleted:true})).files).toHaveLength(0);
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='workspace' WHERE org_id='upload-org'").run();
 await env.DB.prepare("DELETE FROM memberships WHERE org_id='upload-org'").run();expect((await list({scope:null,includeDeleted:true})).files).toHaveLength(0);
});
test('file listing pages deterministically and requires an explicit scope',async()=>{
 await upload();await createFileLedger(env.DB,{...base,fileId:'second',scope:'workspace',path:'z.txt',createdBy:'writer'});await upload({fileId:'second'});
 const first=await list({limit:1});expect(first.files.map(f=>f.id)).toEqual(['file']);expect(first.next).toEqual({path:'report.txt',id:'file'});
 const second=await list({limit:1,cursor:first.next});expect(second.files.map(f=>f.id)).toEqual(['second']);expect(second.next).toBeNull();
 await expect(list({scope:undefined})).rejects.toThrow();await expect(list({since:'not-a-date'})).rejects.toThrow();await expect(list({limit:101})).rejects.toThrow();
});

test('workspace purge keeps anonymous cleanup identities to remove late storage writes',async()=>{
 const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{await env.DB.batch(statements);throw Error('commit response lost');}};
 await upload({}, {...env,DB:db});const source=await read();
 expect(await purgeWorkspace(env,'upload-org',{budget:1000})).toBe(true);
 const stage=await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').first();
 expect(stage.status).toBe('cleanup');expect(stage.created_by).toBe('');expect(stage.file_id).toBe('');
 expect((await env.MEDIA.list()).objects).toHaveLength(0);
 await env.MEDIA.put(source.objectKey,'late completion');
 expect((await recoverFileUploads(env)).cleaned).toBe(1);expect((await env.MEDIA.list()).objects).toHaveLength(0);
});
test('a claimed or completed workspace deletion denies file access despite surviving membership',async()=>{
 await upload();
 await env.DB.prepare("INSERT INTO workspace_deletions(org_id,due_at,requested_by,requested_at,purge_started_at) VALUES ('upload-org','2026-10-25','writer','2026-09-25','2026-10-25')").run();
 expect(await read()).toBeNull();expect(await upload({expectedVersion:1})).toEqual({saved:false});expect((await list({})).files).toHaveLength(0);
 await env.DB.prepare("DELETE FROM workspace_deletions WHERE org_id='upload-org'").run();
 await env.DB.prepare("INSERT INTO workspace_tombstones VALUES ('upload-org','2026-10-25','writer')").run();
 expect(await read()).toBeNull();expect(await upload({expectedVersion:1})).toEqual({saved:false});
});

test('account export includes owned file history without storage credentials or inaccessible rooms',async()=>{
 await upload();await tombstone(1);await purge();
 let exported=await exportAccount(env.DB,'writer','file-writer');
 expect(exported.workspaceFiles.map(f=>f.id)).toEqual(['file']);expect(exported.workspaceFileVersions).toHaveLength(2);
 expect(exported.workspaceFileVersions[0].purged).toBe(1);
 expect(JSON.stringify(exported.workspaceFileVersions)).not.toContain('object_key');expect(JSON.stringify(exported.workspaceFileVersions)).not.toContain('content_hash');
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='g:private' WHERE org_id='upload-org'").run();
 exported=await exportAccount(env.DB,'writer','file-writer');expect(exported.workspaceFiles).toEqual([]);expect(exported.workspaceFileVersions).toEqual([]);
});

test('account deletion fences an in-flight upload and anonymizes its cleanup record',async()=>{
 let started,release;const ready=new Promise(resolve=>{started=resolve}),hold=new Promise(resolve=>{release=resolve});
 const media={put:async(...args)=>{started();await hold;return env.MEDIA.put(...args);},head:(...args)=>env.MEDIA.head(...args),delete:(...args)=>env.MEDIA.delete(...args)};
 const pending=upload({}, {...env,MEDIA:media});await ready;
 await deleteAccount(env.DB,'writer','file-writer');
 const stage=await env.DB.prepare('SELECT * FROM hx_workspace_file_uploads').first();expect(stage.created_by).toBe('');expect(stage.status).toBe('cleanup');
 release();expect(await pending).toEqual({saved:false});
 expect((await env.MEDIA.list()).objects).toHaveLength(0);expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(0);
});

test('account deletion anonymizes shared file authors without changing immutable content',async()=>{
 await upload();const before=await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').first();
 await deleteAccount(env.DB,'writer','file-writer');
 const after=await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').first();
 expect(after).toEqual({...before,created_by:'deleted-user',created_login:'deleted-user'});
 expect((await env.DB.prepare('SELECT created_by,created_login FROM hx_workspace_files').first())).toEqual({created_by:'deleted-user',created_login:'deleted-user'});
 await expect(env.DB.prepare("UPDATE hx_workspace_file_versions SET created_by='deleted-user',created_login='deleted-user',size=0").run()).rejects.toThrow('immutable');
});
test('held author evidence survives account deletion and can be anonymized after release',async()=>{
 await upload();await upsertUser(env.DB,{githubId:'viewer',login:'viewer',name:'Viewer'});await upsertMembership(env.DB,'upload-org','viewer','member');
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-author','upload-org','person','file-writer','preserve','writer','2026-10-25',NULL,NULL)").run();
 await deleteAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('writer');
 expect((await list({userId:'viewer'})).files[0].createdBy).toBe('deleted-user');
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-author'").run();
 await anonymizeFileAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('deleted-user');
});

test('immutable version cannot be anonymized while its author account still exists',async()=>{
 await upload();await anonymizeFileAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('writer');
 await expect(env.DB.prepare("UPDATE hx_workspace_file_versions SET created_by='deleted-user',created_login='deleted-user'").run()).rejects.toThrow('immutable');
});

test('erasure recovery waits for hold release then discards its retained identity',async()=>{
 await upload();await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-recovery','upload-org','person','file-writer','preserve','writer','2026-10-25',NULL,NULL)").run();
 await deleteAccount(env.DB,'writer','file-writer');const now=Date.now();
 expect(await recoverFileAccountErasures(env.DB,{now})).toEqual({examined:1,completed:0});
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('writer');
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-recovery'").run();
 expect(await recoverFileAccountErasures(env.DB,{now:now+3600001})).toEqual({examined:1,completed:1});
 expect((await env.DB.prepare('SELECT * FROM hx_file_account_erasures').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('deleted-user');
});
test('recovery of an interrupted deletion request leaves an existing account intact',async()=>{
 await upload();await queueFileAccountErasure(env.DB,'writer','file-writer');
 expect(await recoverFileAccountErasures(env.DB)).toEqual({examined:1,completed:0});
 expect((await env.DB.prepare('SELECT created_by FROM hx_workspace_file_versions').first()).created_by).toBe('writer');
 expect(await env.DB.prepare("SELECT 1 FROM users WHERE github_id='writer'").first()).not.toBeNull();
});

test('file maintenance is bounded and tolerates an unreleased partial schema',async()=>{
 expect(await maintainWorkspaceFiles(env)).toEqual({enabled:true,uploads:{examined:0,cleaned:0,committed:0,failed:0},accounts:{examined:0,completed:0},retention:{current:{examined:0,expired:0},history:{examined:0,purged:0}},reservations:{removed:0}});
 await env.DB.prepare('DROP TABLE hx_file_account_erasures').run();
 expect(await maintainWorkspaceFiles(env)).toEqual({enabled:false});
});

test('account deletion removes personal files while preserving shared and similarly named rooms',async()=>{
 await upload();await env.DB.prepare("UPDATE users SET login='file_writer' WHERE github_id='writer'").run();
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='dm:file_writer|someone' WHERE id='file'").run();
 for(const [id,scope] of [['agent-file','ag:agent|file_writer'],['shared','workspace'],['other-dm','dm:fileXwriter|someone']]){
  await createFileLedger(env.DB,{...base,fileId:id,scope:'workspace',path:id+'.txt',createdBy:'writer'});await upload({fileId:id});
  await env.DB.prepare('UPDATE hx_workspace_files SET scope=? WHERE id=?').bind(scope,id).run();
 }
 await deleteAccount(env.DB,'writer','file_writer');
 expect((await env.DB.prepare('SELECT id FROM hx_workspace_files ORDER BY id').all()).results.map(row=>row.id)).toEqual(['other-dm','shared']);
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(2);
 await retryMediaDeletions(env,Date.now()+1000);expect((await env.MEDIA.list()).objects).toHaveLength(2);
});
test('held personal content survives deletion and is erased after release',async()=>{
 await upload();await env.DB.prepare("UPDATE hx_workspace_files SET scope='dm:file-writer|someone'").run();
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-personal','upload-org','channel','dm:file-writer|someone','preserve','writer','2026-10-25',NULL,NULL)").run();
 await deleteAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_files').all()).results).toHaveLength(1);
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-personal'").run();
 expect((await recoverFileAccountErasures(env.DB,{now:Date.now()+3600001})).completed).toBe(1);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_files').all()).results).toHaveLength(0);
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
});

test('personal erasure does not delete a blob still referenced by a shared file',async()=>{
 await upload();const source=await read();
 await createFileLedger(env.DB,{...base,fileId:'shared-copy',scope:'workspace',path:'shared.txt',createdBy:'writer'});
 await appendFileVersion(env.DB,{...base,fileId:'shared-copy',createdBy:'writer',...source});
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='dm:file-writer|someone' WHERE id='file'").run();
 await deleteAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
 expect(await (await env.MEDIA.get(source.objectKey)).text()).toBe('hello');
 expect((await env.DB.prepare('SELECT id FROM hx_workspace_files').first()).id).toBe('shared-copy');
});

test('personal erasure honors a current-login hold on a renamed historical writer',async()=>{
 await upload();await upsertUser(env.DB,{githubId:'editor',login:'original-editor',name:'Editor'});await upsertMembership(env.DB,'upload-org','editor','member');
 await upload({userId:'editor',expectedVersion:1,stream:stream('other')});
 await env.DB.prepare("UPDATE users SET login='renamed-editor' WHERE github_id='editor'").run();
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='dm:file-writer|someone'").run();
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-renamed','upload-org','person','renamed-editor','preserve','editor','2026-10-25',NULL,NULL)").run();
 await deleteAccount(env.DB,'editor','renamed-editor');
 await deleteAccount(env.DB,'writer','file-writer');
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_files').all()).results).toHaveLength(1);
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-renamed'").run();
 expect((await recoverFileAccountErasures(env.DB,{now:Date.now()+3600001})).completed).toBe(2);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_files').all()).results).toHaveLength(0);
});

test('historical purge respects held current identity after renamed writer leaves',async()=>{
 await upload();await upsertUser(env.DB,{githubId:'editor',login:'old-editor',name:'Editor'});await upsertMembership(env.DB,'upload-org','editor','member');
 await upload({userId:'editor',expectedVersion:1,stream:stream('other')});await upload({expectedVersion:2});
 await env.DB.prepare("UPDATE users SET login='new-editor' WHERE github_id='editor'").run();
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-departed','upload-org','person','new-editor','preserve','writer','2026-10-25',NULL,NULL)").run();
 await deleteAccount(env.DB,'editor','new-editor');
 expect(await purgeFileVersion(env.DB,{...base,version:2,reason:'Remove history'})).toEqual({purged:false});
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-departed'").run();
 expect(await purgeFileVersion(env.DB,{...base,version:2,reason:'Remove history'})).toEqual({purged:true});
});

const retentionNow=Date.parse('2026-10-25T00:00:00.000Z');
const historicalForRetention=async(oldCurrent=false)=>{
 const objectKey='org/upload-org/workspace-files/retention-old';await env.MEDIA.put(objectKey,'hello');
 await appendFileVersion(env.DB,{...base,createdBy:'writer',objectKey,contentHash:'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',contentType:'text/plain',size:5,at:'2026-09-01T00:00:00.000Z'});
 if(!oldCurrent)await upload({expectedVersion:1});
};
const setRetention=async()=>env.DB.prepare("INSERT INTO org_governance(org_id,retention_files_days,updated_by,updated_at) VALUES ('upload-org',7,'writer','2026-10-25')").run();
test('historical file retention is opt-in and preserves the current version',async()=>{
 await historicalForRetention();expect(await pruneHistoricalFiles(env.DB,{now:retentionNow})).toEqual({examined:0,purged:0});
 await setRetention();expect(await pruneHistoricalFiles(env.DB,{now:retentionNow})).toEqual({examined:1,purged:1});
 expect(await read()).toBeNull();expect(await readFileVersionContent(env.DB,{...base,version:2})).not.toBeNull();
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
 expect((await env.DB.prepare('SELECT reason FROM hx_workspace_file_purges').first()).reason).toBe('Workspace file retention');
});
test('historical retention respects holds and rechecks policy inside the deletion transaction',async()=>{
 await historicalForRetention();await setRetention();
 await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-retention','upload-org','person','file-writer','preserve','writer','2026-10-25',NULL,NULL)").run();
 expect(await pruneHistoricalFiles(env.DB,{now:retentionNow})).toEqual({examined:0,purged:0});
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='hold-retention'").run();
 const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{await env.DB.prepare("UPDATE org_governance SET retention_files_days=NULL WHERE org_id='upload-org'").run();return env.DB.batch(statements);}};
 expect(await pruneHistoricalFiles(db,{now:retentionNow})).toEqual({examined:1,purged:0});
 expect(await read()).not.toBeNull();expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(0);
});

test('historical retention never silently removes even an expired current version',async()=>{
 await historicalForRetention(true);await setRetention();
 expect(await pruneHistoricalFiles(env.DB,{now:retentionNow})).toEqual({examined:0,purged:0});
 expect(await read()).not.toBeNull();
});

test('current expiration appends a tombstone before purging the expired bytes',async()=>{
 await historicalForRetention(true);await setRetention();
 expect(await maintainFileRetention(env.DB,{now:retentionNow})).toEqual({current:{examined:1,expired:1},history:{examined:1,purged:1}});
 const current=await env.DB.prepare('SELECT * FROM hx_workspace_files').first();expect(current.current_version).toBe(2);
 const version=await env.DB.prepare('SELECT * FROM hx_workspace_file_versions WHERE version=2').first();expect(version.kind).toBe('deleted');expect(version.created_by).toBe('system:retention');
 expect(await expireCurrentFiles(env.DB,{now:retentionNow})).toEqual({examined:0,expired:0});
 expect((await env.DB.prepare('SELECT * FROM media_deletions').all()).results).toHaveLength(1);
});
test('a fresh write between selection and expiration wins without an extra tombstone',async()=>{
 await historicalForRetention(true);await setRetention();
 const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{await upload({expectedVersion:1});return env.DB.batch(statements);}};
 expect(await expireCurrentFiles(db,{now:retentionNow})).toEqual({examined:1,expired:0});
 expect((await env.DB.prepare('SELECT kind FROM hx_workspace_file_versions WHERE version=2').first()).kind).toBe('content');
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(2);
});
test('a hold introduced after selection prevents current expiration',async()=>{
 await historicalForRetention(true);await setRetention();
 const db={prepare:(...args)=>env.DB.prepare(...args),batch:async statements=>{await env.DB.prepare("INSERT INTO message_holds VALUES ('hold-current','upload-org','channel','workspace','preserve','writer','2026-10-25',NULL,NULL)").run();return env.DB.batch(statements);}};
 expect(await expireCurrentFiles(db,{now:retentionNow})).toEqual({examined:1,expired:0});expect(await read()).not.toBeNull();
});

const fileRequest=(path,identity={},method='GET')=>{const request=new Request('https://example.test'+path,{method});return handleFileReads(request,env,new URL(request.url),{...base,headers:{'access-control-allow-origin':'*'},...identity});};
test('file read transport returns scoped metadata, history and verified downloadable bytes',async()=>{
 await upload();let response=await fileRequest('/hx/files?scope=workspace');expect(response.status).toBe(200);expect((await response.json()).files).toHaveLength(1);
 response=await fileRequest('/hx/files/file/versions');expect((await response.json()).versions[0].version).toBe(1);
 response=await fileRequest('/hx/files/file/versions/1/content');expect(response.status).toBe(200);expect(await response.text()).toBe('hello');expect(response.headers.get('access-control-allow-origin')).toBe('*');expect(response.headers.get('cache-control')).toBe('private, no-store');
});
test('file read transport rejects malformed filters and does not trust query identity',async()=>{
 await upload();for(const path of ['/hx/files','/hx/files?scope=workspace&limit=-1','/hx/files?scope=workspace&cursor=null','/hx/files?scope=workspace&includeDeleted=yes','/hx/files/file/versions/1x/content'])expect((await fileRequest(path)).status).toBe(400);
 const response=await fileRequest('/hx/files/file/versions/1/content?userId=writer',{userId:'outsider'});expect(response.status).toBe(404);
 expect((await fileRequest('/hx/files?scope=all&orgId=upload-org',{orgId:'other-org'})).status).toBe(200);
 expect((await fileRequest('/hx/files?scope=workspace',{},'POST')).status).toBe(405);
});

const writeRequest=(path,method,body,identity={},raw=false)=>{const request=new Request('https://example.test'+path,{method,headers:{'content-type':raw?'text/plain':'application/json'},body:raw?body:JSON.stringify(body)});return handleFileWrites(request,env,new URL(request.url),{...base,canWrite:true,principalType:'human',...identity});};
test('write transport creates uploads deletes and restores with expected versions',async()=>{
 let response=await writeRequest('/hx/files','POST',{scope:'workspace',path:'api.txt'});expect(response.status).toBe(201);const {id}=await response.json();
 response=await writeRequest(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',{},true);expect(response.status).toBe(200);
 expect((await writeRequest(`/hx/files/${id}`,'DELETE',{expectedVersion:0})).status).toBe(409);
 expect((await writeRequest(`/hx/files/${id}`,'DELETE',{expectedVersion:1})).status).toBe(200);
 expect((await writeRequest(`/hx/files/${id}/restore`,'POST',{version:1,expectedVersion:2})).status).toBe(200);
 expect((await fileRequest(`/hx/files/${id}/versions/3/content`)).status).toBe(200);
});
test('write permission and human purge identity cannot be supplied in command JSON',async()=>{
 await upload();await tombstone(1);
 expect((await writeRequest('/hx/files/file/purge','POST',{version:1,reason:'remove',principalType:'human'},{principalType:'agent'})).status).toBe(403);
 expect((await writeRequest('/hx/files/file','DELETE',{expectedVersion:2,canWrite:true},{canWrite:false})).status).toBe(403);
 expect((await writeRequest('/hx/files/file/purge','POST',{version:1,reason:'remove'})).status).toBe(200);
});
test('file commands reject missing versions oversized JSON and malformed upload lengths',async()=>{
 await upload();
 expect((await writeRequest('/hx/files/file','DELETE',{})).status).toBe(400);
 expect((await writeRequest('/hx/files','POST',{scope:'workspace',path:'x'.repeat(9000)})).status).toBe(400);
 expect((await writeRequest('/hx/files/file/content?expectedVersion=1&size=4','PUT','hello',{},true)).status).toBe(400);
 expect((await env.DB.prepare('SELECT * FROM hx_workspace_file_versions').all()).results).toHaveLength(1);
});

const seedFileRoomAdmin=async()=>{
 await upload();await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at) VALUES ('upload-org','managed','Managed','2026-10-25')").run();
 await env.DB.prepare("UPDATE hx_workspace_files SET scope='b:managed'").run();
 await upsertUser(env.DB,{githubId:'manager',login:'room-manager',name:'Manager'});await upsertMembership(env.DB,'upload-org','manager','member');
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_by,added_at) VALUES ('upload-org','b:managed','room-manager','file-writer','first-join')").run();
 await env.DB.prepare("INSERT INTO hx_room_access(org_id,channel,version) VALUES ('upload-org','b:managed',1)").run();
 await env.DB.prepare("INSERT INTO hx_room_roles SELECT 'upload-org','b:managed','person','manager','admin',created_at||'/first-join','writer','2026-10-25' FROM memberships WHERE org_id='upload-org' AND user_github_id='manager'").run();
};
test.each(['member','engineer','maintainer'])('a current %s room administrator can delete and purge a different creators file',async(role)=>{
 await seedFileRoomAdmin();
 await upsertMembership(env.DB,'upload-org','manager',role);
 expect(await appendFileVersion(env.DB,{...base,createdBy:'manager',expectedVersion:1,kind:'deleted'})).toEqual({saved:true,version:2});
 expect(await purgeFileVersion(env.DB,{...base,userId:'manager',version:1,reason:'Room cleanup'})).toEqual({purged:true});
});
test('room administrator rights do not revive after a room rejoin or role removal',async()=>{
 await seedFileRoomAdmin();
 await env.DB.prepare("UPDATE conversation_members SET added_at='second-join' WHERE login='room-manager'").run();
 expect(await appendFileVersion(env.DB,{...base,createdBy:'manager',expectedVersion:1,kind:'deleted'})).toEqual({saved:false});
 await env.DB.prepare("UPDATE conversation_members SET added_at='first-join' WHERE login='room-manager'").run();
 await env.DB.prepare("UPDATE hx_room_roles SET role='member' WHERE subject_id='manager'").run();
 expect(await appendFileVersion(env.DB,{...base,createdBy:'manager',expectedVersion:1,kind:'deleted'})).toEqual({saved:false});
});

test('deleted managed rooms deny file access even before their business row is archived',async()=>{
 await seedFileRoomAdmin();await env.DB.prepare("UPDATE hx_room_access SET deleted_at='2026-10-25' WHERE channel='b:managed'").run();
 expect(await read()).toBeNull();expect((await list({scope:null})).files).toHaveLength(0);
 expect(await upload({expectedVersion:1})).toEqual({saved:false});
});

test('empty reservation cleanup is bounded and preserves saved and unfenced uploads',async()=>{
 const now=Date.now(),old=new Date(now-8*86400000).toISOString();
 await upload();
 for(const id of ['empty-a','empty-b','active','recent'])await createFileLedger(env.DB,{...base,fileId:id,scope:'workspace',path:id+'.txt',createdBy:'writer',at:id==='recent'?new Date(now).toISOString():old});
 await env.DB.prepare('UPDATE hx_workspace_files SET created_at=?,updated_at=? WHERE id=?').bind(old,old,'file').run();
 await env.DB.prepare("INSERT INTO hx_workspace_file_uploads VALUES('upload-org','lease','active','org/upload-org/workspace-files/lease','writer',0,?,?, 'uploading')").bind(now-10000,now-1).run();
 expect(await pruneEmptyFileReservations(env.DB,{now,limit:1})).toEqual({removed:1});
 expect(await pruneEmptyFileReservations(env.DB,{now,limit:1})).toEqual({removed:1});
 expect((await env.DB.prepare('SELECT id FROM hx_workspace_files ORDER BY id').all()).results.map(row=>row.id)).toEqual(['active','file','recent']);
 // Expiry alone is insufficient: recovery must fence the uploader first.
 await env.DB.prepare("UPDATE hx_workspace_file_uploads SET status='cleanup' WHERE id='lease'").run();
 expect(await pruneEmptyFileReservations(env.DB,{now})).toEqual({removed:1});
 expect(await env.DB.prepare("SELECT 1 FROM hx_workspace_file_uploads WHERE id='lease'").first()).not.toBeNull();
 expect(await read()).not.toBeNull();
 await expect(pruneEmptyFileReservations(env.DB,{now,limit:101})).rejects.toThrow('bounds');
});

test('legal holds protect empty reservation metadata until released',async()=>{
 const now=Date.now(),old=new Date(now-8*86400000).toISOString();
 await env.DB.prepare('UPDATE hx_workspace_files SET created_at=?,updated_at=?').bind(old,old).run();
 await env.DB.prepare("INSERT INTO message_holds VALUES('reservation-hold','upload-org','person','file-writer','preserve','writer','2026-10-25',NULL,NULL)").run();
 expect(await pruneEmptyFileReservations(env.DB,{now})).toEqual({removed:0});
 await env.DB.prepare("UPDATE message_holds SET released_at='2026-10-26' WHERE id='reservation-hold'").run();
 expect(await pruneEmptyFileReservations(env.DB,{now})).toEqual({removed:1});
 expect(await createFileLedger(env.DB,{...base,scope:'workspace',path:'report.txt',createdBy:'writer'})).toEqual({created:true});
});

test('reservation holds follow the deleted account alias after a login rename',async()=>{
 const now=Date.now(),old=new Date(now-8*86400000).toISOString();
 await env.DB.prepare('UPDATE hx_workspace_files SET created_at=?,updated_at=?').bind(old,old).run();
 await env.DB.prepare("UPDATE users SET login='renamed-writer' WHERE github_id='writer'").run();
 await queueFileAccountErasure(env.DB,'writer','renamed-writer');
 await env.DB.prepare("DELETE FROM users WHERE github_id='writer'").run();
 await env.DB.prepare("INSERT INTO message_holds VALUES('alias-reservation-hold','upload-org','person','renamed-writer','preserve','writer','2026-10-25',NULL,NULL)").run();
 expect(await pruneEmptyFileReservations(env.DB,{now})).toEqual({removed:0});
});


test.each([
 ['$start_of_today','2025-12-31T15:30:00Z','2025-12-31T00:00:00.000Z'],
 ['$start_of_tomorrow','2025-12-31T15:30:00Z','2026-01-01T00:00:00.000Z'],
 ['$start_of_yesterday','2024-03-01T12:00:00Z','2024-02-29T00:00:00.000Z'],
 ['$start_of_7_days_ago','2026-01-01T12:00:00Z','2025-12-25T00:00:00.000Z'],
 ['$start_of_30_days_ago','2026-01-01T12:00:00Z','2025-12-02T00:00:00.000Z'],
])('relative file boundary %s respects UTC calendar transitions',async(literal,now,boundary)=>{
 await upload();
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(now));
 try{
  await env.DB.prepare('UPDATE hx_workspace_files SET created_at=? WHERE org_id=? AND id=?').bind(boundary,base.orgId,base.fileId).run();
  expect((await list({since:literal,until:literal})).files.map(f=>f.id)).toEqual(['file']);
  await env.DB.prepare('UPDATE hx_workspace_files SET created_at=? WHERE org_id=? AND id=?').bind(new Date(Date.parse(boundary)-1).toISOString(),base.orgId,base.fileId).run();
  expect((await list({since:literal})).files).toEqual([]);
 }finally{clock.mockRestore()}
});
