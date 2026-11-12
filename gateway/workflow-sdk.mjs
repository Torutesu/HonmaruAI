// Helpers are serialized into the isolated guest module as well as exported
// for the runtime contract tests. They contain no host capabilities.
export async function parallel(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length > 10000) throw Error('parallel expects at most 10,000 tasks.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['concurrency', 'onError'].includes(key))) throw Error('Invalid parallel options.');
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32 || options.onError !== undefined && typeof options.onError !== 'function') throw Error('Invalid parallel concurrency or error handler.');
  const results = new Array(tasks.length);
  let cursor = 0, handlerFailure;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        if (typeof tasks[index] !== 'function') throw Error('A parallel task must be a function.');
        results[index] = await tasks[index]();
      } catch (error) {
        results[index] = null;
        if (options.onError) {
          try { await options.onError(error, index); }
          catch (failure) { handlerFailure ||= failure; }
        }
      }
    }
  });
  await Promise.all(workers);
  if (handlerFailure) throw handlerFailure;
  return results;
}

export async function pipeline(items, ...stepsAndOptions) {
  if (!Array.isArray(items) || items.length > 10000) throw Error('pipeline expects at most 10,000 items.');
  let options = {};
  const last = stepsAndOptions.at(-1);
  if (last && typeof last === 'object' && !Array.isArray(last)) options = stepsAndOptions.pop();
  if (stepsAndOptions.length > 32 || stepsAndOptions.some(step => typeof step !== 'function')) throw Error('pipeline expects up to 32 transformation functions.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['concurrency', 'onError'].includes(key))) throw Error('Invalid pipeline options.');
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32 || options.onError !== undefined && typeof options.onError !== 'function') throw Error('Invalid pipeline concurrency or error handler.');
  let values = [...items];
  const failed = new Set();
  for (let stage = 0; stage < stepsAndOptions.length; stage++) {
    const transform = stepsAndOptions[stage];
    values = await parallel(values.map((value, index) => async () => {
      if (failed.has(index)) return null;
      return transform(value, index);
    }), {
      concurrency,
      onError: async (error, index) => {
        failed.add(index);
        if (options.onError) await options.onError(error, index, stage);
      },
    });
  }
  return values;
}

export function normalizeWorkflowDraft(text, options = {}) {
  if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > 12000) throw Error('sendMessage expects non-empty text up to 12 KB.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'mention')) throw Error('Invalid sendMessage options.');
  let mention;
  if (options.mention !== undefined) {
    const values = Array.isArray(options.mention) ? options.mention : [options.mention];
    if (!values.length || values.length > 25 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 100)) throw Error('Invalid sendMessage mention.');
    mention = Array.isArray(options.mention) ? values.map(value => value.trim()) : options.mention.trim();
  }
  return { text, ...(mention !== undefined ? { mention } : {}) };
}

export function normalizeWorkflowQueryOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['entityId','where','q','pageSize','maxPages','cursor'].includes(key))) throw Error('Invalid table query options.');
  if(options.entityId!==undefined&&(typeof options.entityId!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(options.entityId)))throw Error('Invalid App entity.');
  const pageSize=options.pageSize??100,maxPages=options.maxPages??10;
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>32)throw Error('Table query pageSize must be 1–100 and maxPages 1–32.');
  if(options.q!==undefined&&(typeof options.q!=='string'||options.q.length>200))throw Error('Invalid table query text.');
  if(options.cursor!==undefined&&(typeof options.cursor!=='string'||options.cursor.length>2048))throw Error('Invalid table query cursor.');
  if(options.where!==undefined&&(!options.where||typeof options.where!=='object'||Array.isArray(options.where)||Object.keys(options.where).length>40||new TextEncoder().encode(JSON.stringify(options.where)).length>32000))throw Error('Invalid table query filter.');
  return {entityId:options.entityId,where:options.where??{},q:options.q??'',pageSize,maxPages,cursor:options.cursor};
}

export async function queryWorkflowTable(options={}, bridge=undefined) {
  const clean=normalizeWorkflowQueryOptions(options);
  const sources=bridge?.tableSources||(bridge?.tableSource?[bridge.tableSource]:[]);
  if(typeof bridge?.queryTable!=='function'||!sources.length)throw Error('This workflow has no explicitly authorized App/Table source.');
  const source=clean.entityId?sources.find(item=>item.entityId===clean.entityId):sources.length===1?sources[0]:null;
  if(!source)throw Error(sources.length>1?'Choose an explicitly authorized entityId for table.query.':'This workflow has no explicitly authorized App/Table source.');
  const rows=[];let cursor=clean.cursor,pages=0,complete=false,bytes=0;
  for(;pages<clean.maxPages;pages++){
    const page=await bridge.queryTable({entityId:source.entityId,where:clean.where,q:clean.q,pageSize:clean.pageSize,...(cursor?{cursor}:{})});
    if(!page||!Array.isArray(page.rows)||typeof page.complete!=='boolean'||(page.cursor!==null&&typeof page.cursor!=='string'))throw Error('The App/Table source returned an invalid page.');
    const pageBytes=new TextEncoder().encode(JSON.stringify(page.rows)).length;
    if(bytes+pageBytes>1_000_000)return {rows,complete:false,cursor:cursor??null,pages,incompleteReason:'result_size_limit'};
    rows.push(...page.rows);bytes+=pageBytes;cursor=page.cursor;
    if(page.incompleteReason)return {rows,complete:false,cursor:cursor??null,pages:pages+1,incompleteReason:page.incompleteReason};
    if(page.complete){complete=true;cursor=null;pages++;break;}
  }
  return {rows,complete,cursor:complete?null:cursor,pages,...(!complete?{incompleteReason:'page_limit'}:{})};
}

export function normalizeWorkflowInsert(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['entityId','values'].includes(key))||typeof input.entityId!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(input.entityId)||!input.values||typeof input.values!=='object'||Array.isArray(input.values)||Object.keys(input.values).length>100||new TextEncoder().encode(JSON.stringify(input.values)).length>24000)throw Error('Invalid table.insert request.');
  return {entityId:input.entityId,values:input.values};
}

export async function insertWorkflowTableRow(input={},bridge=undefined) {
  const clean=normalizeWorkflowInsert(input),sources=bridge?.tableSources||(bridge?.tableSource?[bridge.tableSource]:[]);
  if(typeof bridge?.insertTable!=='function'||!sources.some(item=>item.entityId===clean.entityId&&item.write===true))throw Error('Row creation is not enabled for this App entity.');
  return bridge.insertTable(clean);
}

function workflowSdkBaseSource(bridgeExpression = 'undefined') {
  return `const parallel=${parallel.toString()};\nconst pipeline=${pipeline.toString()};\nconst normalizeWorkflowDraft=${normalizeWorkflowDraft.toString()};\nconst workflowBridge=()=>${bridgeExpression};\nexport async function sendMessage(text,options={}){const draft=normalizeWorkflowDraft(text,options);const bridge=workflowBridge();if(typeof bridge?.stageMessage!==\"function\")throw Error(\"Workflow message staging is unavailable.\");return bridge.stageMessage(draft)}\nexport {parallel,pipeline};`;
}

export function workflowSdkSource(bridgeExpression = 'undefined') {
  return workflowSdkBaseSource(bridgeExpression) + `\nconst normalizeWorkflowQueryOptions=${normalizeWorkflowQueryOptions.toString()};\nconst queryWorkflowTable=${queryWorkflowTable.toString()};\nconst normalizeWorkflowInsert=${normalizeWorkflowInsert.toString()};\nconst insertWorkflowTableRow=${insertWorkflowTableRow.toString()};\nconst sdkBridge=workflowBridge();\nexport const table=Object.freeze({query:(options={})=>queryWorkflowTable(options,sdkBridge),insert:(input={})=>insertWorkflowTableRow(input,sdkBridge)});`;
}
