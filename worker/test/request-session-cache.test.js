import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import { getSession, createSession, upsertUser } from '../src/db.js';
import { requestContext, forgetRequestSessions } from '../src/requestContext.js';

// One request reads its session once, however many helpers ask (#964), and
// never reads back a session it has just changed or ended.

let token;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await upsertUser(env.DB, { githubId: 'rs-1', login: 'rs', name: 'RS', avatarUrl: null, locale: 'en' });
  token = await createSession(env.DB, 'rs-1', 'x');
});
function counting(db) {
  let reads = 0;
  return { get reads() { return reads; }, db: new Proxy(db, { get(t, k) {
    if (k === 'prepare') return (sql) => { if (/FROM sessions WHERE token/.test(sql)) reads += 1; return t.prepare(sql); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } }) };
}

test('three asks in one request read the session row once; outside a request every ask reads', async () => {
  const c = counting(env.DB);
  await requestContext.run({}, async () => {
    const [a, b] = await Promise.all([getSession(c.db, token), getSession(c.db, token)]);
    const d = await getSession(c.db, token);
    expect(a.github_id).toBe('rs-1'); expect(b.github_id).toBe('rs-1'); expect(d.github_id).toBe('rs-1');
    // Each caller gets its own copy.
    a.github_id = 'changed';
    expect((await getSession(c.db, token)).github_id).toBe('rs-1');
  });
  expect(c.reads).toBe(1);
  await getSession(c.db, token); await getSession(c.db, token);
  expect(c.reads).toBe(3);
});

test('a session ended within the request is not read back from the cache', async () => {
  await requestContext.run({}, async () => {
    expect(await getSession(env.DB, token)).toBeTruthy();
    await env.DB.prepare('DELETE FROM sessions').run();
    forgetRequestSessions();
    expect(await getSession(env.DB, token)).toBeNull();
  });
});
