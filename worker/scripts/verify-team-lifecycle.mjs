// Creates disposable ordinary accounts through the public API, then deletes
// only those accounts. No database seeding or privileged session is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.QA_API_URL;
if (!base) throw new Error("Set QA_API_URL to the deployment to verify.");
const accounts = [];
const sockets = [];
const run = randomUUID();
async function api(path, body, token, method = "POST") {
  const response = await fetch(new URL(path, base), {
    method, signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", ...(token ? { "x-session-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, `${method} ${path} returned ${response.status}`);
  return response.json();
}
async function account(label) {
  const credentials = { email: `product-qa-${run}-${label}@example.invalid`, password: randomUUID(), name: `Product QA ${label}` };
  const value = await api("/auth/signup", credentials);
  const result = { ...value, credentials };
  accounts.push(result);
  await api("/me", { notifyEmail: false }, value.token, "PUT");
  return result;
}
async function connect(orgId, token) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orgId", orgId);
  const socket = new WebSocket(url);
  sockets.push(socket);
  const events = [];
  socket.addEventListener("message", ({ data }) => events.push(JSON.parse(data)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket open timed out")), 20000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Socket failed")); }, { once: true });
  });
  socket.send(JSON.stringify({ type: "join", payload: { protocol: "agui/1", sessionToken: token } }));
  await wait(events, (e) => e.type === "STATE_SNAPSHOT");
  return { socket, events };
}
async function wait(events, predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === "RUN_ERROR")) throw new Error("Relay rejected operation");
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Expected relay event timed out");
}
try {
  const owner = await account("owner");
  const member = await account("member");
  const invite = await api("/invites/create", { orgId: owner.orgId }, owner.token);
  assert.equal((await api("/invites/accept", { code: invite.code }, member.token)).orgId, owner.orgId);
  const identity = await api("/me", null, member.token, "GET");
  assert.equal(identity.orgId, owner.orgId, "Saved sessions must recover the joined team");
  assert.equal(identity.userId, member.userId);
  console.log("PASS saved-session identity and workspace recovery");
  const team = await api(`/members?orgId=${encodeURIComponent(owner.orgId)}`, null, owner.token, "GET");
  assert.equal(team.members.length, 2);
  console.log("PASS normal registration, invitation, and member directory");
  const sender = await connect(owner.orgId, owner.token);
  const receiver = await connect(owner.orgId, member.token);
  const draft = await api("/ai/route", { orgId: owner.orgId, recipientUserID: member.login,
    text: "Please approve the product QA release checklist.", sender: { id: owner.login, name: "Product QA owner" } }, owner.token);
  assert.equal(draft.recipientUserID, member.login);
  console.log(`PASS request routing (${draft.routedBy || "provider not specified"})`);
  const id = `product-qa-${run}`;
  const card = { id, type: "approval", title: "Product QA approval", summary: "Disposable functional verification",
    recipientUserID: member.login, senderUserID: owner.login, status: "pending", priority: "medium", createdAt: new Date().toISOString() };
  sender.socket.send(JSON.stringify({ type: "card_created", payload: { card } }));
  await wait(receiver.events, (e) => e.type === "STATE_DELTA" && e.delta?.some((d) => d.value?.id === id));
  receiver.socket.send(JSON.stringify({ type: "tool_result", payload: { toolCallId: id,
    content: { cardId: id, action: "approve", note: "Confirmed by second account" } } }));
  await wait(sender.events, (e) => e.type === "STATE_DELTA" && e.delta?.some((d) => d.value?.id === id && d.value.status === "approved"));
  console.log("PASS live delivery and approval reflected to sender");
  const signedIn = await api("/auth/login", member.credentials);
  assert.equal(signedIn.orgId, owner.orgId, "Login must restore the joined team");
  const restored = await connect(signedIn.orgId, signedIn.token);
  const snapshot = restored.events.find((e) => e.type === "STATE_SNAPSHOT");
  assert.ok(JSON.stringify(snapshot).includes(id));
  assert.ok(JSON.stringify(snapshot).includes("approved"));
  console.log("PASS re-login, joined-team recovery, and persisted decision");
} finally {
  for (const socket of sockets) socket.close();
  for (const account of accounts.reverse()) {
    await api("/account", null, account.token, "DELETE");
    const response = await fetch(new URL("/me", base), { signal: AbortSignal.timeout(20000), headers: { "x-session-token": account.token } });
    assert.equal(response.status, 401);
  }
  console.log("PASS disposable account deletion and session revocation");
}
