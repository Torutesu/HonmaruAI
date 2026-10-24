import { memoryEntry } from './memoryEntries.js';
import { getSkill, MAX_SKILLS } from './skills.js';
import { parseSkillMarkdown, skillMarkdown } from './skillMarkdown.js';
import { mayReadSkillSource } from './skillSourceScope.js';

export async function convertMemoryToSkill(db, orgId, agentId, memoryId, input, { channel = '', by } = {}) {
  if (!by || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)
    || typeof input.keepEntry !== 'boolean') return {error:'A current memory version, request ID and keep choice are required.',status:400};
  by=String(by);
  if (!await mayReadSkillSource(db,orgId,{source_agent_id:agentId,source_channel:channel},by)) return {error:'No such memory.',status:404};
  const replay = async () => {
    const previous=await db.prepare('SELECT * FROM hx_memory_skill_conversions WHERE org_id=?1 AND request_id=?2').bind(orgId,input.requestId).first();
    if (!previous) return null;
    if (previous.created_by!==by || previous.memory_id!==memoryId || previous.memory_version!==input.expectedVersion
      || previous.agent_id!==agentId || previous.channel!==channel || Boolean(previous.keep_entry)!==input.keepEntry)
      return {error:'This conversion request ID was used for a different operation.',status:409};
    const skill=await getSkill(db,orgId,previous.skill_id,by);
    return skill ? {skill,keptMemory:input.keepEntry,replayed:true} : {error:'The converted skill is no longer available.',status:409};
  };
  const previous=await replay();
  if(previous)return previous;
  const row=await db.prepare(`SELECT m.*,s.channel,s.kind,d.title,d.description,d.body,d.version,d.updated_at FROM hx_agent_memories m
    LEFT JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id
    LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
    WHERE m.org_id=?1 AND m.agent_id=?2 AND m.id=?3 AND COALESCE(s.channel,'')=?4`).bind(orgId,agentId,memoryId,channel).first();
  if(!row)return await replay() || {error:'No such memory.',status:404};
  const source=memoryEntry(row);
  if(source.version!==input.expectedVersion)return {error:'This memory changed. Reload before converting.',status:409};
  const fields={name:source.title,description:source.description || source.title,body:source.body,
    metadata:{'source-memory':{id:memoryId,version:source.version,kind:source.kind,description:source.description}}};
  const checked=parseSkillMarkdown(skillMarkdown(fields));
  if(checked.error)return {error:checked.error,status:400};
  const count=await db.prepare('SELECT COUNT(*) AS n FROM hx_skills WHERE org_id=?1').bind(orgId).first();
  if(count.n>=MAX_SKILLS)return {error:'This workspace has as many skills as it can hold.',status:409};
  const id=`skill_${crypto.randomUUID().replace(/-/g,'').slice(0,16)}`, at=new Date().toISOString();
  const statements=[
    db.prepare(`INSERT INTO hx_skills(id,org_id,name,description,body,created_by,created_at,updated_at,metadata)
      SELECT ?5,?1,?6,?7,?8,?9,?10,?10,?11 FROM hx_agent_memories m
      LEFT JOIN hx_memory_scopes s ON s.org_id=m.org_id AND s.memory_id=m.id
      LEFT JOIN hx_memory_entries d ON d.org_id=m.org_id AND d.memory_id=m.id
      WHERE m.org_id=?1 AND m.agent_id=?2 AND m.id=?3 AND COALESCE(s.channel,'')=?4 AND COALESCE(d.version,0)=?12
        AND (SELECT COUNT(*) FROM hx_skills WHERE org_id=?1)<?13
        AND NOT EXISTS(SELECT 1 FROM hx_memory_skill_conversions WHERE org_id=?1 AND (request_id=?14 OR (memory_id=?3 AND memory_version=?12)))`)
      .bind(orgId,agentId,memoryId,channel,id,fields.name,fields.description,fields.body,by,at,JSON.stringify(fields.metadata),source.version,MAX_SKILLS,input.requestId),
    db.prepare(`INSERT INTO hx_skill_access(org_id,skill_id,visibility,version) SELECT org_id,id,'private',1 FROM hx_skills WHERE org_id=?1 AND id=?2`).bind(orgId,id),
    db.prepare(`INSERT INTO hx_skill_source_scopes(org_id,skill_id,agent_id,channel,memory_id,memory_version,created_by,created_at)
      SELECT org_id,id,?3,?4,?5,?6,?7,?8 FROM hx_skills WHERE org_id=?1 AND id=?2`).bind(orgId,id,agentId,channel,memoryId,source.version,by,at),
    db.prepare(`INSERT INTO hx_memory_skill_conversions(org_id,request_id,memory_id,memory_version,agent_id,channel,keep_entry,skill_id,created_by,created_at)
      SELECT org_id,?3,?4,?5,?6,?7,?8,id,?9,?10 FROM hx_skills WHERE org_id=?1 AND id=?2`).bind(orgId,id,input.requestId,memoryId,source.version,agentId,channel,input.keepEntry?1:0,by,at),
    db.prepare(`INSERT INTO hx_agent_skills(org_id,agent_id,skill_id,added_by,added_at)
      SELECT org_id,?3,id,?4,?5 FROM hx_skills WHERE org_id=?1 AND id=?2`).bind(orgId,id,agentId,by,at),
  ];
  if(!input.keepEntry)statements.push(db.prepare(`DELETE FROM hx_agent_memories WHERE org_id=?1 AND agent_id=?2 AND id=?3
    AND EXISTS(SELECT 1 FROM hx_memory_skill_conversions c JOIN hx_agent_skills l ON l.org_id=c.org_id AND l.skill_id=c.skill_id AND l.agent_id=c.agent_id
      WHERE c.org_id=?1 AND c.agent_id=?2 AND c.memory_id=?3 AND c.skill_id=?4 AND c.request_id=?5)`)
    .bind(orgId,agentId,memoryId,id,input.requestId));
  const results=await db.batch(statements);
  if(!results[0].meta?.changes)return await replay() || {error:'This memory changed or was already converted. Reload before converting.',status:409};
  return {skill:await getSkill(db,orgId,id,by),keptMemory:input.keepEntry,replayed:false};
}
