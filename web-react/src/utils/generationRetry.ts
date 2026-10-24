// Keep only an opaque request identity, never the prompt or session token.
// An unresolved request has no expiry: expiring it could duplicate a creation
// whose successful response was lost. Clear it only after confirmed success.
export interface GenerationRetry {key:string;id:string}
const memory=new Map<string,string>()
const unpersisted=new Set<string>()
const prefix='hx.generation.retry.v1:'
export async function generationRetry(scope:{host:string;orgId:string;userId:string;kind:string;channel:string;prompt:string;timezone?:string}):Promise<GenerationRetry>{
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([scope.host,scope.orgId,scope.userId,scope.kind,scope.channel,scope.prompt,scope.timezone||null])))
 const key=prefix+[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('')
 const choose=()=>{
  let saved:string|null=null,readable=false
  try{saved=localStorage.getItem(key);readable=true}catch{/* storage may be unavailable */}
  const id=saved&&/^[\w-]{16,100}$/.test(saved)?saved:((!readable||unpersisted.has(key))&&memory.get(key))||crypto.randomUUID()
  memory.set(key,id)
  try{localStorage.setItem(key,id);unpersisted.delete(key)}catch{unpersisted.add(key)}
  return {key,id}
 }
 // Serialize creation across tabs where Web Locks is available.
 return typeof navigator!=='undefined'&&navigator.locks?navigator.locks.request(key,choose):choose()
}
export function finishGenerationRetry(retry:GenerationRetry){
 if(memory.get(retry.key)===retry.id){memory.delete(retry.key);unpersisted.delete(retry.key)}
 try{if(localStorage.getItem(retry.key)===retry.id)localStorage.removeItem(retry.key)}catch{/* keep successful UI usable */}
}
