import { appConversation } from './appConversations.js';

// Activity and an app's bell share notification rows, including read state.
async function visibleNotifications(db, orgId, userId) {
  const {results}=await db.prepare(`SELECT n.message_id,n.kind,n.read_at,m.body,m.table_id,m.row_id,m.created_at,m.app_id,a.name AS app_name,u.name AS author_name,u.login AS author_login
    FROM hx_app_notifications n JOIN hx_app_messages m ON m.sequence=n.message_id AND m.org_id=n.org_id AND m.app_id=n.app_id
    JOIN hx_apps a ON a.id=n.app_id AND a.org_id=n.org_id LEFT JOIN users u ON u.github_id=m.author_id
    WHERE n.org_id=? AND n.user_id=? ORDER BY m.sequence DESC LIMIT 100`).bind(orgId,String(userId)).all();
  const visible=[],checks=new Map();
  for(const row of results){
    const key=JSON.stringify([row.app_id,row.table_id,row.row_id]);
    if(!checks.has(key))checks.set(key,!(await appConversation(db,orgId,userId,row.app_id,{tableId:row.table_id,rowId:row.row_id})).error);
    if(checks.get(key))visible.push(row);
  }
  return visible;
}
export async function appActivity(db,orgId,userId){
  return (await visibleNotifications(db,orgId,userId)).map(row=>({
    key:`a:${row.message_id}`,type:row.kind==='ai'?'reply':'mention',unread:!row.read_at,at:row.created_at,
    app:{id:row.app_id,name:row.app_name,tableId:row.table_id||undefined,rowId:row.row_id||undefined},
    message:{id:`object_${row.message_id}`,channel:`app:${row.app_id}`,kind:row.kind==='ai'?'ai':'message',body:row.body,createdAt:row.created_at,authorName:row.author_name||row.author_login||'AI',parentId:null},
  }));
}
export async function readAppActivity(db,orgId,userId,keys=null){
  const wanted=keys===null?null:new Set(keys.filter(k=>/^a:[1-9][0-9]*$/.test(k)).slice(0,100));
  const rows=(await visibleNotifications(db,orgId,userId)).filter(r=>!wanted||wanted.has(`a:${r.message_id}`));
  if(rows.length)await db.batch(rows.map(r=>db.prepare('UPDATE hx_app_notifications SET read_at=COALESCE(read_at,?) WHERE org_id=? AND app_id=? AND user_id=? AND message_id=?').bind(new Date().toISOString(),orgId,r.app_id,String(userId),r.message_id)));
  return rows.map(r=>`a:${r.message_id}`);
}
