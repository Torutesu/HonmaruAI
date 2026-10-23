// A compare-and-swap retry. Preserve the previous outcome, and never delete
// the original acceptance receipt: provider redelivery is still not a retry.
export async function queueRoomHookRetry(storage,{orgId,rowId,expectedAt,confirmInterrupted=false}) {
  if(!Number.isSafeInteger(expectedAt)||expectedAt<0)return {status:400};
  return storage.transaction(async tx=>{
    const resultKey=`result:${JSON.stringify([orgId,'room_hook',rowId])}`;
    const result=await tx.get(resultKey);
    if(!result||result.at!==expectedAt||!['failed','interrupted','no_agents'].includes(result.status))return {status:409};
    if(result.status==='interrupted'&&confirmInterrupted!==true)return {status:409};
    const waiting=await tx.list({prefix:'job:',limit:51});
    if([...waiting.values()].some(j=>j.orgId===orgId&&j.rowId===rowId&&j.kind==='room_hook'))return {status:409};
    if(waiting.size>=50)return {status:503};
    const queuedAt=Math.max(Date.now(),expectedAt+1);
    await tx.put(`history:${JSON.stringify([orgId,rowId,expectedAt])}`,result);
    await tx.put(`job:${queuedAt}:room_hook:${rowId}`,{kind:'room_hook',orgId,rowId,queuedAt});
    await tx.delete(resultKey);
    await tx.put(`accepted:${JSON.stringify([orgId,'room_hook',rowId,null])}`,{acceptedAt:queuedAt});
    return {status:202};
  });
}
