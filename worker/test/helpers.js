import { SELF } from "cloudflare:test";

// Relay tests used to sleep a fixed number of milliseconds between sending a
// message and asserting on its effect. That works on a quiet laptop and fails on
// a loaded CI runner, which is the worst kind of test: it passes where you are
// looking and fails where you are not.
//
// Nothing here waits on a duration. Everything waits on the thing it actually
// needs to have happened.

export function open(orgId) {
  return SELF.fetch(`https://example.com/?orgId=${encodeURIComponent(orgId)}`, {
    headers: { Upgrade: "websocket" },
  }).then((res) => {
    const ws = res.webSocket;
    ws.accept();
    return ws;
  });
}

export function collect(ws) {
  const messages = [];
  ws.addEventListener("message", (e) => {
    try {
      messages.push(JSON.parse(e.data));
    } catch {
      // A frame we cannot parse is not a frame a test asserts on.
    }
  });
  return messages;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

/// Poll until `check` returns something truthy, or give up.
///
/// Counted in attempts rather than against a deadline: workerd freezes the clock
/// between I/O operations, so `Date.now()` is not a reliable stopwatch inside a
/// test. 150 × 20ms is three seconds, far longer than any of these need and far
/// shorter than a CI timeout.
export async function until(check, attempts = 150) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await tick();
  }
  return null;
}

/// A socket that has finished joining.
///
/// The snapshot is the relay's acknowledgement — it is sent once the session has
/// been resolved and the org authorized, and nothing this socket sends before it
/// arrives would be accepted. Waiting for it is the difference between a test
/// that is slow and one that is wrong.
export async function joined(orgId, sessionToken) {
  const ws = await open(orgId);
  const messages = collect(ws);
  ws.send(JSON.stringify({ type: "join", payload: { sessionToken, protocol: "agui/1" } }));
  const ready = await until(async () => messages.some((m) => m.type === "STATE_SNAPSHOT"));
  if (!ready) {
    const refusal = messages.find((m) => m.type === "RUN_ERROR" || m.type === "error");
    throw new Error(`join never completed${refusal ? `: ${refusal.message || refusal.payload?.message}` : ""}`);
  }
  return { ws, messages };
}

/// Wait for a message matching `predicate`, and return it.
///
/// `attempts` is worth lowering when the *speed* of the arrival is the property
/// under test rather than the arrival itself — a generous budget would let a
/// broadcast that is blocked on something slow still pass.
export function message(messages, predicate, attempts) {
  return until(async () => messages.find(predicate), attempts);
}

/// Wait for a message whose serialized form contains `needle`.
export function messageContaining(messages, needle, attempts) {
  return message(messages, (m) => JSON.stringify(m).includes(needle), attempts);
}

/// Wait for something that signals completion by not throwing.
export function untilNoThrow(fn, attempts) {
  return until(async () => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }, attempts);
}
