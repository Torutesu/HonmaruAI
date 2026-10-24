import {noteUsage} from './ledger.js';
import {isControlTool, handoffOperation} from './agentToolControl.js';

// OpenRouter's normalized function-calling protocol. Only Harness callers
// opt in; the configured model/key stay unchanged. No hosted/paid tools are
// provisioned here, and uncertain model/tool calls are never retried.
export function canChatTools(provider) {
  return provider?.providerName === 'OpenRouter' && provider.endpoint === 'https://openrouter.ai/api/v1/chat/completions';
}

export async function chatTools({provider, instructions, input, tools, authorize = null, onRound = null, deadline = Date.now() + 240000}) {
  let called = false, calls = 0, rounds = 0;
  const done = (extra = {}) => ({called, answer: null, calls, rounds, ...extra});
  const permitted = async () => !authorize || await authorize();
  const definitions = Object.entries(tools).map(([name, tool]) => ({type: 'function', function: {name, description: tool.description, parameters: tool.parameters}}));
  const messages = [{role: 'system', content: instructions}, {role: 'user', content: input}];
  const receipts = new Map();
  const headers = {Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json'};
  if (provider.appUrl) headers['HTTP-Referer'] = provider.appUrl;
  if (provider.appName) headers['X-Title'] = provider.appName;
  while (rounds < 9 && Date.now() < deadline) {
    if (!await permitted()) return done({cancelled: true});
    const finalOnly = rounds >= 8 || calls >= 16 || Date.now() > deadline - 10000;
    rounds++;
    if (rounds > 1 && onRound) await Promise.resolve(onRound(rounds)).catch(() => {});
    if (!await permitted()) return done({cancelled: true});
    if (Date.now() >= deadline) return done();
    let data;
    try {
      const response = await fetch(provider.endpoint, {method: 'POST', headers,
        body: JSON.stringify({model: provider.model, messages, tools: definitions, tool_choice: finalOnly ? 'none' : 'auto', max_tokens: 3000}),
        signal: AbortSignal.timeout(Math.max(1, Math.min(150000, deadline - Date.now())))});
      if (!response.ok) return done({refused: !called, status: response.status});
      data = await response.json();
    } catch { return done(); }
    called = true;
    noteUsage(provider, 'agent', data);
    if (!await permitted()) return done({cancelled: true});
    const message = data?.choices?.[0]?.message;
    const pending = message?.tool_calls;
    if (!Array.isArray(pending) || !pending.length) return done({answer: typeof message?.content === 'string' && message.content.trim() ? message.content : null});
    // Validate the entire envelope before any side effect. A duplicate ID in
    // one response or an altered replay must not execute a partial batch.
    if (finalOnly || pending.length > 32 || pending.some(call => !call || call.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || new Set(pending.map(call => call.id)).size !== pending.length) return done();
    const signature = call => JSON.stringify([call.function.name, call.function.arguments]);
    if (pending.some(call => receipts.has(call.id) && receipts.get(call.id).signature !== signature(call))) return done();
    // Keep provider reasoning metadata intact for models that require it on
    // the next round. It remains inside this already-authorized model call.
    messages.push({...message, role: 'assistant'});
    const results = new Map();
    const run = async call => {
      if (!await permitted()) return {cancelled: true};
      const prior = receipts.get(call.id);
      if (prior) return {output: prior.output};
      let output;
      const tool = Object.hasOwn(tools, call.function.name) ? tools[call.function.name] : null;
      if (calls >= 16 || Date.now() >= deadline) output = 'Tool budget spent. Answer from the results already available.';
      else {
        calls++;
        try {
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
          let value;
          if (!tool) value = 'Unknown tool.';
          else {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return {interrupted: true};
            const expired = Symbol('tool deadline');
            let timer;
            try {
              value = await Promise.race([
                Promise.resolve().then(() => tool.run(args)),
                new Promise(resolve => {timer = setTimeout(() => resolve(expired), remaining);}),
              ]);
            } finally {clearTimeout(timer);}
            // Timeout cannot undo an already-started external operation. Do
            // not execute siblings, retry this tool or infer its outcome.
            if (value === expired || Date.now() >= deadline) return {interrupted: true};
          }
          const operationId = isControlTool(tool) ? handoffOperation(value) : null;
          if (operationId) return {handedOff: {operationId}};
          output = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
        } catch (error) { output = `The tool failed: ${String(error?.message || error).slice(0, 200)}`; }
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
    for (const call of pending) messages.push({role: 'tool', tool_call_id: call.id, content: results.get(call.id)});
  }
  return done();
}
