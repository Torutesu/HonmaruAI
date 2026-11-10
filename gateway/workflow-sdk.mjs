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

export function workflowSdkSource(bridgeExpression = 'undefined') {
  return `const parallel=${parallel.toString()};\nconst pipeline=${pipeline.toString()};\nconst normalizeWorkflowDraft=${normalizeWorkflowDraft.toString()};\nconst workflowBridge=()=>${bridgeExpression};\nexport async function sendMessage(text,options={}){const draft=normalizeWorkflowDraft(text,options);const bridge=workflowBridge();if(typeof bridge?.stageMessage!==\"function\")throw Error(\"Workflow message staging is unavailable.\");return bridge.stageMessage(draft)}\nexport {parallel,pipeline};`;
}
