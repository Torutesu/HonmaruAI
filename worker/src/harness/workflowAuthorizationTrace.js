// Run history keeps only the identity, resource reference, result, and time
// of each authorization check. Never pass prompts, secrets, or policy details
// into this recorder.
const RESOURCE_TYPES = new Set(['workflow', 'conversation', 'agent', 'table', 'app', 'connection', 'member']);
const OUTCOMES = new Set(['allowed', 'denied']);
const MAX_EVENTS_PER_STEP = 40;

export function createWorkflowAuthorizationTrace(actorId) {
  const actor = String(actorId ?? '').slice(0, 200);
  const events = [];
  const seen = new Set();
  return {
    events,
    record(resourceType, resourceId, allowed, checkedAt = new Date().toISOString()) {
      const type = String(resourceType ?? '');
      const resource = String(resourceId ?? '').slice(0, 200);
      const outcome = allowed === true ? 'allowed' : 'denied';
      if (!actor || !RESOURCE_TYPES.has(type) || !resource || !OUTCOMES.has(outcome) || events.length >= MAX_EVENTS_PER_STEP) return;
      // Repeated rechecks in an Agent tool loop are useful only when their
      // outcome changes (for example, a grant is revoked while the model runs).
      const key = `${type}\0${resource}\0${outcome}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push({ actorId: actor, resourceType: type, resourceId: resource, outcome, checkedAt });
    },
  };
}

export function publicWorkflowAuthorizationEvents(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_EVENTS_PER_STEP).flatMap(event => {
    if (!event || typeof event !== 'object') return [];
    const { actorId, resourceType, resourceId, outcome, checkedAt } = event;
    if (typeof actorId !== 'string' || !actorId || actorId.length > 200 ||
      !RESOURCE_TYPES.has(resourceType) || typeof resourceId !== 'string' || !resourceId || resourceId.length > 200 ||
      !OUTCOMES.has(outcome) || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))) return [];
    return [{ actorId, resourceType, resourceId, outcome, checkedAt }];
  });
}
