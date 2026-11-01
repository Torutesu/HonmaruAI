import { mirrorIds } from '../store/mirror.js';
import { appCreationSource, createApp, getApp, requestedSampleRows, specFromPrompt } from './apps.js';
import { mayUseApp } from './resourceAccess.js';
import { mayUseConversation } from './conversationAccess.js';
import { resolveChannel, postMessage, getMessage } from '../channels.js';
import { broadcastStored } from '../channelRoutes.js';
import { checkOutgoing } from '../dlp.js';
import { completer } from './model.js';
import { formatRoomGuidelinesRequest, getGuidelines } from './guidelines.js';

const conflict = () => ({error:'This app is still being created. Try again shortly.',status:409});
const leaseMs = 120000;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const sampleIntent = prompt => {
  const text=prompt.normalize('NFKC');
  const positive=/(?:サンプル|見本|ダミー)(?:データ|レコード|行)|\b(?:sample|example|dummy)\s+(?:data|rows?|records?|entries)\b/iu.test(text);
  const negative=/(?:サンプル|見本|ダミー|初期データ)[^、。,，.!！?？;；\n]{0,30}(?:不要|なし|ない|ません|せず|禁止|やめ|後日|後で|0件|零件|ゼロ|空)|(?:サンプル|見本|ダミー|初期データ)[^。.!！?？;；\n]{0,45}(?:前に(?:相談|確認|承認)|承認後|確認後)|(?:ただし|しかし|まだ|今は)[^。.!！?？;；\n]{0,35}(?:ない|ません|せず|禁止|後日|後で)|\b(?:no|without|never|don't|not)\b[^。.!！?？;；\n]{0,35}\b(?:sample|example|dummy|rows?|records?)\b|\b(?:sample|example|dummy)\b[^。.!！?？;；\n]{0,30}\b(?:not needed|not required|omitted|excluded|removed|later|future)\b|\b(?:no|zero|0)\s+(?:rows?|records?|entries|data)\b/iu.test(text);
  return {positive,negative};
};
// A stated upper bound can only reduce the explicitly selected UI/API limit.
const sampleLimitInPrompt = prompt => {
  const text=prompt.normalize('NFKC');
  const patterns=[
    /(?:サンプル|見本|ダミー)(?:データ|レコード|行)[^、。,，.!！?？;；\n]{0,24}?([0-9]+|[一二三四五六七八九十]+|ひと)\s*(?:件|行|レコード|つ|個|例)/gu,
    /([0-9]+|[一二三四五六七八九十]+|ひと)\s*(?:件|行|レコード|つ|個|例)[^、。,，.!！?？;；\n]{0,12}?(?:サンプル|見本|ダミー)(?:データ|レコード|行)/gu,
    /(?:^|[、。,，.!！?？;；\n])\s*(?:ただし\s*)?([0-9]+|[一二三四五六七八九十]+|ひと)\s*(?:件|行|レコード|つ|個|例)\s*(?:だけ|のみ)/gu,
    /\b([0-9]+|a single|a|an|one|two|three)\s+(?:sample|example|dummy)\s+(?:rows?|records?|entries|items?)\b/giu,
    /\b(?:sample|example|dummy)\s+(?:data|rows?|records?|entries|items?)[^、。,，.!！?？;；\n]{0,20}?\b(?:a\s+)?([0-9]+|single|one|two|three)\s+(?:rows?|records?|entries|items?)\b/giu,
    /\bonly\s+([0-9]+|one|two|three)\s+(?:rows?|records?|entries|items?)\b/giu,
  ];
  const digits={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const words={a:1,an:1,'a single':1,single:1,one:1,two:2,three:3,ひと:1};
  const counts=patterns.flatMap(pattern=>[...text.matchAll(pattern)].map(match=>match[1].toLowerCase())).map(value=>/^[0-9]+$/u.test(value)?Number(value):words[value]||(value.includes('十')?(digits[value.split('十')[0]]||1)*10+(digits[value.split('十')[1]]||0):digits[value])).filter(Number.isFinite);
  return counts.length?Math.min(...counts):null;
};

// The same request keeps its source thread and app across disconnects. A lease
// prevents two model calls in flight; a transaction fences an expired owner.
export async function generateApp(env, request, orgId, who, input, {makeCompleter=completer}={}) {
  const by=String(who.session.github_id), login=who.user.login;
  const prompt=typeof input.prompt==='string'?input.prompt.trim():'';
  if(!prompt || prompt.length>4000) return {error:'Describe the app in 1–4000 characters.',status:400};
  if(input.sampleCount!==undefined && (!Number.isSafeInteger(input.sampleCount)||input.sampleCount<0||input.sampleCount>20)) return {error:'Sample row count must be an integer between 0 and 20.',status:400};
  const sampleCount=input.sampleCount??0;
  const promptLimit=sampleLimitInPrompt(prompt);
  const effectiveSampleCount=promptLimit===null?sampleCount:Math.min(sampleCount,promptLimit);
  const requestId=input.requestId;
  if(requestId!==undefined && (typeof requestId!=='string'||!/^[\w-]{16,100}$/.test(requestId))) return {error:'Invalid generation request ID.',status:400};
  if(input.captureSource && !requestId) return {error:'A request ID is required to keep the source conversation.',status:400};
  let channel=null, privateByDefault=false;
  let sourceThreadId=input.sourceThreadId||null;
  if(sourceThreadId){
    const origin=await appCreationSource(env.DB,orgId,by,sourceThreadId);
    if(origin.error)return origin;
    channel=origin.source.channel; privateByDefault=origin.private;
  } else if(input.channel){
    const room=await resolveChannel(env.DB,orgId,who.user,input.channel);
    if(!room || !await mayUseConversation(env.DB,orgId,by,room.key))return {error:'No such room.',status:403};
    channel=room.key; privateByDefault=room.kind!=='business'||Boolean(room.private);
  }
  if(input.captureSource && !channel)return {error:'Choose a room for the source conversation.',status:400};
  const denied=await checkOutgoing(env,request,{orgId,login,text:prompt,ack:input.dlpAck===true,where:'app generation'});
  if(denied)return {response:denied};
  const name=typeof input.name==='string'?input.name.trim().slice(0,80):'';
  const fingerprint=await digest(JSON.stringify({prompt,name,channel,sourceThreadId,captureSource:Boolean(input.captureSource),useModel:input.useModel!==false,...(sampleCount?{sampleCount}:{})}));
  const token=crypto.randomUUID();
  let job=null;
  const jobOf=()=>env.DB.prepare('SELECT * FROM hx_app_generation_jobs WHERE org_id=? AND user_id=? AND request_id=?').bind(orgId,by,requestId).first();
  if(requestId){
    await env.DB.prepare(`INSERT OR IGNORE INTO hx_app_generation_jobs(org_id,user_id,request_id,fingerprint,lease_token,lease_until,status)
      VALUES (?,?,?,?,?,?,'running')`).bind(orgId,by,requestId,fingerprint,token,Date.now()+leaseMs).run();
    job=await jobOf();
    if(job.fingerprint!==fingerprint)return {error:'This request ID was already used for a different app request.',status:409};
    if(job.status==='complete'){
      if(!await mayUseApp(env.DB,orgId,job.app_id,by))return {error:'The generated app is no longer available.',status:404};
      const made=JSON.parse(job.generated);
      return {app:await getApp(env.DB,orgId,job.app_id),source:made.source,room:made.room||null,replay:true};
    }
    if(job.lease_token!==token){
      const claimed=await env.DB.prepare(`UPDATE hx_app_generation_jobs SET lease_token=?,lease_until=?,status='running'
        WHERE org_id=? AND user_id=? AND request_id=? AND fingerprint=? AND (status='failed' OR (status='running' AND lease_until<?))`)
        .bind(token,Date.now()+leaseMs,orgId,by,requestId,fingerprint,Date.now()).run();
      if(!claimed.meta?.changes)return conflict();
      job=await jobOf();
    }
  }
  const release=async()=>{
    if(requestId)await env.DB.prepare("UPDATE hx_app_generation_jobs SET status='failed',lease_until=0 WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running'")
      .bind(orgId,by,requestId,token).run();
  };
  try {
    const sampleHint=sampleIntent(prompt);
    const japanese=/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(prompt);
    if(sampleCount>0 && sampleHint.negative){await release();return {error:japanese?'サンプル行の件数と依頼文が矛盾しています。初期データの設定を確認してください。':'The sample row count conflicts with the request. Check the initial data setting.',status:400};}
    if(sampleCount===0 && sampleHint.positive && !sampleHint.negative){await release();return {error:japanese?'サンプル行を追加する場合は、アプリ作成画面の「初期データ」で件数を選択してください。':'To add sample rows, choose a count under Initial data on the app creation screen.',status:400};}
    if(input.captureSource && !sourceThreadId){
      // Client IDs are author-scoped. Include workspace and request in the
      // digest, so another generation cannot take over this source message.
      const clientId='tmp-app-'+(await digest(JSON.stringify([orgId,by,requestId])));
      const root=await postMessage(env.DB,{orgId,key:channel,authorLogin:login,body:prompt,clientId});
      if(root.error){await release();return root;}
      if(root.row.deleted_at || root.row.channel!==channel || root.row.body!==prompt){await release();return {error:'The source conversation changed. Start a new generation request.',status:409};}
      sourceThreadId=root.row.id;
      if(!root.replay)await broadcastStored(env,orgId,channel,root.row).catch(()=>{});
      // Do not invoke the channel's AI responder: this prompt is already
      // handled by app generation and must not start a second model call.
    }
    let made=job?.generated?JSON.parse(job.generated):null;
    if(made && made.generationFormat!==2){await release();return {error:'以前の生成案は現在の安全な形式ではありません。新しい依頼として作り直してください。',status:409};}
    if(!made){
      const complete=input.useModel===false?null:await makeCompleter(env,orgId,by,'app_generate',{maxTokens:2400});
      const guidelines=channel?.startsWith('b:')?await getGuidelines(env.DB,orgId,channel):null;
      const guidedPrompt=formatRoomGuidelinesRequest(guidelines,prompt);
      // Room rules are model context; classification and the 4,000-character
      // request limit apply to the user's original request alone.
      made=await specFromPrompt(prompt,{complete,modelRequest:guidedPrompt,guidelines:guidelines?.body||'',sampleCount:effectiveSampleCount});
      if(made.error){await release();return made;}
      made={...made,generationFormat:2};
      if(requestId){
        const saved=await env.DB.prepare(`UPDATE hx_app_generation_jobs SET generated=? WHERE org_id=? AND user_id=? AND request_id=? AND lease_token=? AND status='running' AND lease_until>?`)
          .bind(JSON.stringify(made),orgId,by,requestId,token,Date.now()).run();
        if(!saved.meta?.changes)return conflict();
      }
    }
    // Model work can outlive a membership or room grant.
    if(channel && !await mayUseConversation(env.DB,orgId,by,channel)){await release();return {error:'No such room.',status:403};}
    const member=await env.DB.prepare("SELECT 1 FROM memberships WHERE org_id=? AND user_github_id=? AND role!='guest'").bind(orgId,by).first();
    if(!member){await release();return {error:'Workspace membership is required.',status:403};}
    const spec=made.spec;
    const result=await createApp(env.DB,{orgId,by,name:name||spec.name,tableName:spec.tableName||spec.name,description:spec.description,icon:spec.icon,
      columns:spec.columns,definition:spec.definition,template:spec.template||null,sample:requestedSampleRows(spec.sample,spec.columns,effectiveSampleCount),channel,sourceThreadId,privateByDefault},
      {announceInSource:true,...(requestId?{commitGuard:appId=>env.DB.prepare(`UPDATE hx_app_generation_jobs
        SET app_id=CASE WHEN lease_token=? AND lease_until>? AND status='running' THEN ? ELSE NULL END,status='complete'
        WHERE org_id=? AND user_id=? AND request_id=?`).bind(token,Date.now(),appId,orgId,by,requestId)}:{})});
    if(result.error){await release();return result;}
    const {announcementId,...published}=result;
    if(announcementId){
      await mirrorIds(env.DB,orgId,[announcementId]);
      const message=await getMessage(env.DB,orgId,announcementId);
      if(message)await broadcastStored(env,orgId,channel,message).catch(()=>{});
    }
    return {...published,source:made.source,room:made.room||null};
  }catch(error){
    if(requestId && (await jobOf())?.lease_token!==token)return conflict();
    await release();throw error;
  }
}
