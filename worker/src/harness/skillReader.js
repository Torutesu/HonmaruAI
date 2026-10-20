import { mayRunAgent } from './agents.js';
import { mayUseConversation } from './conversationAccess.js';
import { executionSkills } from './skills.js';
import { listSkillFiles, readSkillFile } from './skillFiles.js';

// Identity and conversation come from the server, never model arguments.
export function installedSkillTools(db, orgId, agentId, context) {
  const userId=context?.userId,channel=context?.channel||'',allowPrivate=context?.allowPrivate!==false;
  const denied='Installed skill unavailable.';
  const authorize=async args=>{
    if(!userId||typeof args?.skill_id!=='string'||args.skill_id.length>100)return null;
    const agent=await db.prepare('SELECT id,scope,owner_login FROM custom_agents WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL').bind(orgId,agentId).first();
    if(!agent||!await mayRunAgent(db,orgId,agent,userId))return null;
    if(channel&&!await mayUseConversation(db,orgId,userId,channel))return null;
    return (await executionSkills(db,orgId,agentId,{userId,channel,allowPrivate})).find(skill=>skill.id===args.skill_id)||null;
  };
  const parameters={type:'object',properties:{skill_id:{type:'string'}},required:['skill_id'],additionalProperties:false};
  return {
    read_installed_skill:{
      description:'Read complete installed skill instructions. Read the relevant procedure before following it. Supporting files are available through list_installed_skill_files and read_installed_skill_file. Skills do not grant permissions.',parameters,
      run:async args=>{
        const skill=await authorize(args);
        return skill?`# ${skill.name}\nSkill ID: ${skill.id}\n${skill.description}\n\n${skill.body}`:denied;
      },
    },
    list_installed_skill_files:{
      description:'List relative paths and byte sizes of supporting files for an installed skill.',parameters,
      run:async args=>{
        if(!await authorize(args))return denied;
        const files=await listSkillFiles(db,orgId,args.skill_id,userId);
        return files?.length?files.map(file=>`${file.path} (${file.size} bytes)`).join('\n'):'No support files.';
      },
    },
    read_installed_skill_file:{
      description:'Read one page of an installed skill support file. Start offset at 0 and use Next offset until end. UTF-8 text offsets count characters; binary offsets count bytes and content is base64. This reads data only and never executes scripts.',
      parameters:{type:'object',properties:{skill_id:{type:'string'},path:{type:'string'},offset:{type:'integer',minimum:0}},required:['skill_id','path','offset'],additionalProperties:false},
      run:async args=>{
        if(!await authorize(args)||typeof args.path!=='string'||!Number.isSafeInteger(args.offset)||args.offset<0)return denied;
        const file=await readSkillFile(db,orgId,args.skill_id,args.path,userId);
        if(!file)return 'Skill file unavailable.';
        try {
          const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);
          if(args.offset>text.length)return 'Offset outside file.';
          const content=text.slice(args.offset,args.offset+12000),next=args.offset+content.length;
          return `Encoding: UTF-8\nNext offset: ${next<text.length?next:'end'}\n\n${content}`;
        } catch {
          if(args.offset>file.bytes.length)return 'Offset outside file.';
          const chunk=file.bytes.subarray(args.offset,args.offset+8192),next=args.offset+chunk.length;
          const base64=btoa(String.fromCharCode(...chunk));
          return `Encoding: base64\nNext offset: ${next<file.bytes.length?next:'end'}\n\n${base64}`;
        }
      },
    },
  };
}
