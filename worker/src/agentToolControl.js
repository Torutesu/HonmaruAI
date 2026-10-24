// Only runtime-created tools can end a research turn. A model, remote tool
// response or JSON payload cannot forge membership of these private sets.
const controlTools = new WeakSet();
const handoffs = new WeakMap();

export function handoffControl(operationId) {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 100) throw new Error('Invalid handoff operation');
  const signal = Object.freeze({});
  handoffs.set(signal, operationId);
  return signal;
}

export function handoffOperation(value) {
  return value && typeof value === 'object' ? handoffs.get(value) || null : null;
}

export function markControlTool(tool) {
  controlTools.add(tool);
  return tool;
}

export function isControlTool(tool) {
  return Boolean(tool && typeof tool === 'object' && controlTools.has(tool));
}
