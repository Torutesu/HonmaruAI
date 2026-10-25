import {pruneEmptyFileReservations} from './fileReservations.js';
import {recoverFileUploads} from './fileUploadRecovery.js';
import {recoverFileAccountErasures} from './fileAccount.js';
import {maintainFileRetention} from './fileRetention.js';

export async function maintainWorkspaceFiles(env,{now=Date.now()}={}) {
 // Rollout compatibility: no file tables means no file maintenance. A partial
 // migration is not interpreted as authorization to erase anything.
 const {results}=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hx_workspace_files','hx_workspace_file_versions','hx_workspace_file_purges','hx_workspace_file_uploads','hx_file_account_erasures')").all();
 if(results.length!==5)return {enabled:false};
 const outcomes=await Promise.allSettled([
  env.MEDIA?recoverFileUploads(env,{now}):Promise.resolve(null),
  recoverFileAccountErasures(env.DB,{now}),
  maintainFileRetention(env.DB,{now}),
  pruneEmptyFileReservations(env.DB,{now}),
 ]);
 const errors=outcomes.filter(outcome=>outcome.status==='rejected');
 if(errors.length)throw new AggregateError(errors.map(outcome=>outcome.reason),'File maintenance failed');
 return {enabled:true,uploads:outcomes[0].value,accounts:outcomes[1].value,retention:outcomes[2].value,reservations:outcomes[3].value};
}
