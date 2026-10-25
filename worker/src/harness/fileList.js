import {fileScopeAuthority} from './fileAuthority.js';
import {workspaceFilePath,FileVersionInputError} from './fileVersionLedger.js';

const types={image:"v.content_type LIKE 'image/%'",video:"v.content_type LIKE 'video/%'",media:"(v.content_type LIKE 'image/%' OR v.content_type LIKE 'video/%')",pdf:"v.content_type='application/pdf'",html:"v.content_type='text/html'",doc:"v.content_type IN ('text/plain','text/markdown','application/msword','application/rtf','text/rtf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')"};
const text=value=>typeof value==='string'&&value.length<=1024&&!/[\u0000-\u001f\u007f]/.test(value);
const date=value=>{
 if(value===null)return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)||!Number.isFinite(Date.parse(value)))throw new FileVersionInputError('Invalid file date.');
 return new Date(value).toISOString();
};
// Internal. Scope must be explicit: callers resolve the active room; null is
// an intentional search across all visible scopes, never a default fallback.
export async function listWorkspaceFiles(db,{orgId,userId,scope,query='',directory='',type=null,createdBy=null,since=null,until=null,includeDeleted=false,directOnly=false,cursor=null,limit=50}) {
 if(!text(orgId)||!orgId||!text(userId)||!userId||(scope!==null&&(!text(scope)||!scope))||!text(query)||!text(directory)||!Number.isInteger(limit)||limit<1||limit>100||typeof includeDeleted!=='boolean'||typeof directOnly!=='boolean'||(createdBy!==null&&(!text(createdBy)||!createdBy))||(type!==null&&!Object.hasOwn(types,type)))throw new FileVersionInputError('Invalid file search.');
 if(cursor!==null&&(!text(cursor.path)||!text(cursor.id)||!cursor.id))throw new FileVersionInputError('Invalid file cursor.');
 if(directOnly&&directory)directory=workspaceFilePath(directory.replace(/\/$/,''))+'/';
 since=date(since);until=date(until);
 if(since&&until&&since>until)throw new FileVersionInputError('Invalid file date range.');
 const {results}=await db.prepare(`SELECT f.id,f.scope,f.path,CASE WHEN EXISTS(SELECT 1 FROM users author WHERE author.github_id=f.created_by) THEN f.created_by ELSE 'deleted-user' END AS created_by,f.created_at,f.updated_at,f.current_version,v.kind,v.content_type,v.size
  FROM hx_workspace_files f JOIN hx_workspace_file_versions v ON v.org_id=f.org_id AND v.file_id=f.id AND v.version=f.current_version
  WHERE f.org_id=?1 AND ${fileScopeAuthority('f.org_id','f.scope','?2')}
   AND (?3 IS NULL OR f.scope=?3) AND instr(lower(f.path),lower(?4))>0 AND substr(f.path,1,length(?5))=?5
   AND (?13=0 OR instr(substr(f.path,length(?5)+1),'/')=0)
   AND (?6 IS NULL OR f.created_by=?6) AND (?7 IS NULL OR f.created_at>=?7) AND (?8 IS NULL OR f.created_at<=?8)
   AND (?9=1 OR v.kind='content') AND NOT EXISTS(SELECT 1 FROM hx_workspace_file_purges p WHERE p.org_id=v.org_id AND p.file_id=v.file_id AND p.version=v.version)
   AND (?10 IS NULL OR f.path>?10 OR (f.path=?10 AND f.id>?11))
   ${type===null?'':`AND ${types[type]}`} ORDER BY f.path,f.id LIMIT ?12`)
  .bind(orgId,userId,scope,query,directory,createdBy,since,until,includeDeleted?1:0,cursor?.path??null,cursor?.id??null,limit+1,directOnly?1:0).all();
 const rows=results.slice(0,limit),last=rows.at(-1);
 return {files:rows.map(row=>({id:row.id,scope:row.scope,path:row.path,createdBy:row.created_by,createdAt:row.created_at,updatedAt:row.updated_at,version:row.current_version,deleted:row.kind==='deleted',contentType:row.content_type,size:row.size})),next:results.length>limit?{path:last.path,id:last.id}:null};
}
