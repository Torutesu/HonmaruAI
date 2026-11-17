import {listWorkspaceFiles} from './fileList.js';

async function visiblePinnedFile(db,orgId,userId,fileId){
 const result=await listWorkspaceFiles(db,{orgId,userId,scope:null,exactFileId:fileId,limit:1});
 const file=result.files[0];
 return file&&!file.deleted?file:null;
}

// File pins belong to one member. Recheck the current file ACL on every read;
// a stored pin never grants access to a Room or file.
export async function filePins(db,orgId,userId){
 const {results=[]}=await db.prepare('SELECT file_id FROM hx_file_pins WHERE org_id=?1 AND user_id=?2 ORDER BY created_at,file_id').bind(orgId,String(userId)).all();
 const pins=[];
 for(const row of results){
  const file=await visiblePinnedFile(db,orgId,userId,row.file_id);
  if(file)pins.push(file);
 }
 return {pins};
}

export async function setFilePin(db,orgId,userId,fileId,pinned){
 if(typeof fileId!=='string'||!/^([\w-]{1,80}|file-[a-f0-9-]{36})$/i.test(fileId)||typeof pinned!=='boolean')return {error:'Invalid file pin.',status:400};
 if(pinned){
  const file=await visiblePinnedFile(db,orgId,userId,fileId);
  if(!file)return {error:'File is unavailable.',status:404};
  await db.prepare('INSERT OR IGNORE INTO hx_file_pins (org_id,user_id,file_id,created_at) VALUES (?1,?2,?3,?4)').bind(orgId,String(userId),fileId,new Date().toISOString()).run();
 }else{
  await db.prepare('DELETE FROM hx_file_pins WHERE org_id=?1 AND user_id=?2 AND file_id=?3').bind(orgId,String(userId),fileId).run();
 }
 return filePins(db,orgId,userId);
}
