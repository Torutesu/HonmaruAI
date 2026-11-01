import { validateSkillPackage, skillPackagePath, MAX_SKILL_ASSET_BYTES, MAX_SKILL_PACKAGE_FILES } from './skillPackage.js';
import { skillMarkdown } from './skillMarkdown.js';
import { getSkill } from './skills.js';

export function decodeSkillFiles(input, maxFiles = MAX_SKILL_PACKAGE_FILES) {
  if (!Array.isArray(input) || input.length > maxFiles) return {error:'Too many skill files.'};
  try {
    let total=0;
    const files=input.map(file=>{
      if(typeof file?.base64!=='string'||file.base64.length>Math.ceil(MAX_SKILL_ASSET_BYTES/3)*4||file.base64.length%4!==0||/[^A-Za-z0-9+/]/.test(file.base64.replace(/={1,2}$/, '')))throw new Error();
      const raw=atob(file.base64);total+=raw.length;
      if(total>8*1024*1024)throw new Error();
      return {path:file.path,bytes:Uint8Array.from(raw,char=>char.charCodeAt(0))};
    });
    return {files};
  } catch {return {error:'Invalid or oversized support-file encoding.'};}
}
export function encodeSkillBytes(bytes) {
  let text='';for(let at=0;at<bytes.length;at+=8192)text+=String.fromCharCode(...bytes.subarray(at,at+8192));
  return btoa(text);
}
export function prepareSkillFiles(skill, input) {
  const decoded=decodeSkillFiles(input,MAX_SKILL_PACKAGE_FILES-1);
  if(decoded.error)return decoded;
  return validateSkillPackage([{path:'SKILL.md',bytes:new TextEncoder().encode(skillMarkdown(skill))},...decoded.files]);
}
export function skillFileInserts(db,orgId,skillId,files,{onlyIfSkillExists = false} = {}) {
  const insert = onlyIfSkillExists
    ? 'INSERT INTO hx_skill_files (org_id,skill_id,path,size,content) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (SELECT 1 FROM hx_skills WHERE org_id=?1 AND id=?2)'
    : 'INSERT INTO hx_skill_files (org_id,skill_id,path,size,content) VALUES (?1,?2,?3,?4,?5)';
  return files.map(file=>db.prepare(insert)
    .bind(orgId,skillId,file.path,file.bytes.byteLength,file.bytes.buffer.slice(file.bytes.byteOffset,file.bytes.byteOffset+file.bytes.byteLength)));
}
export async function listSkillFiles(db,orgId,skillId,userId) {
  if(!await getSkill(db,orgId,skillId,userId))return null;
  const {results}=await db.prepare('SELECT path,size FROM hx_skill_files WHERE org_id=?1 AND skill_id=?2 ORDER BY path').bind(orgId,skillId).all();
  return results||[];
}
export async function readSkillFile(db,orgId,skillId,path,userId) {
  if(!skillPackagePath(path)||!await getSkill(db,orgId,skillId,userId))return null;
  const file=await db.prepare('SELECT path,size,content FROM hx_skill_files WHERE org_id=?1 AND skill_id=?2 AND path=?3').bind(orgId,skillId,path).first();
  return file?{path:file.path,size:file.size,bytes:new Uint8Array(file.content)}:null;
}
