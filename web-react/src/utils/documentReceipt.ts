// Only an opaque job ID persists. Source text, filenames, tokens and node
// leases never enter browser storage. The API rechecks the current user.
const key=(scopeKey:string)=>`honmaru-document-receipt:${scopeKey}`
const valid=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
export function readDocumentReceipt(scopeKey?:string):string|null{
 if(!scopeKey)return null
 try{const id=sessionStorage.getItem(key(scopeKey));return valid(id)?id:null}catch{return null}
}
export function saveDocumentReceipt(scopeKey:string|undefined,id:string|null){
 if(!scopeKey)return
 try{if(valid(id))sessionStorage.setItem(key(scopeKey),id);else sessionStorage.removeItem(key(scopeKey))}catch{/* Storage is optional; the server owns the job. */}
}
