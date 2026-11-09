import { env } from 'cloudflare:test';
import { test, expect } from 'vitest';
import schemaSql from '../schema.sql?raw';
import { activityFeed, searchMessages, present } from '../src/channels.js';
import { useMediaEnv, mediaEnv } from '../src/mediaToken.js';

// How many statements Activity, search and a page of messages cost, so the
// cost of a page cannot grow with each result or each message an agent
// wrote (#845). Counted on the real D1, through the functions the routes
// call; not latency, and not the routes' own sign-in checks.

const org = 'latency-budget';
const members = [{ login: 'alice', ref: 'alice-ref', name: 'Alice', handle: 'alice' }, { login: 'bob', ref: 'bob-ref', name: 'Bob' }];
function counted(db) {
  const queries = [];
  return {
    queries,
    batch: (s) => db.batch(s),
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          const bound = stmt.bind(...args);
          return new Proxy(bound, { get(target, key) {
            const value = target[key];
            if (['all', 'first', 'run', 'raw'].includes(key)) return async (...a) => { queries.push(sql); return value.apply(target, a); };
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        },
      };
    },
  };
}
async function seed(n) {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.prepare('DELETE FROM channel_messages WHERE org_id = ?1').bind(org).run();
  const rows = Array.from({ length: n }, (_, i) => ({ id: `p${n}-${i}`, body: '@alice latencyfixture check this please', at: new Date(Date.now() - i * 1000).toISOString() }));
  await env.DB.prepare(`INSERT INTO channel_messages(id,org_id,channel,author_login,body,kind,created_at)
    SELECT json_extract(value,'$.id'),?1,'b:room','bob',json_extract(value,'$.body'),'message',json_extract(value,'$.at') FROM json_each(?2)`).bind(org, JSON.stringify(rows)).run();
}
const costOf = async (n) => {
  await seed(n);
  const a = counted(env.DB); const activity = await activityFeed(a, org, 'alice', members);
  const s = counted(env.DB); const search = await searchMessages(s, org, 'alice', members, 'latencyfixture');
  expect(activity.items).toHaveLength(n);
  expect(search.messages).toHaveLength(n);
  return { activity: a.queries.length, search: s.queries.length, activityItems: activity.items, searchMessages: search.messages };
};

test('Activity and search cost the same for one result and for thirty', async () => {
  const one = await costOf(1);
  const thirty = await costOf(30);
  expect(thirty.activity).toBe(one.activity);
  expect(thirty.search).toBe(one.search);
  // Newest first, each drawn as the message it points at, in its view.
  expect(thirty.activityItems.map((i) => i.message.id)).toEqual(Array.from({ length: 30 }, (_, i) => `p30-${i}`));
  expect(thirty.activityItems.every((i) => i.type === 'mention' && i.key === `m:${i.message.id}`)).toBe(true);
  expect(thirty.searchMessages.map((m) => m.id)).toEqual(Array.from({ length: 30 }, (_, i) => `p30-${i}`));
});

test('a page of an agent\'s messages looks its picture up once, not once a message', async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at,avatar_url) VALUES (?1,'helper','helper','Helper','help','team','alice','2026-01-01','2026-01-01',?2)`)
    .bind(org, 'https://example.com/agents/avatar/agent-avatar-11111111-1111-4111-8111-111111111111').run();
  const cost = async (n) => {
    const db = counted(env.DB); const before = mediaEnv();
    useMediaEnv({ DB: db, API_ORIGIN: 'https://example.com' });
    try {
      const rows = Array.from({ length: n }, (_, i) => ({ id: `a${i}`, kind: 'agent', author_login: 'agent:helper', body: 'hello', created_at: '2026-01-01', channel: 'b:room' }));
      const out = await present(db, org, rows, 'alice', 'b:room', members);
      expect(out.every((m) => m.agent?.avatarUrl && m.agent.avatarUrl === out[0].agent.avatarUrl)).toBe(true);
      return { all: db.queries.length, profiles: db.queries.filter((q) => q.includes('hx_agent_profiles')).length };
    } finally { useMediaEnv(before); }
  };
  const one = await cost(1);
  const fifty = await cost(50);
  expect(fifty).toEqual(one);
  expect(fifty.profiles).toBeLessThanOrEqual(1);
});

import { resolveChannel } from '../src/channels.js';

// A stand-in database whose channel row answers only when the test says.
function gated({ failTombstone = false } = {}) {
  let release; const held = new Promise((r) => { release = r; });
  const seen = [];
  return {
    seen, release,
    prepare(sql) {
      return { bind: () => ({ first: () => {
        seen.push(sql.includes('FROM businesses') ? 'business' : sql.includes('hx_room_access') ? 'tombstone' : sql);
        if (sql.includes('FROM businesses')) return held;
        if (sql.includes('hx_room_access')) return failTombstone ? Promise.reject(new Error('down')) : Promise.resolve(null);
        return Promise.resolve(null);
      }, all: async () => ({ results: [] }) }) };
    },
  };
}

test('a channel\'s deletion mark is read while its row is still on its way, and either failing lets nobody in', async () => {
  const db = gated();
  const resolving = resolveChannel(db, org, { login: 'alice' }, 'b:room', members);
  await Promise.resolve();
  expect(db.seen).toEqual(['business', 'tombstone']);
  db.release({ private: 0, created_at: '2026-01-01' });
  await resolving;
  const down = gated({ failTombstone: true });
  const closed = resolveChannel(down, org, { login: 'alice' }, 'b:room', members);
  down.release({ private: 0, created_at: '2026-01-01' });
  expect(await closed).toBeNull();
});
