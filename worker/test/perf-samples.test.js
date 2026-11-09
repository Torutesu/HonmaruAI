import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { cleanSamples, sweepPerfSamples } from '../src/perfSamples.js';

// Timing samples from the apps (#845): kept as a kind, a number, an app and
// a time, and nothing else; only from someone signed in; swept after 14 days.

const ctx = { waitUntil: (p) => p, passThroughOnException() {} };
let token;
beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, ' '));
  await env.DB.prepare('DELETE FROM perf_samples').run();
  const { createSession, upsertUser } = await import('../src/db.js');
  await upsertUser(env.DB, { githubId: 'perf-1', login: 'perfer', name: 'Perf', avatarUrl: null, locale: 'en' });
  token = await createSession(env.DB, 'perf-1', 'p');
});
const send = (body, headers = { 'x-session-token': token }) => worker.fetch(new Request('https://example.com/perf', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, ctx);

test('keeps known kinds in range, as numbers, and drops the rest', async () => {
  const res = await send({ client: 'desktop', samples: [
    { k: 'send.queue', v: 1234.6 }, { k: 'send.http', v: 80 }, { k: 'open.fresh', v: 1 },
    { k: 'send.queue', v: -1 }, { k: 'send.queue', v: 'NaN' }, { k: 'secret', v: 1 }, { k: 'send.depth', v: 1000 },
  ] });
  expect(await res.json()).toEqual({ kept: 3 });
  const { results } = await env.DB.prepare('SELECT * FROM perf_samples ORDER BY kind').all();
  expect(results.map((r) => [r.kind, r.value, r.client])).toEqual([['open.fresh', 1, 'desktop'], ['send.http', 80, 'desktop'], ['send.queue', 1235, 'desktop']]);
  // Nothing that names a person, a workspace or a conversation is a column.
  expect(Object.keys(results[0]).sort()).toEqual(['client', 'created_at', 'kind', 'value']);
});

test('takes nothing without a session, and at most fifty at once', async () => {
  expect((await send({ samples: [{ k: 'send.http', v: 1 }] }, {})).status).toBe(401);
  expect(cleanSamples(Array.from({ length: 80 }, () => ({ k: 'send.http', v: 1 })))).toHaveLength(50);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM perf_samples').first()).n).toBe(0);
});

test('a fortnight later the samples are gone', async () => {
  const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO perf_samples (kind, value, client, created_at) VALUES ('send.http', 1, 'web', ?1), ('send.http', 2, 'web', ?2)").bind(old, new Date().toISOString()).run();
  await sweepPerfSamples(env);
  expect((await env.DB.prepare('SELECT value FROM perf_samples').all()).results).toEqual([{ value: 2 }]);
});
