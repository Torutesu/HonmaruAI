// Run history keeps the configured step template, never its runtime-expanded
// values. In particular, row/message inputs and connection responses stay out
// of this audit trace.
const STEP_FIELDS = {
  post: ['channel', 'text'], agent: ['agentId', 'channel', 'prompt'],
  connection: ['agentId', 'source', 'action', 'serverId', 'toolName', 'query', 'args'],
  add_row: ['tableId'], update_row: ['tableId'],
  approval: ['to', 'title', 'summary'],
  followup: ['channel', 'agentId', 'text', 'minutes'],
  code: ['gatewayId', 'sourceAppId', 'sourceEntityId', 'sourceTableId', 'sourceTables'],
};
const SECRET_KEY = /(?:pass(?:word)?|secret|token|authorization|api[_-]?key|credential|private[_-]?key)/i;
const PRIVATE_KEY = /^(?:row|records?|messages?|response|output|body|input|result|data)$/i;
const MAX_STEP_BYTES = 1200;
export const MAX_RUN_PREVIEW_BYTES = 8000;

function boundedString(value, max = 320) {
  return String(value).slice(0, max)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED]');
}

function safeValue(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (PRIVATE_KEY.test(key)) return '[OMITTED: runtime data]';
  if (depth > 4) return '[OMITTED: depth limit]';
  if (typeof value === 'string') return boundedString(value);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(item => safeValue(item, '', depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  for (const [childKey, child] of Object.entries(value).slice(0, 24)) {
    const safe = safeValue(child, childKey, depth + 1);
    if (safe !== undefined) out[boundedString(childKey, 80)] = safe;
  }
  return out;
}

export function workflowStepInputPreview(step, remainingBytes = MAX_RUN_PREVIEW_BYTES) {
  if (!step || typeof step !== 'object') return null;
  const fields = STEP_FIELDS[step.type] || [];
  const input = {};
  for (const key of fields) {
    if (key === 'code' || step[key] === undefined) continue;
    input[key] = safeValue(step[key], key);
  }
  const preview = { mode: 'template', input, note: 'Runtime record, message, and connection values are not retained.' };
  const encoded = JSON.stringify(preview);
  const cap = Math.max(0, Math.min(MAX_STEP_BYTES, remainingBytes));
  if (new TextEncoder().encode(encoded).length <= cap) return preview;
  return { mode: 'template', omitted: true, reason: remainingBytes < MAX_STEP_BYTES ? 'run_limit' : 'step_limit' };
}

export function workflowPreviewBytes(entries) {
  return new TextEncoder().encode(JSON.stringify(entries.filter(entry => entry?.inputPreview))).length;
}

export function publicWorkflowInputPreview(value) {
  if (!value || value.mode !== 'template') return null;
  if (value.omitted === true) return { mode: 'template', omitted: true,
    reason: ['run_limit', 'step_limit'].includes(value.reason) ? value.reason : 'step_limit' };
  if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) return null;
  const input = safeValue(value.input);
  const preview = { mode: 'template', input, note: 'Runtime record, message, and connection values are not retained.' };
  return new TextEncoder().encode(JSON.stringify(preview)).length <= MAX_STEP_BYTES ? preview :
    { mode: 'template', omitted: true, reason: 'step_limit' };
}
