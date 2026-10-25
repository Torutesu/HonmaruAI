import { announceTo } from '../announce.js';
import { custom } from '../agui/events.js';
import { agentRoleState } from './agentRoles.js';

// Access changes affect the agent list and any open member dialog. Deliver an
// opaque invalidation only to current agent members and explicitly affected
// people (for example, someone who was just removed). The client reloads its
// own authorized view, so no role, name, or profile data crosses the relay.
export async function announceAgentAccessChanged(env, orgId, agentId, affectedLogins = []) {
  if (!env?.DB || !orgId || !agentId) return { announced: 0 };
  try {
    const state = await agentRoleState(env.DB, orgId, agentId);
    const recipients = new Set([
      ...(state?.members || []).map(member => member.login),
      ...(affectedLogins || []),
    ].filter(login => typeof login === 'string' && login.length > 0));
    if (!recipients.size) return { announced: 0 };
    const event = custom('agent_access_changed', { agentId, version: state?.version ?? null });
    return await announceTo(env, orgId, [...recipients].map(to => ({ to, event })));
  } catch (error) {
    // The write is already committed; a missed refresh is repaired on the
    // next load/reconnect and must not turn a successful permission change
    // into a failed request.
    console.error('agent access announce failed', error?.message || error);
    return { announced: 0, error: true };
  }
}
