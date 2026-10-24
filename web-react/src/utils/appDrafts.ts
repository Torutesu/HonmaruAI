/** Local unsent text is isolated by server, account, workspace and record. */
export function appDrafts(base:string, orgId:string, token:string) {
 let user:string|null=null
 try { if(localStorage.getItem('sessionToken')===token)user=localStorage.getItem('userId') } catch { /* Storage can be unavailable. */ }
 const key=(app:string,table?:string,row?:string)=>'hx-app-draft:'+JSON.stringify([base,user,orgId,app,table||null,row||null])
 const current=()=>user&&localStorage.getItem('userId')===user&&localStorage.getItem('sessionToken')===token
 return {
  read(app:string,table?:string,row?:string) { try{return current()?(localStorage.getItem(key(app,table,row))||'').slice(0,4000):''}catch{return ''} },
  write(text:string,app:string,table?:string,row?:string) { try{if(!current())return;const k=key(app,table,row);if(text)localStorage.setItem(k,text.slice(0,4000));else localStorage.removeItem(k)}catch{ /* Keep editing when storage is full or disabled. */ } },
 }
}
