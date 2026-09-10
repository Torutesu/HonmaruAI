// AG-UI event builders (subset used by the relay).
//
// Events follow the AG-UI wire shape: { type, ...payload, timestamp }.
// Types mirror the protocol's standard vocabulary so any AG-UI client
// (CopilotKit on web, a thin Swift decoder on iOS) can consume the stream.

export const EventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  CUSTOM: "CUSTOM",
};

function base(type) {
  return { type, timestamp: Date.now() };
}

export function runStarted(threadId, runId = crypto.randomUUID()) {
  return { ...base(EventType.RUN_STARTED), threadId, runId };
}

export function runFinished(threadId, runId) {
  return { ...base(EventType.RUN_FINISHED), threadId, runId };
}

/// `code` is optional and machine-readable, where `message` is for a person.
///
/// A refusal closes the socket with 1008, and the client has to decide what to
/// do next — find another workspace, sign in again, or simply stop and say so.
/// Deciding that by matching on English prose is how a copy edit becomes a
/// bug, so the reason travels as a token beside it.
export function runError(message, code) {
  return { ...base(EventType.RUN_ERROR), message, ...(code ? { code } : {}) };
}

export function stateSnapshot(snapshot) {
  return { ...base(EventType.STATE_SNAPSHOT), snapshot };
}

// delta: RFC 6902 JSON Patch operations.
export function stateDelta(delta) {
  return { ...base(EventType.STATE_DELTA), delta };
}

export function custom(name, value) {
  return { ...base(EventType.CUSTOM), name, value };
}

export function toolCallResult(toolCallId, content, messageId = crypto.randomUUID()) {
  return {
    ...base(EventType.TOOL_CALL_RESULT),
    toolCallId,
    messageId,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

// A full frontend tool call as the standard three-event sequence.
// Args are streamed as string deltas; we chunk so clients exercise real
// incremental parsing (and so large cards never block the socket).
export function toolCallSequence(toolCallName, args, { chunkSize = 512 } = {}) {
  const toolCallId = crypto.randomUUID();
  const events = [{ ...base(EventType.TOOL_CALL_START), toolCallId, toolCallName }];
  const encoded = JSON.stringify(args);
  for (let i = 0; i < encoded.length; i += chunkSize) {
    events.push({
      ...base(EventType.TOOL_CALL_ARGS),
      toolCallId,
      delta: encoded.slice(i, i + chunkSize),
    });
  }
  events.push({ ...base(EventType.TOOL_CALL_END), toolCallId });
  return { toolCallId, events };
}
