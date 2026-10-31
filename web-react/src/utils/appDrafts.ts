import type {AppAnnotationMeta} from './harness'

/** Local unsent text is isolated by server, account, workspace and record. */
export function appDrafts(base:string, orgId:string, token:string) {
 let user:string|null=null
 try { if(localStorage.getItem('sessionToken')===token)user=localStorage.getItem('userId') } catch { /* Storage can be unavailable. */ }
 const key=(app:string,table?:string,row?:string)=>'hx-app-draft:'+JSON.stringify([base,user,orgId,app,table||null,row||null])
 const annotationKey=(app:string,table?:string,row?:string)=>key(app,table,row)+':annotation'
 const current=()=>user&&localStorage.getItem('userId')===user&&localStorage.getItem('sessionToken')===token
 return {
  read(app:string,table?:string,row?:string) { try{return current()?(localStorage.getItem(key(app,table,row))||'').slice(0,4000):''}catch{return ''} },
  write(text:string,app:string,table?:string,row?:string) { try{if(!current())return;const k=key(app,table,row);if(text)localStorage.setItem(k,text.slice(0,4000));else localStorage.removeItem(k)}catch{ /* Keep editing when storage is full or disabled. */ } },
  readAnnotation(app:string,table?:string,row?:string):AppAnnotationMeta|null { try{if(!current())return null;const value=JSON.parse(localStorage.getItem(annotationKey(app,table,row))||'null');if(!value||typeof value.target!=='string'||!value.target.trim()||value.target.length>100||!Number.isFinite(value.x)||!Number.isFinite(value.y)||value.x<0||value.x>100||value.y<0||value.y>100||!['overview','data'].includes(value.section))return null;return {target:value.target.slice(0,100),x:value.x,y:value.y,section:value.section}}catch{return null} },
  writeAnnotation(annotation:AppAnnotationMeta|null,app:string,table?:string,row?:string) { try{if(!current())return;const k=annotationKey(app,table,row);if(annotation&&typeof annotation.target==='string'&&annotation.target.trim()&&Number.isFinite(annotation.x)&&Number.isFinite(annotation.y)&&annotation.x>=0&&annotation.x<=100&&annotation.y>=0&&annotation.y<=100&&['overview','data'].includes(annotation.section))localStorage.setItem(k,JSON.stringify({target:annotation.target.slice(0,100),x:annotation.x,y:annotation.y,section:annotation.section}));else localStorage.removeItem(k)}catch{ /* Keep editing when storage is full or disabled. */ } },
 }
}
