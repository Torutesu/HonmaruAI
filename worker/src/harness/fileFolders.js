import {fileScopeAuthority} from './fileAuthority.js';
import {workspaceFilePath,FileVersionInputError} from './fileVersionLedger.js';
const valid=value=>typeof value==='string'&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
export async function listFileFolders(db,{orgId,userId,scope,directory='',cursor=null,includeDeleted=false,limit=50}){
 if(!valid(scope)||!scope||scope==='all'||!valid(directory)||(cursor!==null&&(!valid(cursor)||!cursor))||!Number.isInteger(limit)||limit<1||limit>100||typeof includeDeleted!=='boolean')throw new FileVersionInputError('Invalid folder search.');
 const prefix=directory?workspaceFilePath(directory.replace(/\/$/,''))+'/':'';
 const {results}=await db.prepare(`WITH visible AS (
 SELECT substr(f.path,length(?4)+1) AS relative FROM hx_workspace_files f
 JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
 WHERE f.org_id=?1 AND f.scope=?3 AND substr(f.path,1,length(?4))=?4
 AND ${fileScopeAuthority('f.org_id','f.scope','?2')}
 AND (?5=1 OR v.kind='content')
 AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)
 ), folders AS (SELECT DISTINCT substr(relative,1,instr(relative,'/')-1) AS name FROM visible WHERE instr(relative,'/')>0)
 SELECT name FROM folders WHERE ?6 IS NULL OR name>?6 ORDER BY name LIMIT ?7`).bind(orgId,userId,scope,prefix,includeDeleted?1:0,cursor,limit+1).all();
 const rows=results.slice(0,limit);
 return {folders:rows.map(row=>({name:row.name,path:prefix+row.name+'/'})),next:results.length>limit?rows.at(-1).name:null};
}
