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

// Keep this deliberately small JSON Schema subset aligned with the Worker.
// The host broker repeats these checks; guest validation is for quick feedback.
export function normalizeWorkflowAgentCall(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || new TextEncoder().encode(prompt).length > 12000) throw Error('agent expects non-empty prompt up to 12 KB.');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['agentId','schema','tier'].includes(key))) throw Error('Invalid agent options.');
  if (typeof options.agentId !== 'string' || !options.agentId.trim() || options.agentId.length > 200) throw Error('Invalid agentId.');
  const tier = options.tier === undefined ? 'medium' : options.tier;
  if (!['high','medium','low'].includes(tier)) throw Error('Invalid agent tier.');
  const schema = options.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('agent requires a JSON Schema object.');
  let encoded;
  try { encoded = JSON.stringify(schema); } catch { throw Error('Invalid agent schema.'); }
  if (new TextEncoder().encode(encoded).length > 16000) throw Error('Agent schema exceeds 16 KB.');
  const cleanSchema = JSON.parse(encoded);
  let nodes = 0;
  const visit = (node, depth, root = false) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 5 || ++nodes > 128) throw Error('Invalid agent schema.');
    const allowed = ['type','properties','required','additionalProperties','items','maxItems','minLength','maxLength','minimum','maximum','enum'];
    if (Object.keys(node).some(key => !allowed.includes(key))) throw Error('Unsupported agent schema keyword.');
    if (typeof node.type !== 'string' || !['object','string','number','integer','boolean','null','array'].includes(node.type) || root && node.type !== 'object') throw Error('Unsupported agent schema type.');
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 100 || node.enum.some(value => value !== null && !['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)))) throw Error('Invalid agent schema enum.');
    if (node.type === 'object') {
      const props = node.properties;
      if (!props || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length > 32 || node.additionalProperties !== false) throw Error('Agent object schemas require bounded properties and additionalProperties:false.');
      if (Object.keys(props).some(key => !key || key.length > 100)) throw Error('Invalid agent schema property name.');
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 32 || new Set(node.required).size !== node.required.length || node.required.some(key => typeof key !== 'string' || !Object.hasOwn(props, key)))) throw Error('Invalid agent schema required fields.');
      for (const value of Object.values(props)) visit(value, depth + 1);
    } else if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined) throw Error('Object schema keywords require type object.');
    if (node.type === 'array') {
      if (node.items === undefined) throw Error('Agent array schemas require items.');
      if (node.maxItems !== undefined && (!Number.isSafeInteger(node.maxItems) || node.maxItems < 0 || node.maxItems > 100)) throw Error('Invalid agent schema maxItems.');
      visit(node.items, depth + 1);
    } else if (node.items !== undefined || node.maxItems !== undefined) throw Error('Array schema keywords require type array.');
    for (const key of ['minLength','maxLength']) if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || node[key] < 0 || node[key] > 10000)) throw Error('Invalid agent schema string length.');
    if (node.minLength !== undefined || node.maxLength !== undefined) if (node.type !== 'string' || node.minLength !== undefined && node.maxLength !== undefined && node.minLength > node.maxLength) throw Error('String length constraints require type string.');
    for (const key of ['minimum','maximum']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) throw Error('Invalid agent schema numeric bound.');
    if (node.minimum !== undefined || node.maximum !== undefined) if (!['number','integer'].includes(node.type) || node.minimum !== undefined && node.maximum !== undefined && node.minimum > node.maximum) throw Error('Numeric bounds require number or integer type.');
  };
  visit(cleanSchema, 1, true);
  return {agentId:options.agentId, prompt, schema:cleanSchema, tier};
}

export async function invokeWorkflowAgent(prompt, options = {}, bridge = undefined) {
  const clean = normalizeWorkflowAgentCall(prompt, options);
  if (typeof bridge?.invokeAgent !== 'function') throw Error('Workflow agent invocation is unavailable.');
  const result = await bridge.invokeAgent(clean);
  if (!result || !Object.hasOwn(result, 'output')) throw Error('Workflow agent returned an invalid result.');
  return result.output;
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

function validWorkflowRowTarget(input, allowedKeys) {
  return input&&typeof input==='object'&&!Array.isArray(input)&&!Object.keys(input).some(key=>!allowedKeys.includes(key))
    &&typeof input.entityId==='string'&&/^([a-z][a-z0-9_]{0,39})$/.test(input.entityId)
    &&typeof input.rowId==='string'&&input.rowId.length>0&&input.rowId.length<=200
    &&typeof input.expectedUpdatedAt==='string'&&input.expectedUpdatedAt.length<=64&&Number.isFinite(Date.parse(input.expectedUpdatedAt));
}

export function normalizeWorkflowUpdate(input={}) {
  if(!validWorkflowRowTarget(input,['entityId','rowId','values','expectedUpdatedAt'])||!input.values||typeof input.values!=='object'||Array.isArray(input.values)||Object.keys(input.values).length>100||new TextEncoder().encode(JSON.stringify(input.values)).length>24000)throw Error('Invalid table.update request.');
  return {entityId:input.entityId,rowId:input.rowId,values:input.values,expectedUpdatedAt:input.expectedUpdatedAt};
}

export async function updateWorkflowTableRow(input={},bridge=undefined) {
  const clean=normalizeWorkflowUpdate(input),sources=bridge?.tableSources||(bridge?.tableSource?[bridge.tableSource]:[]);
  if(typeof bridge?.updateTable!=='function'||!sources.some(item=>item.entityId===clean.entityId&&item.mutate===true))throw Error('Row updates are not enabled for this App entity.');
  return bridge.updateTable(clean);
}

export function normalizeWorkflowDelete(input={}) {
  if(!validWorkflowRowTarget(input,['entityId','rowId','expectedUpdatedAt']))throw Error('Invalid table.delete request.');
  return {entityId:input.entityId,rowId:input.rowId,expectedUpdatedAt:input.expectedUpdatedAt};
}

export async function deleteWorkflowTableRow(input={},bridge=undefined) {
  const clean=normalizeWorkflowDelete(input),sources=bridge?.tableSources||(bridge?.tableSource?[bridge.tableSource]:[]);
  if(typeof bridge?.deleteTable!=='function'||!sources.some(item=>item.entityId===clean.entityId&&item.mutate===true))throw Error('Row deletions are not enabled for this App entity.');
  return bridge.deleteTable(clean);
}

export function normalizeWorkflowConnectionRequest(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['appId','name','query','body'].includes(key))
    ||typeof input.appId!=='string'||!input.appId.trim()||input.appId.length>200
    ||typeof input.name!=='string'||!/^([a-z][a-z0-9_]{0,39})$/.test(input.name)||input.body!==undefined)throw Error('Invalid read-only App connection request.');
  const clean={appId:input.appId,name:input.name};
  if(input.query!==undefined){
    const query=input.query;
    if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).length>100||new TextEncoder().encode(JSON.stringify(query)).length>20000)throw Error('Invalid App connection query.');
    for(const [key,value] of Object.entries(query)){
      const values=Array.isArray(value)?value:[value];
      if(!key||key.length>100||/(token|auth|secret|password|credential|api[-_]?key)/i.test(key)||values.length>100||values.some(item=>!(typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))))throw Error('Invalid App connection query value.');
    }
    clean.query=query;
  }
  return clean;
}

export async function requestWorkflowConnection(input={},bridge=undefined) {
  const clean=normalizeWorkflowConnectionRequest(input),sources=bridge?.connectionSources||[];
  const source=sources.find(item=>item.appId===clean.appId&&item.name===clean.name);
  if(!source)throw Error('This Workflow has no frozen binding for the App connection.');
  if(source.method!=='GET')throw Error('Writes through App connections require a Workflow approval step.');
  if(typeof bridge?.requestConnection!=='function')throw Error('App connections are unavailable.');
  return bridge.requestConnection(clean);
}

function workflowSdkBaseSource(bridgeExpression = 'undefined') {
  return `const parallel=${parallel.toString()};\nconst pipeline=${pipeline.toString()};\nconst normalizeWorkflowDraft=${normalizeWorkflowDraft.toString()};\nconst normalizeWorkflowAgentCall=${normalizeWorkflowAgentCall.toString()};\nconst invokeWorkflowAgent=${invokeWorkflowAgent.toString()};\nconst workflowBridge=()=>${bridgeExpression};\nexport async function sendMessage(text,options={}){const draft=normalizeWorkflowDraft(text,options);const bridge=workflowBridge();if(typeof bridge?.stageMessage!==\"function\")throw Error(\"Workflow message staging is unavailable.\");return bridge.stageMessage(draft)}\nexport async function agent(prompt,options={}){return invokeWorkflowAgent(prompt,options,workflowBridge())}\nexport {parallel,pipeline};`;
}

export function workflowSdkSource(bridgeExpression = 'undefined') {
  return workflowSdkBaseSource(bridgeExpression) + `\nconst normalizeWorkflowQueryOptions=${normalizeWorkflowQueryOptions.toString()};\nconst queryWorkflowTable=${queryWorkflowTable.toString()};\nconst normalizeWorkflowInsert=${normalizeWorkflowInsert.toString()};\nconst insertWorkflowTableRow=${insertWorkflowTableRow.toString()};\nconst validWorkflowRowTarget=${validWorkflowRowTarget.toString()};\nconst normalizeWorkflowUpdate=${normalizeWorkflowUpdate.toString()};\nconst updateWorkflowTableRow=${updateWorkflowTableRow.toString()};\nconst normalizeWorkflowDelete=${normalizeWorkflowDelete.toString()};\nconst deleteWorkflowTableRow=${deleteWorkflowTableRow.toString()};\nconst normalizeWorkflowConnectionRequest=${normalizeWorkflowConnectionRequest.toString()};\nconst requestWorkflowConnection=${requestWorkflowConnection.toString()};\nconst sdkBridge=workflowBridge();\nexport const table=Object.freeze({query:(options={})=>queryWorkflowTable(options,sdkBridge),insert:(input={})=>insertWorkflowTableRow(input,sdkBridge),update:(input={})=>updateWorkflowTableRow(input,sdkBridge),delete:(input={})=>deleteWorkflowTableRow(input,sdkBridge)});\nexport const connection=Object.freeze({request:(input={})=>requestWorkflowConnection(input,sdkBridge)});`;
}
