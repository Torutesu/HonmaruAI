import { expect, test } from 'vitest';
import { createWorkflowAuthorizationTrace, publicWorkflowAuthorizationEvents } from '../src/harness/workflowAuthorizationTrace.js';

test('authorization trace records only actor, resource, result, and time and preserves a revoked transition', () => {
  const trace = createWorkflowAuthorizationTrace('user-42');
  trace.record('agent', 'agent-a', true, '2026-11-06T01:00:00.000Z');
  trace.record('agent', 'agent-a', true, '2026-11-06T01:00:01.000Z');
  trace.record('agent', 'agent-a', false, '2026-11-06T01:00:02.000Z');
  trace.record('connection', 'server-a/search', true, '2026-11-06T01:00:03.000Z');
  expect(trace.events).toEqual([
    { actorId: 'user-42', resourceType: 'agent', resourceId: 'agent-a', outcome: 'allowed', checkedAt: '2026-11-06T01:00:00.000Z' },
    { actorId: 'user-42', resourceType: 'agent', resourceId: 'agent-a', outcome: 'denied', checkedAt: '2026-11-06T01:00:02.000Z' },
    { actorId: 'user-42', resourceType: 'connection', resourceId: 'server-a/search', outcome: 'allowed', checkedAt: '2026-11-06T01:00:03.000Z' },
  ]);
  expect(trace.events.every(event => Object.keys(event).sort().join(',') === 'actorId,checkedAt,outcome,resourceId,resourceType')).toBe(true);
});

test('public authorization event projection rejects malformed entries and strips extra fields', () => {
  const safe = { actorId: 'user-42', resourceType: 'conversation', resourceId: 'b:ops', outcome: 'denied', checkedAt: '2026-11-06T01:00:00.000Z' };
  expect(publicWorkflowAuthorizationEvents([
    { ...safe, prompt: 'private prompt', token: 'secret' },
    { ...safe, outcome: 'maybe' },
    { ...safe, checkedAt: 'invalid' },
  ])).toEqual([safe]);
});
