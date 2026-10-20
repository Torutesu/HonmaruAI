import { parseSkillMarkdown } from './skillMarkdown.js';
import { parseSkillZip } from './skillZip.js';
import { decodeSkillFiles, encodeSkillBytes } from './skillFiles.js';
import { skillPackagePath, validateSkillPackage, MAX_SKILL_PACKAGE_BYTES } from './skillPackage.js';

export function previewSkillImport(input) {
  const formats=['markdown','zipBase64','files'].filter(key=>input[key]!==undefined);
  if(formats.length!==1)return {error:'Choose one skill file, ZIP or folder.'};
  if(formats[0]==='markdown')return parseSkillMarkdown(input.markdown);
  let parsed;
  if(formats[0]==='zipBase64') {
    if(typeof input.zipBase64!=='string'||input.zipBase64.length>Math.ceil((MAX_SKILL_PACKAGE_BYTES+65536)/3)*4)return {error:'Skill ZIP is too large.'};
    try {const raw=atob(input.zipBase64);parsed=parseSkillZip(Uint8Array.from(raw,char=>char.charCodeAt(0)));}
    catch {return {error:'Invalid ZIP encoding.'};}
  } else {
    const decoded=decodeSkillFiles(input.files);
    if(decoded.error)return decoded;
    const files=decoded.files;
    if(files.some(file=>!skillPackagePath(file.path)))return {error:'Invalid package path.'};
    if(!files.some(file=>file.path==='SKILL.md')) {
      const prefix=files[0]?.path.split('/')[0]+'/';
      if(files.every(file=>file.path.startsWith(prefix))&&files.some(file=>file.path===prefix+'SKILL.md'))for(const file of files)file.path=file.path.slice(prefix.length);
    }
    parsed=validateSkillPackage(files);
  }
  if(parsed.error)return parsed;
  return {draft:{...parsed.draft,files:parsed.files.map(file=>({path:file.path,size:file.bytes.byteLength,base64:encodeSkillBytes(file.bytes)}))}};
}
