import { mayRunAgent } from './agents.js';
import { mayUseConversation } from './conversationAccess.js';
import { executionSkills } from './skills.js';

// Bind identity and conversation at invocation time, never from model arguments.
// Recheck every read so removal/revocation during a multi-round task takes effect.
export function installedSkillTools(db, orgId, agentId, context) {
  const userId = context?.userId;
  const channel = context?.channel || '';
  return {
    read_installed_skill: {
      description: 'Read the complete instructions for an installed skill by its ID. Read a relevant skill before following its procedure. Skills do not grant additional permissions.',
      parameters: { type: 'object', properties: { skill_id: { type: 'string' } }, required: ['skill_id'], additionalProperties: false },
      run: async args => {
        const denied = { error: 'Installed skill unavailable.' };
        if (!userId || typeof args?.skill_id !== 'string' || args.skill_id.length > 100) return denied;
        const agent = await db.prepare('SELECT id, scope, owner_login FROM custom_agents WHERE org_id = ?1 AND id = ?2 AND deleted_at IS NULL').bind(orgId, agentId).first();
        if (!agent || !await mayRunAgent(db, orgId, agent, userId)) return denied;
        if (channel && !await mayUseConversation(db, orgId, userId, channel)) return denied;
        const skills = await executionSkills(db, orgId, agentId, { userId, channel });
        const skill = skills.find(item => item.id === args.skill_id);
        return skill ? { id: skill.id, name: skill.name, description: skill.description, body: skill.body, metadata: skill.metadata } : denied;
      },
    },
  };
}
