import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import { postMessage } from '../src/channels.js';
import { upsertBusiness, upsertMembership, upsertUser } from '../src/db.js';

const orgId = 'personal:creation-fence';
const actorId = 'creation-user';
const login = 'creation-login';
const key = 'b:source';
let snapshot;

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await upsertUser(env.DB, { githubId: actorId, login, name: 'Author', locale: 'en' });
  await upsertMembership(env.DB, orgId, actorId, 'member');
  await upsertBusiness(env.DB, orgId, { name: 'Source', createdBy: actorId });
  await env.DB.prepare('UPDATE businesses SET private=1 WHERE org_id=? AND slug=?').bind(orgId, 'source').run();
  await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,?)').bind(orgId, key, login, '2026-01-01').run();
  const room = await env.DB.prepare('SELECT created_at, private FROM businesses WHERE org_id=? AND slug=?').bind(orgId, 'source').first();
  snapshot = { createdAt: room.created_at, private: Boolean(room.private) };
});

const args = (clientId = 'tmp-creation-one') => ({ orgId, key, authorLogin: login, body: 'Create my app', clientId, creationActorId: actorId, creationRoomSnapshot: snapshot });
const sourceCount = async () => Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND channel=?').bind(orgId, key).first()).n);

// Interpose exactly at the idempotency lookup: the next INSERT or replay
// SELECT sees the changed access as a separate, completed transaction.
function interposeLookup(change, timing) {
  let changed = false;
  return {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.includes('m.client_id=?3 AND m.channel=?4')) return statement;
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { async first(...rest) {
          if (!changed && timing === 'before') { changed = true; await change(); }
          const result = await bound.first(...rest);
          if (!changed && timing === 'after') { changed = true; await change(); }
          return result;
        } };
      } };
    },
    batch(statements) { return env.DB.batch(statements); },
  };
}

const removeRoomMember = () => env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId, key, login).run();
const removeWorkspaceMember = () => env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(orgId, actorId).run();
const changePrivacy = () => env.DB.prepare('UPDATE businesses SET private=0 WHERE org_id=? AND slug=?').bind(orgId, 'source').run();
const replaceRoom = () => env.DB.batch([
  env.DB.prepare('DELETE FROM businesses WHERE org_id=? AND slug=?').bind(orgId, 'source'),
  env.DB.prepare('INSERT INTO businesses(org_id,slug,name,created_by,created_at,private) VALUES(?,?,?,?,?,1)').bind(orgId, 'source', 'Source', actorId, '2000-01-01T00:00:00.000Z'),
]);

test.each([
  ['private-room removal', removeRoomMember], ['workspace removal', removeWorkspaceMember],
  ['privacy change', changePrivacy], ['room replacement', replaceRoom],
])('fenced source insertion fails after %s between lookup and insert', async (_name, change) => {
  const result = await postMessage(interposeLookup(change, 'after'), args());
  expect(result).toMatchObject({ error: 'No such room.', status: 403 });
  expect(await sourceCount()).toBe(0);
});

test.each([
  ['private-room removal', removeRoomMember], ['workspace removal', removeWorkspaceMember],
  ['privacy change', changePrivacy], ['room replacement', replaceRoom],
])('fenced replay does not return source after %s', async (_name, change) => {
  const made = await postMessage(env.DB, args());
  expect(made.row).toMatchObject({ body: 'Create my app', channel: key });
  const replay = await postMessage(interposeLookup(change, 'before'), args());
  expect(replay.row).toBeUndefined();
  expect(replay.status).toBe(403);
  expect(await sourceCount()).toBe(1);
});

test('fenced sources replay unchanged and cannot be forged for another author', async () => {
  const first = await postMessage(env.DB, args());
  const replay = await postMessage(env.DB, args());
  expect(replay).toMatchObject({ row: { id: first.row.id }, replay: true });
  expect((await postMessage(env.DB, { ...args('tmp-creation-other'), authorLogin: 'another' })).status).toBe(403);
  expect((await postMessage(env.DB, { ...args('tmp-creation-invalid'), creationRoomSnapshot: null })).status).toBe(403);
  expect(await sourceCount()).toBe(1);
});

test('ordinary postMessage callers preserve existing behavior', async () => {
  await removeRoomMember();
  const posted = await postMessage(env.DB, { orgId, key, authorLogin: login, body: 'legacy', clientId: 'tmp-legacy-one' });
  expect(posted.row.body).toBe('legacy');
  expect((await postMessage(env.DB, { orgId, key, authorLogin: login, body: 'legacy', clientId: 'tmp-legacy-one' })).replay).toBe(true);
});

test('public to private is fenced even if the author remains a room member', async () => {
  await env.DB.prepare('UPDATE businesses SET private=0 WHERE org_id=? AND slug=?').bind(orgId, 'source').run();
  snapshot.private = false;
  const change = () => env.DB.prepare('UPDATE businesses SET private=1 WHERE org_id=? AND slug=?').bind(orgId, 'source').run();
  expect((await postMessage(interposeLookup(change, 'after'), args())).status).toBe(403);
  expect(await sourceCount()).toBe(0);
});

test('group source insertion stops if the user is removed before the write', async () => {
  const group = 'g:0123456789abcdef';
  await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,?)').bind(orgId, group, login, 'now').run();
  const input = { ...args(), key: group, creationRoomSnapshot: null };
  const change = () => env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,group,login).run();
  expect((await postMessage(interposeLookup(change, 'after'), input)).status).toBe(403);
  expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND channel=?').bind(orgId,group).first()).n)).toBe(0);
});

test('direct conversation insertion stops when the other member leaves', async () => {
  await upsertUser(env.DB, { githubId: 'other-user', login: 'other-login', name: 'Other', locale: 'en' });
  await upsertMembership(env.DB, orgId, 'other-user', 'member');
  const direct = `dm:${[login,'other-login'].sort().join('|')}`;
  const input = { ...args(), key: direct, creationRoomSnapshot: null };
  const change = () => env.DB.prepare('DELETE FROM memberships WHERE org_id=? AND user_github_id=?').bind(orgId,'other-user').run();
  expect((await postMessage(interposeLookup(change, 'after'), input)).status).toBe(403);
  expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND channel=?').bind(orgId,direct).first()).n)).toBe(0);
});

test('agent conversation insertion stops when agent access is revoked', async () => {
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,'agent-1','agent-1','Agent','help','team','other','now','now')`).bind(orgId).run();
  await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES(?,'agent-1','everyone','now')`).bind(orgId).run();
  const agentChannel = `ag:agent-1|${login}`;
  const input = { ...args(), key: agentChannel, creationRoomSnapshot: null };
  const change = () => env.DB.prepare("UPDATE hx_agent_profiles SET access='private' WHERE org_id=? AND agent_id='agent-1'").bind(orgId).run();
  expect((await postMessage(interposeLookup(change, 'after'), input)).status).toBe(403);
  expect(Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_messages WHERE org_id=? AND channel=?').bind(orgId,agentChannel).first()).n)).toBe(0);
});

test('a source inserted before revocation is not returned after its grant is removed', async () => {
  let lookups = 0;
  const db = {
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!sql.includes('m.client_id=?3 AND m.channel=?4')) return statement;
      return { bind(...values) {
        const bound = statement.bind(...values);
        return { async first(...rest) { if (++lookups === 2) await removeRoomMember(); return bound.first(...rest); } };
      } };
    },
    batch(statements) { return env.DB.batch(statements); },
  };
  const result = await postMessage(db, args());
  expect(result).toMatchObject({ error: 'No such room.', status: 403 });
  expect(await sourceCount()).toBe(1); // the insertion preceded removal
});

test('fenced group and direct conversation sources work while grants remain valid', async () => {
  const group = 'g:0123456789abcdef';
  await env.DB.prepare('INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,?)').bind(orgId, group, login, 'now').run();
  const groupResult = await postMessage(env.DB, { ...args('tmp-creation-group'), key: group, creationRoomSnapshot: null });
  expect(groupResult.row.channel).toBe(group);
  await upsertUser(env.DB, { githubId: 'other-user', login: 'other-login', name: 'Other', locale: 'en' });
  await upsertMembership(env.DB, orgId, 'other-user', 'member');
  const direct = `dm:${[login,'other-login'].sort().join('|')}`;
  const directResult = await postMessage(env.DB, { ...args('tmp-creation-direct'), key: direct, creationRoomSnapshot: null });
  expect(directResult.row.channel).toBe(direct);
});

test('fenced agent sources work while its audience grant remains valid', async () => {
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at) VALUES(?,'agent-1','agent-1','Agent','help','team','other','now','now')`).bind(orgId).run();
  await env.DB.prepare(`INSERT INTO hx_agent_profiles(org_id,agent_id,access,updated_at) VALUES(?,'agent-1','everyone','now')`).bind(orgId).run();
  const channel = `ag:agent-1|${login}`;
  const result = await postMessage(env.DB, { ...args('tmp-creation-agent'), key: channel, creationRoomSnapshot: null });
  expect(result.row.channel).toBe(channel);
});
