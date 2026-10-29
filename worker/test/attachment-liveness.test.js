import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';
import { deleteMessage } from '../src/channels.js';
import * as files from '../src/files.js';

const orgId = 'personal:attachment-liveness';
let token;
let sequence;
const attachment = async ({ messageId = null, channel = 'b:general', workspace = orgId, uploader = 'reader' } = {}) => {
  const id = `f_${(++sequence).toString(16).padStart(24, '0')}`;
  await env.DB.prepare(`INSERT INTO message_files(id,org_id,channel,message_id,uploader,name,type,size,created_at)
    VALUES(?,?,?,?,?,'fixture.txt','text/plain',7,'2026-10-01')`).bind(id,workspace,channel,messageId,uploader).run();
  await env.MEDIA.put(files.fileKey(workspace,id), 'fixture');
  return env.DB.prepare('SELECT * FROM message_files WHERE id=?').bind(id).first();
};
const message = (id, parentId = null, channel = 'b:general', workspace = orgId) => env.DB.prepare(`INSERT INTO channel_messages
  (id,org_id,channel,author_login,kind,body,parent_id,created_at) VALUES(?,?,?,'reader','message','fixture',?,'2026-10-01')`).bind(id,workspace,channel,parentId).run();
const renew = async ids => {
  const response = await worker.fetch(new Request('https://example.test/media/urls', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token }, body: JSON.stringify({ orgId, ids }),
  }), env);
  expect(response.status).toBe(200);
  return (await response.json()).files;
};
const read = async row => {
  const { path } = await files.signedPath(env,row);
  const url = new URL(path,'https://example.test');
  return files.serveFile(new Request(url),env,url);
};
beforeEach(async () => {
  sequence = 0;
  await upsertUser(env.DB,{ githubId:'liveness-reader',login:'reader',name:'Fixture Reader' });
  await upsertMembership(env.DB,orgId,'liveness-reader','member');
  token = await createSession(env.DB,'liveness-reader','test');
  await env.DB.prepare("INSERT INTO businesses(org_id,slug,name,created_at) VALUES(?,'general','General','now'),(?,'closed','Closed','now')").bind(orgId,orgId).run();
  await env.DB.prepare("UPDATE businesses SET private=1 WHERE org_id=? AND slug='closed'").bind(orgId).run();
});

test('a complete 100-file renewal request stays within the D1 parameter limit', async () => {
  const ids = Array.from({length:100}, (_, i) => `f_${(i+1).toString(16).padStart(24,'0')}`);
  await env.DB.batch(ids.map(id => env.DB.prepare(`INSERT INTO message_files
    (id,org_id,channel,uploader,name,type,size,created_at) VALUES(?,?,'b:general','reader','fixture.txt','text/plain',7,'2026-10-01')`).bind(id,orgId)));
  const sizes = [];
  const db = { prepare(sql) { return { bind(...args) {
    sizes.push(args.length);
    expect(args.length).toBeLessThanOrEqual(100);
    return env.DB.prepare(sql).bind(...args);
  }}; }};
  const refreshed = await files.freshFileUrls({...env,DB:db},{orgId,login:'reader',ids});
  expect(Object.keys(refreshed).sort()).toEqual([...ids].sort());
  expect(sizes).toContain(91);
  expect(sizes).toContain(11);
});

test.each(['reply','root'])('a %s tombstone denies attachment renewal and API-origin reads before cleanup starts', async target => {
  await message('root'); await message('reply','root');
  const root = await attachment({messageId:'root'});
  const reply = await attachment({messageId:'reply'});
  const issued = await renew([root.id,reply.id]);
  expect(Object.keys(issued)).toHaveLength(2);
  // Stop at the durable tombstone helper, before the route calls dropFiles.
  const deleted = await deleteMessage(env.DB,{orgId,id:target,authorLogin:'reader',withThread:true});
  expect(deleted.error).toBeUndefined();
  const denied = target === 'root' ? [root,reply] : [reply];
  for (const row of denied) {
    expect(await env.MEDIA.get(files.fileKey(orgId,row.id))).not.toBeNull();
    const url = new URL(issued[row.id].url,'https://example.test');
    expect((await files.serveFile(new Request(url),env,url)).status).toBe(404);
  }
  expect(Object.keys(await renew([root.id,reply.id]))).toEqual(target === 'root' ? [] : [root.id]);
  expect((await deleteMessage(env.DB,{orgId,id:target,authorLogin:'reader',withThread:true})).status).toBe(404);
  const failingStorage = {...env,MEDIA:{delete:async()=>{throw new Error('synthetic storage outage');}}};
  expect(await files.sweepDeletedFiles(failingStorage)).toBe(denied.length);
  expect((await env.DB.prepare('SELECT key FROM media_deletions').all()).results).toHaveLength(denied.length * 2);
  expect(await files.sweepDeletedFiles(env)).toBe(0);
  expect(await files.retryMediaDeletions(env,Date.now()+1000)).toEqual({deleted:denied.length*2,failed:0});
  expect(await files.retryMediaDeletions(env,Date.now()+1000)).toEqual({deleted:0,failed:0});
  for (const row of denied) expect(await env.MEDIA.get(files.fileKey(orgId,row.id))).toBeNull();
  if(target === 'reply')expect((await read(root)).status).toBe(200);
});

test('a root tombstone also fences a late reply not yet tombstoned by its second cleanup pass', async () => {
  await message('root'); await message('late','root');
  const reply = await attachment({messageId:'late'});
  await env.DB.prepare("UPDATE channel_messages SET deleted_at='now' WHERE org_id=? AND id='root'").bind(orgId).run();
  expect(await renew([reply.id])).toEqual({});
  expect((await read(reply)).status).toBe(404);
  expect(await files.sweepDeletedFiles(env)).toBe(1);
  expect(await env.MEDIA.get(files.fileKey(orgId,reply.id))).toBeNull();
});

test('only live matching sources or the uploaders own unsent files renew', async () => {
  await message('live');
  await message('foreign',null,'b:general','other-workspace');
  await message('closed',null,'b:closed');
  const live = await attachment({messageId:'live'});
  const own = await attachment();
  const others = [await attachment({uploader:'someone-else'}),await attachment({messageId:'foreign'}),await attachment({messageId:'live',channel:'b:other'}),await attachment({messageId:'closed',channel:'b:closed'}),await attachment({workspace:'other-workspace'})];
  expect(Object.keys(await renew([live.id,own.id,...others.map(row=>row.id)]))).toEqual([live.id,own.id]);
  expect((await read(live)).status).toBe(200);
  expect((await read(own)).status).toBe(200);
  expect((await read(others[1])).status).toBe(404);
  expect((await read(others[2])).status).toBe(404);
});

test('reconciliation keeps its durable row if retry bookkeeping fails and resumes safely', async () => {
  await message('deleted');
  const file = await attachment({messageId:'deleted'});
  await deleteMessage(env.DB,{orgId,id:'deleted',authorLogin:'reader'});
  const database = new Proxy(env.DB, {get(db,property){
    if(property==='prepare')return sql=>{
      if(!sql.includes('INSERT INTO media_deletions'))return db.prepare(sql);
      return {bind(){return this;},run:async()=>{throw new Error('synthetic database outage');}};
    };
    const value=db[property];return typeof value==='function'?value.bind(db):value;
  }});
  await expect(files.sweepDeletedFiles({...env,DB:database,MEDIA:{delete:async()=>{throw new Error('synthetic storage outage');}}})).rejects.toThrow('synthetic database outage');
  expect(await env.DB.prepare('SELECT id FROM message_files WHERE id=?').bind(file.id).first()).not.toBeNull();
  expect(await renew([file.id])).toEqual({});
  expect(await files.sweepDeletedFiles(env)).toBe(1);
  expect(await files.sweepDeletedFiles(env)).toBe(0);
  expect(await env.MEDIA.get(files.fileKey(orgId,file.id))).toBeNull();
});

test('reconciliation bounds each pass to 100 attachments and preserves live or unsent files', async () => {
  await message('deleted');await message('live');
  await env.DB.batch(Array.from({length:105},(_,i)=>env.DB.prepare(`INSERT INTO message_files
    (id,org_id,channel,message_id,uploader,name,type,size,created_at) VALUES(?,?,'b:general','deleted','reader','fixture.txt','text/plain',7,'now')`)
    .bind(`f_${(i+1000).toString(16).padStart(24,'0')}`,orgId)));
  const live = await attachment({messageId:'live'});const unsent = await attachment();
  await deleteMessage(env.DB,{orgId,id:'deleted',authorLogin:'reader'});
  const deleted=[];const environment={...env,MEDIA:{delete:async key=>deleted.push(key)}};
  expect(await files.sweepDeletedFiles(environment)).toBe(100);
  expect(deleted).toHaveLength(200);
  expect(await files.sweepDeletedFiles(environment)).toBe(5);
  expect(await files.sweepDeletedFiles(environment)).toBe(0);
  expect(deleted).toHaveLength(210);
  expect(new Set(deleted).size).toBe(210);
  expect(Object.keys(await renew([live.id,unsent.id]))).toEqual([live.id,unsent.id]);
});

test('previously issued media-origin links retain only their signed expiry while renewal is denied', async () => {
  const {signFileUrl}=await import('../src/mediaToken.js');
  const {serveMedia}=await import('../src/mediaWorker.js');
  const environment={...env,MEDIA_ORIGIN:'https://media.example.test',MEDIA_SIGNING_KEYS:JSON.stringify({fixture:'a'.repeat(64)}),MEDIA_SIGNING_KID:'fixture'};
  await message('deleted');const file=await attachment({messageId:'deleted'});
  const now=Date.now();
  const signed=await signFileUrl(environment,{orgId,id:file.id,type:file.type,name:file.name},now);
  await deleteMessage(env.DB,{orgId,id:'deleted',authorLogin:'reader'});
  expect(await files.freshFileUrls(environment,{orgId,login:'reader',ids:[file.id]},now)).toEqual({});
  expect((await serveMedia(new Request(signed.url),environment,now)).status).toBe(200);
  expect((await serveMedia(new Request(signed.url),environment,signed.expiresAt)).status).toBe(404);
});
