import {member,json} from './routes.js';
import {audit,person} from '../audit.js';
import {prepareImageGeneration,readImageGeneration,listImageGenerations,approveImageGeneration,cancelImageGeneration,decorateImageGeneration} from './mediaGeneration.js';

const fail=(message,status=400)=>json({message},status);
async function body(request){
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return null;
 try{return await request.json()}catch{return null}
}
export async function handleMediaJobs(request,env,url){
 const orgId=url.searchParams.get('orgId');
 if(!orgId)return fail('Workspace is required.');
 const who=await member(env,request,orgId);if(who.denied)return who.denied;
 const userId=String(who.session.github_id),parts=url.pathname.split('/').filter(Boolean);
 if(parts[2]==='nodes')return fail('Not found.',404);
 try{
  let result;
  if(parts.length===2&&request.method==='POST'){
   if(!env.MEDIA)return fail('Image storage is not ready.',503);
   const input=await body(request);if(!input)return fail('Valid JSON input is required.');
   result=await prepareImageGeneration(env.DB,orgId,userId,{scope:input.scope,requestId:input.requestId,prompt:input.prompt});
  }else if(parts.length===2&&request.method==='GET'){
   result=await listImageGenerations(env.DB,orgId,userId,url.searchParams.get('scope'));
  }else if(parts.length===3&&request.method==='GET'){
   result=await readImageGeneration(env.DB,orgId,userId,decodeURIComponent(parts[2]));
  }else if(parts.length===4&&parts[3]==='approve'&&request.method==='POST'){
   const input=await body(request);if(input?.confirmCostVariability!==true)return fail('Explicit confirmation that provider charges vary is required.',400);
   result=await approveImageGeneration(env.DB,orgId,userId,decodeURIComponent(parts[2]),null);
  }else if(parts.length===4&&parts[3]==='cancel'&&request.method==='POST'){
   result=await cancelImageGeneration(env.DB,orgId,userId,decodeURIComponent(parts[2]));
  }else return fail('Method not allowed.',405);
  if(result.error)return fail(result.error,result.status||400);
  if(result.job&&request.method==='POST')await audit(env,request,{orgId,action:parts[3]==='approve'?'media.image_generation_approved':parts[3]==='cancel'?'media.image_generation_cancelled':'media.image_generation_prepared',actor:person(who.user),entity:{type:'media_job',id:result.job.id},details:{status:result.job.status,model:result.job.model}});
  if(result.job)result={...result,job:await decorateImageGeneration(env,result.job,{orgId,userId})};
  if(result.jobs)result={...result,jobs:await Promise.all(result.jobs.map(job=>decorateImageGeneration(env,job,{orgId,userId})))};
  return json(result);
 }catch(error){console.error('media job route failed',error?.message||error);return fail('Image generation request failed.',500)}
}
