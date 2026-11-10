import {noteUsage} from './ledger.js';
import {isControlTool, handoffOperation} from './agentToolControl.js';

// At most sixteen tools can actually execute in one run. Two lifecycle
// events per execution provide a hard upper bound on trace volume.
const MAX_TOOL_TRACE_EVENTS = 32;
const MAX_MODEL_ROUNDS = 16;
const MAX_TOOL_CALLS = 16;
const COMPACT_AFTER_INPUT_TOKENS = 48_000;
const MAX_CONTEXT_COMPACTIONS = 2;

function boundedText(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  const left = Math.floor((limit - 30) / 2);
  const right = limit - 30 - left;
  return `${text.slice(0, left)}\n[… middle omitted at context checkpoint …]\n${text.slice(-right)}`;
}

function contextCheckpoint(input, completedTools, lastNote) {
  const steps = completedTools.map((item, index) =>
    `${index + 1}. ${item.name}(${boundedText(item.arguments, 500)})\nResult: ${boundedText(item.output, 1000)}`,
  ).join('\n\n');
  return `Continue the same task from this compacted checkpoint. The tool results below are completed work: do not repeat the exact same tool call or side effect. Use these results as facts, retain the original request and its constraints, and continue any remaining work. If the request is complete, answer the user.\n\n<original_request_and_recent_context>\n${boundedText(input, 12000)}\n</original_request_and_recent_context>\n\n<completed_tool_calls>\n${steps || 'No tools completed.'}\n</completed_tool_calls>\n\n<last_agent_progress>\n${boundedText(lastNote, 3000) || 'No intermediate note.'}\n</last_agent_progress>`;
}

function safeToolLabel(name, tools) {
  if (!Object.hasOwn(tools, name)) return 'unknown_tool';
  return String(name).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'tool';
}

async function raceSignal(promise,signal,value) {
  if(!signal)return promise;
  if(signal.aborted)return value;
  let abort;
  const aborted=new Promise(resolve=>{abort=()=>resolve(value);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([promise,aborted]);}
  finally{signal.removeEventListener('abort',abort);}
}

// OpenRouter's normalized function-calling protocol. Only Harness callers
// opt in; the configured model/key stay unchanged. No hosted/paid tools are
// provisioned here, and uncertain model/tool calls are never retried.
export function canChatTools(provider) {
  return provider?.providerName === 'OpenRouter' && provider.endpoint === 'https://openrouter.ai/api/v1/chat/completions';
}

export async function chatTools({provider, instructions, input, tools, authorize = null, onRound = null, onToolEvent = null, deadline = Date.now() + 240000, signal = null, usageContext = null, maxModelRounds = MAX_MODEL_ROUNDS, maxToolCalls = MAX_TOOL_CALLS, maxOutputTokens = 3000}) {
  let called = false, calls = 0, rounds = 0;
  let traceEvents = 0;
  let traceStartedAt = null;
  const traceSteps = [];
  const done = (extra = {}) => {
    const result = {called, answer: null, calls, rounds, compactions: compactions || 0, ...extra};
    if (traceStartedAt !== null) {
      const finishedAtMs = Date.now();
      result.toolTrace = {
        startedAt: new Date(traceStartedAt).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        elapsedMs: Math.max(0, Math.min(24 * 60 * 60 * 1000, finishedAtMs - traceStartedAt)),
        steps: traceSteps,
      };
    }
    return result;
  };
  const emitToolEvent = async (name, phase, status, elapsedMs) => {
    if (traceEvents >= MAX_TOOL_TRACE_EVENTS) return;
    traceEvents++;
    const safeName = safeToolLabel(name, tools);
    const safeElapsedMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(elapsedMs)));
    if (phase === 'started') {
      if (traceStartedAt === null) traceStartedAt = Date.now();
    } else if (traceSteps.length < MAX_TOOL_TRACE_EVENTS / 2) {
      traceSteps.push({name: safeName, status, elapsedMs: safeElapsedMs});
    }
    const event = {
      name: safeName,
      phase,
      status,
      elapsedMs: safeElapsedMs,
    };
    // Tracing is observational: a storage/UI callback failure must never
    // change whether an already-authorized tool is run or its result used.
    if (typeof onToolEvent === 'function') {
      try { await onToolEvent(event); } catch { /* best effort */ }
    }
  };
  const permitted = async () => !signal?.aborted && (!authorize || await authorize());
  const definitions = Object.entries(tools).map(([name, tool]) => ({type: 'function', function: {name, description: tool.description, parameters: tool.parameters}}));
  const messages = [{role: 'system', content: instructions}, {role: 'user', content: input}];
  const receipts = new Map();
  const completedTools = [];
  let compactions = 0;
  let finalAnswerOnly = false;
  const headers = {Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json'};
  if (provider.appUrl) headers['HTTP-Referer'] = provider.appUrl;
  if (provider.appName) headers['X-Title'] = provider.appName;
  while (rounds < maxModelRounds && Date.now() < deadline) {
    if (!await permitted()) return done({cancelled: true});
    const finalOnly = finalAnswerOnly || rounds >= maxModelRounds - 1 || calls >= maxToolCalls ||
      (compactions >= MAX_CONTEXT_COMPACTIONS && Math.ceil(JSON.stringify(messages).length / 4) >= COMPACT_AFTER_INPUT_TOKENS) || Date.now() > deadline - 10000;
    rounds++;
    if (rounds > 1 && onRound) await Promise.resolve(onRound(rounds)).catch(() => {});
    if (!await permitted()) return done({cancelled: true});
    if (Date.now() >= deadline) return done();
    let data;
    try {
      const response = await fetch(provider.endpoint, {method: 'POST', headers,
        body: JSON.stringify({model: provider.model, messages, tools: definitions, tool_choice: finalOnly ? 'none' : 'auto', max_tokens: maxOutputTokens}),
        signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(Math.max(1, Math.min(150000, deadline - Date.now())))]) : AbortSignal.timeout(Math.max(1, Math.min(150000, deadline - Date.now())))});
      if (!response.ok) return signal?.aborted?done({cancelled:true}):done({refused: !called, status: response.status});
      data = await response.json();
    } catch { return signal?.aborted?done({cancelled:true}):done(); }
    called = true;
    noteUsage(provider, 'agent', data, usageContext);
    if (!await permitted()) return done({cancelled: true});
    const contextTokens = Math.max(Number(data?.usage?.prompt_tokens || 0), Math.ceil(JSON.stringify(messages).length / 4));
    const message = data?.choices?.[0]?.message;
    const pending = message?.tool_calls;
    if (!Array.isArray(pending) || !pending.length) return done({answer: typeof message?.content === 'string' && message.content.trim() ? message.content : null});
    // Validate the entire envelope before any side effect. A duplicate ID in
    // one response or an altered replay must not execute a partial batch.
    if (finalOnly || pending.length > 32 || pending.some(call => !call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || new Set(pending.map(call => call.id)).size !== pending.length) return done();
    const signature = call => JSON.stringify([call.function.name, call.function.arguments]);
    if (pending.some(call => receipts.has(call.id) && receipts.get(call.id).signature !== signature(call))) return done();
    const contextExceeded = contextTokens >= COMPACT_AFTER_INPUT_TOKENS;
    if (contextExceeded && compactions >= MAX_CONTEXT_COMPACTIONS) {
      messages.push({...message, role: 'assistant'});
      for (const call of pending) messages.push({role: 'tool', tool_call_id: call.id, content: 'The context checkpoint limit has been reached. Do not run more tools; answer from the completed evidence already provided.'});
      finalAnswerOnly = true;
      continue;
    }
    // Keep provider reasoning metadata intact for models that require it on
    // the next round. It remains inside this already-authorized model call.
    messages.push({...message, role: 'assistant'});
    const results = new Map();
    const run = async call => {
      if (!await permitted()) return {cancelled: true};
      const prior = receipts.get(call.id);
      if (prior) return {output: prior.output};
      if (calls >= maxToolCalls || Date.now() >= deadline) return {output: 'Tool budget spent. Answer from the results already available.'};
      calls++;
      let replayArgs;
      try { replayArgs = JSON.parse(call.function.arguments); } catch { /* normal validation below */ }
      if (compactions > 0 && replayArgs && typeof replayArgs === 'object' && !Array.isArray(replayArgs)) {
        const canonicalArgs = JSON.stringify(replayArgs);
        const repeated = completedTools.find(item => item.name === call.function.name && item.arguments === canonicalArgs);
        if (repeated) {
          const output = `This exact tool call already completed before the context checkpoint. Saved result: ${repeated.output}`.slice(0, 20000);
          receipts.set(call.id, {signature: signature(call), output});
          return {output};
        }
      }
      let output;
      const tool = Object.hasOwn(tools, call.function.name) ? tools[call.function.name] : null;
      {
        const startedAt = Date.now();
        const traceName = tool ? call.function.name : 'unknown_tool';
        await emitToolEvent(traceName, 'started', 'started', 0);
        let traceStatus = 'completed';
        try {
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
          let value;
          let outputReady = false;
          if (!tool) {
            traceStatus = 'failed';
            output = 'Unknown tool.';
            outputReady = true;
          }
          else {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              traceStatus = 'interrupted';
              await emitToolEvent(traceName, 'finished', traceStatus, Date.now() - startedAt);
              return {interrupted: true};
            }
            const expired = Symbol('tool deadline');
            let timer;
            try {
              // Convert rejection to data before racing it against abort and
              // the deadline. This keeps a late rejected operation observed
              // even when the caller has already stopped waiting for it.
              const operation=Promise.resolve().then(() => tool.run(args,{signal})).then(
                result => ({kind:'value',result}),
                error => ({kind:'error',error}),
              );
              const outcome = await raceSignal(Promise.race([
                operation,
                new Promise(resolve => {timer = setTimeout(() => resolve(expired), remaining);}),
              ]),signal,expired);
              if (outcome?.kind === 'error') {
                traceStatus = 'failed';
                output = `The tool failed: ${String(outcome.error?.message || outcome.error).slice(0, 200)}`;
                outputReady = true;
              } else value = outcome?.kind === 'value' ? outcome.result : outcome;
            } finally {clearTimeout(timer);}
            if(signal?.aborted) {
              traceStatus = 'interrupted';
              await emitToolEvent(traceName, 'finished', traceStatus, Date.now() - startedAt);
              return {cancelled:true};
            }
            // Timeout cannot undo an already-started external operation. Do
            // not execute siblings, retry this tool or infer its outcome.
            if (value === expired || Date.now() >= deadline) {
              traceStatus = 'interrupted';
              await emitToolEvent(traceName, 'finished', traceStatus, Date.now() - startedAt);
              return {interrupted: true};
            }
          }
          if (!outputReady) {
            const operationId = isControlTool(tool) ? handoffOperation(value) : null;
            if (operationId) {
              await emitToolEvent(traceName, 'finished', traceStatus, Date.now() - startedAt);
              return {handedOff: {operationId}};
            }
            output = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
          }
        } catch (error) {
          traceStatus = 'failed';
          output = `The tool failed: ${String(error?.message || error).slice(0, 200)}`;
        }
        await emitToolEvent(traceName, 'finished', traceStatus, Date.now() - startedAt);
      }
      output = output.slice(0, 20000);
      receipts.set(call.id, {signature: signature(call), output});
      return {output};
    };
    // Ownership transfer always precedes ordinary siblings and terminates
    // the loop through the same private runtime signal as Responses runs.
    const ordered = [...pending.filter(call => isControlTool(tools[call.function.name])), ...pending.filter(call => !isControlTool(tools[call.function.name]))];
    for (const call of ordered) {
      const result = await run(call);
      if (result.cancelled || result.handedOff || result.interrupted) return done(result);
      results.set(call.id, result.output);
    }
    if (!await permitted()) return done({cancelled: true});
    for (const call of pending) {
      const output = results.get(call.id);
      messages.push({role: 'tool', tool_call_id: call.id, content: output});
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* preserve raw args as a distinct call */ }
      const canonicalArgs = JSON.stringify(args);
      if (!completedTools.some(item => item.name === call.function.name && item.arguments === canonicalArgs)) {
        completedTools.push({name: call.function.name, arguments: canonicalArgs, output});
      }
    }
    const shouldCompact = Math.max(contextTokens, Math.ceil(JSON.stringify(messages).length / 4)) >= COMPACT_AFTER_INPUT_TOKENS;
    if (shouldCompact && compactions < MAX_CONTEXT_COMPACTIONS) {
      compactions += 1;
      const lastNote = typeof message.content === 'string' ? message.content : '';
      messages.splice(0, messages.length,
        {role: 'system', content: instructions},
        {role: 'user', content: contextCheckpoint(input, completedTools, lastNote)},
      );
    }
  }
  return done();
}
