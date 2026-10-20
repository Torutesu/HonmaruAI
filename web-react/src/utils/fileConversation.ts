export type FileConversationRequest = {fileId:string;resolve:(hash:string)=>void;reject:(error:Error)=>void}
export function openFileConversation(fileId:string):Promise<string>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('会話を開けませんでした。再試行してください。')),20000)
  window.dispatchEvent(new CustomEvent<FileConversationRequest>('honmaru:file-conversation',{detail:{
   fileId,resolve:hash=>{clearTimeout(timer);resolve(hash)},reject:error=>{clearTimeout(timer);reject(error)},
  }}))
 })
}
