import { mayUseApp } from './resourceAccess.js';
export async function appPins(db, orgId, userId) {
  const { results } = await db.prepare('SELECT app_id FROM hx_app_pins WHERE org_id=?1 AND user_id=?2 ORDER BY created_at, app_id').bind(orgId,String(userId)).all();
  const pins=[];
  for(const row of results || []) if(await mayUseApp(db,orgId,row.app_id,userId)) pins.push(row.app_id);
  return { pins };
}
export async function setAppPin(db, orgId, userId, appId, pinned) {
  if(typeof appId!=='string' || !/^[\w-]{1,80}$/.test(appId) || typeof pinned!=='boolean') return {error:'Invalid pin.',status:400};
  if(pinned && !(await mayUseApp(db,orgId,appId,userId))) return {error:'No such app.',status:404};
  if(pinned) await db.prepare('INSERT OR IGNORE INTO hx_app_pins (org_id,user_id,app_id,created_at) VALUES (?1,?2,?3,?4)').bind(orgId,String(userId),appId,new Date().toISOString()).run();
  else await db.prepare('DELETE FROM hx_app_pins WHERE org_id=?1 AND user_id=?2 AND app_id=?3').bind(orgId,String(userId),appId).run();
  return appPins(db,orgId,userId);
}
