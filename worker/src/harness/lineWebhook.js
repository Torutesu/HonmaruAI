const encoder = new TextEncoder();

/// LINE signs the exact request bytes with HMAC-SHA256 and sends base64 in
/// x-line-signature. Verify before decoding or parsing the body.
export async function verifyLineWebhookSignature(channelSecret, rawBody, signature) {
  if (typeof channelSecret !== 'string' || channelSecret.length < 16
    || !(rawBody instanceof Uint8Array) || typeof signature !== 'string'
    || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  let supplied;
  try { supplied = Uint8Array.from(atob(signature), character => character.charCodeAt(0)); }
  catch { return false; }
  if (supplied.length !== 32) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(channelSecret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, supplied, rawBody);
}

async function customerAlias(accountId, source) {
  const externalId = source?.userId || source?.groupId || source?.roomId || '';
  if (!externalId || !['user','group','room'].includes(source?.type)) return 'unknown';
  const material = JSON.stringify(['line-inbox-v1',accountId,source.type,String(externalId)]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(material)));
  const alias = Array.from(digest.slice(0,5), byte => byte.toString(16).padStart(2,'0')).join('');
  return `customer-${alias}`;
}

/// Convert only inbound LINE message events into room text. Profile IDs are
/// represented by a workspace-scoped pseudonym; message content remains
/// untrusted input and is never sent to an Agent by this path.
export async function lineMessagesFromWebhook(accountId, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events) || payload.events.length > 100) {
    return {error:'The LINE webhook payload is invalid.',status:400};
  }
  const messages=[];
  let ignored=0;
  for(const event of payload.events) {
    if(event?.type!=='message' || !event.message || typeof event.message!=='object') { ignored++; continue; }
    const message=event.message;
    const id=typeof event.webhookEventId==='string' && event.webhookEventId
      ? event.webhookEventId
      : typeof message.id==='string' && message.id ? `message:${message.id}` : '';
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return {error:'A LINE message event is missing its stable event ID.',status:400};
    const alias=await customerAlias(accountId,event.source);
    let content;
    if(message.type==='text' && typeof message.text==='string') content=message.text;
    else if(['image','video','audio','file','location','sticker'].includes(message.type)) content=`Attachment received (${message.type}). This connection stores text events only.`;
    else content=`Unsupported LINE message type: ${String(message.type||'unknown').slice(0,40)}.`;
    const body=`LINE · ${alias}\n${content}`.slice(0,4000);
    messages.push({eventId:id,body});
  }
  return {messages,ignored};
}
