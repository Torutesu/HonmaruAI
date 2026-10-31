// Bounded chat-completion tool loop for scheduled and workflow work.
// All tools are supplied by the server; model arguments never select an identity.
const AUTHORIZATION_POLL_MS = 1000;

async function withAuthorizationFence(authorize, pollMs, timeoutMs, request) {
  if (!authorize) return { value: await request(AbortSignal.timeout(timeoutMs)), revoked: false };
  const controller = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]);
  let stopped = false;
  let revoked = false;
  let timer = null;
  let wake = null;
  const waitForPoll = () => new Promise(resolve => {
    wake = resolve;
    timer = setTimeout(() => { timer = null; wake = null; resolve(); }, pollMs);
  });
  const monitor = (async () => {
    while (!stopped) {
      await waitForPoll();
      if (stopped) return;
      let permitted = false;
      try { permitted = await authorize(); } catch { /* authorization failures close the request */ }
      if (stopped) return;
      if (!permitted) {
        revoked = true;
        controller.abort('authorization changed');
        return;
      }
    }
  })();
  let value;
  let error;
  try { value = await request(signal); } catch (caught) { error = caught; }
  finally {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      wake?.();
      wake = null;
    }
    await monitor;
  }
  if (error && !revoked) throw error;
  return { value, revoked, failed: Boolean(error) };
}

export async function completeWithTools({ provider, system, user, tools = {}, fallbackSystem = system, maxTokens, json, timeoutMs, onUsage, onInterrupted = null, authorize = null, authorizationPollMs = AUTHORIZATION_POLL_MS, requireTool = false, requiredToolNames = [] }) {
  let enabled = Object.keys(tools).length > 0;
  const requiredNames = new Set(requiredToolNames);
  let requiredToolExecuted = false;
  let messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const deadline = Date.now() + timeoutMs;
  let calls = 0;
  const definitions = Object.entries(tools).map(([name, tool]) => ({type:'function',function:{name,description:tool.description,parameters:tool.parameters}}));
  for (let round = 0; round < 5; round++) {
    if (authorize && !await authorize())return null;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const final = round >= 3 || calls >= 12;
    const pollMs = Number.isFinite(authorizationPollMs) ? Math.max(1, Math.min(10000, authorizationPollMs)) : AUTHORIZATION_POLL_MS;
    // Only callers with a durable interrupted-usage sink can abort a
    // dispatched request. Others still recheck authorization after response.
    const outcome = await withAuthorizationFence(onInterrupted ? authorize : null, pollMs, remaining, async signal => {
      const response = await fetch(provider.endpoint, {
        method:'POST',signal,
        headers:{Authorization:`Bearer ${provider.apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:provider.model,temperature:0.2,max_tokens:maxTokens,
          ...(json ? {response_format:{type:'json_object'}} : {}),
          ...(enabled ? {tools:definitions,tool_choice:final?'none':requireTool&&round===0?'required':'auto'} : {}),messages}),
      });
      return { response, data: response.ok ? await response.json() : null };
    });
    if (outcome.revoked) {
      // Keep actual provider usage when the response arrived, otherwise
      // preserve an explicit unknown-usage record for the dispatched call.
      if (outcome.value?.response?.ok) await onUsage(outcome.value.data);
      else await onInterrupted?.();
      return null;
    }
    if (outcome.failed || !outcome.value) return null;
    const { response, data } = outcome.value;
    // Only the initial rejected tool request may retry without tools.
    if (!response.ok) {
      if (round === 0 && enabled && !requireTool && [400,422].includes(response.status)) {
        enabled = false;
        messages = [{role:'system',content:fallbackSystem},{role:'user',content:user}];
        continue;
      }
      return null;
    }
    await onUsage(data);
    if (outcome.revoked || (authorize && !await authorize()))return null;
    const message = data?.choices?.[0]?.message;
    if (!message) return null;
    const pending = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!enabled || !pending.length || final) {
      if (requireTool && (calls === 0 || (requiredNames.size && !requiredToolExecuted))) return null;
      return typeof message.content === 'string' ? message.content : null;
    }
    messages.push({role:'assistant',content:message.content || null,tool_calls:pending});
    for (const call of pending) {
      if (authorize && !await authorize())return null;
      let output = 'Tool unavailable.';
      let executed = false;
      calls += 1;
      if (calls > 12) output = 'Tool budget exhausted. Answer from the information already read.';
      else {
        const tool = tools[call.function?.name];
        try {
          const args = JSON.parse(call.function?.arguments || '{}');
          if (tool && args && typeof args === 'object' && !Array.isArray(args)) {
            const toolRemaining = deadline - Date.now();
            if (toolRemaining <= 0) return null;
            const expired = Symbol('tool deadline');
            let timer;
            let value;
            try {
              value = await Promise.race([
                Promise.resolve().then(() => tool.run(args)),
                new Promise(resolve => { timer = setTimeout(() => resolve(expired), toolRemaining); }),
              ]);
            } finally { clearTimeout(timer); }
            // A timeout does not prove the underlying operation stopped. Do
            // not retry it or ask the model to claim an outcome we did not read.
            if (value === expired || Date.now() >= deadline) return null;
            executed = true;
            output = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
          }
        } catch { output = 'Tool could not be read. Do not assume its contents.'; }
      }
      if (executed && requiredNames.has(call.function?.name)) requiredToolExecuted = true;
      messages.push({role:'tool',tool_call_id:call.id,content:output.slice(0,20000)});
    }
  }
  return null;
}
