import { listMembers } from "./team.js";
import { resolveChannel, viewOf, postMessage, present, MAX_MESSAGE_CHARS } from "./channels.js";
import { audienceOf as closedAudience, accessFor } from "./access.js";
import { custom as customEvent } from "./agui/events.js";
import { getUserByGithubId } from "./db.js";
import { serverText } from "./serverCopy.js";
import { emitCall } from "./webhooks.js";
import { noteUsage } from "./ledger.js";
import { safe } from "./log.js";

// A Jam: talking out loud in a channel, the way a huddle is — whoever is in
// the channel can join, hear each other, and leave. The audio goes browser
// to browser (WebRTC, a mesh: everyone connected to everyone); the relay only
// introduces them and passes the offers, answers and candidates between them.
// Who is in which Jam lives on each socket's attachment, so it survives the
// relay hibernating and ends when the socket does. What a Jam was — when it
// began, who took part — is kept in the relay's storage until it ends.
//
// When the Jam is recorded, one browser records everyone and uploads it at
// the end: the server transcribes it, writes notes, posts them in the
// channel, and — for a full recording — keeps the audio for the channel.

export const JAM_TYPES = new Set(["jam_join", "jam_leave", "jam_signal", "jam_mute", "jam_media", "jam_react", "jam_transcript"]);
/// The live transcript a Jam keeps for whoever joins late, in lines.
export const MAX_TRANSCRIPT_LINES = 400;
/// The reactions a Jam passes around: one emoji, short.
const REACTION = /^[\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]{1,12}$/u;
/// full: notes and the audio kept; notes: notes, the audio thrown away; off.
export const JAM_MODES = ["full", "notes", "off"];
/// A mesh sends every voice to every other browser: past this it breaks up.
export const MAX_JAM_PEERS = 8;
/// A recording's upload, at the 24 kbps the browser records at, is about an
/// hour and a half — and the most the transcription takes in one piece.
export const MAX_RECORDING_BYTES = 24 * 1024 * 1024;
export const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]);
/// Signals are many and small — each browser trickles a dozen candidates to
/// each other — so they have their own budget, not the chat one.
export const JAM_SIGNAL_BUDGET = 1500;

const STORE = (orgId, key) => `jam:${orgId}:${key}`;

// Keep concurrent joins to the same channel ordered while one of them is
// rechecking access. Other Jam messages and unrelated channels remain free.
const pendingJoins = new WeakMap();
// Includes authorization reads before a channel lock has been acquired.
const resolvingJoins = new WeakMap();
const joinInvalidations = new WeakMap();
const joinKey = (orgId, channel) => JSON.stringify([orgId, channel]);
const joinEpoch = (relay, key) => joinInvalidations.get(relay)?.get(key) || 0;

// Record evictions even when the joining socket has not attached yet. An
// authorization read already in flight may otherwise complete with stale data.
export function invalidateJamJoins(relay, orgId, channel) {
  const key=joinKey(orgId,channel);
  for(const joining of resolvingJoins.get(relay)?.get(key)||[])if(!joining.locked)joining.cancelled=true;
  if(!pendingJoins.get(relay)?.has(key))return;
  let epochs=joinInvalidations.get(relay);
  if(!epochs){epochs=new Map();joinInvalidations.set(relay,epochs);}
  epochs.set(key,joinEpoch(relay,key)+1);
}
// User-scoped evictions also cover channel aliases (DM/agent display names
// differ from stored keys) and joins still resolving their canonical channel.
export function invalidateJamUserJoins(relay, orgId, login) {
  for(const entries of resolvingJoins.get(relay)?.values()||[])
    for(const joining of entries)if(joining.orgId===orgId && joining.userId===login)joining.cancelled=true;
}
async function lockJoin(relay, key) {
  let locks=pendingJoins.get(relay);
  if(!locks){locks=new Map();pendingJoins.set(relay,locks);}
  const before=locks.get(key)||Promise.resolve();
  let unlock;
  const current=new Promise(resolve=>{unlock=resolve;});
  locks.set(key,current);
  await before;
  return ()=>{if(locks.get(key)===current){locks.delete(key);joinInvalidations.get(relay)?.delete(key);}unlock();};
}

// A restarted Durable Object can inherit an uncommitted socket attachment.
// Only the matching provisional marker may be removed; preserve live peers and
// any newer Jam generation. The caller holds this channel's join lock.
async function discardPendingJoin(relay,orgId,jam) {
  const key=STORE(orgId,jam.key);
  await relay.state.storage.transaction(async tx=>{
    const saved=await tx.get(key), marker=saved?.pendingJoin;
    const id=typeof marker==='string'?marker:marker?.peerId;
    if(!saved||id!==jam.peerId)return;
    const peers=jamPeers(relay.state.getWebSockets(),orgId,jam.key);
    if((typeof marker==='string'||marker.starting)&&!peers.length){await tx.delete(key);return;}
    if(marker.added && !peers.some(peer=>peer.att.userId===marker.login))saved.people=(saved.people||[]).filter(login=>login!==marker.login);
    delete saved.pendingJoin;
    await tx.put(key,saved);
  });
}

function sameResolvedRoom(before,after) {
  if(!after || before.key!==after.key || Boolean(before.private)!==Boolean(after.private))return false;
  const a=before.deliveryBoundary,b=after.deliveryBoundary;
  if(!a && !b)return true;
  return Boolean(a && b && a.businessCreatedAt===b.businessCreatedAt && a.allowVirtual===b.allowVirtual);
}

/// The servers a browser needs to find a way through to the others: STUN
/// always, and TURN — relayed audio, for networks that allow nothing else —
/// when the deployment has it, from Cloudflare's service or a fixed one.
export async function iceServers(env) {
  const servers = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 6 * 3600 }),
      });
      if (res.ok) {
        const data = await res.json();
        const got = data?.iceServers;
        for (const s of Array.isArray(got) ? got : got ? [got] : []) if (s?.urls) servers.push(s);
      }
    } catch (err) {
      console.warn("turn credentials failed", safe(err?.message));
    }
  } else if (env.JAM_TURN_URLS) {
    servers.push({
      urls: String(env.JAM_TURN_URLS).split(",").map((u) => u.trim()).filter(Boolean),
      username: env.JAM_TURN_USERNAME || undefined,
      credential: env.JAM_TURN_CREDENTIAL || undefined,
    });
  }
  return servers;
}

/// The sockets in one Jam, earliest first.
export function jamPeers(sockets, orgId, key, exclude) {
  const out = [];
  for (const ws of sockets) {
    if (ws === exclude) continue;
    if(typeof ws.readyState==='number' && ws.readyState!==1)continue;
    const att = ws.deserializeAttachment?.();
    if (att?.orgId === orgId && att.jam?.key === key && !att.jam.pending) out.push({ ws, att });
  }
  return out.sort((a, b) => String(a.att.jam.since).localeCompare(String(b.att.jam.since)));
}

/// A Jam as the people who can see the channel are told it. The recorder
/// is the earliest in it, when it is recorded at all.
export function jamState(peers, members, meta) {
  const participants = peers.map(({ att }) => {
    const m = members.find((x) => x.login === att.userId);
    return {
      peerId: att.jam.peerId, ref: m?.ref || null, name: m?.name || att.userId, muted: Boolean(att.jam.muted), since: att.jam.since,
      // What this browser is sending besides its voice, so the others can
      // lay out a camera or a shared screen before the picture arrives.
      video: Boolean(att.jam.video), screen: Boolean(att.jam.screen),
      avatarUrl: m?.avatarUrl || null,
    };
  });
  const mode = meta?.mode || peers[0]?.att.jam.mode || "off";
  return {
    active: participants.length > 0,
    participants,
    startedAt: participants.length ? (meta?.startedAt || participants[0].since) : null,
    mode,
    recorderPeerId: participants.length && mode !== "off" ? participants[0].peerId : null,
    // The "started a Jam" message: the Jam's own thread hangs off it.
    messageId: participants.length ? (meta?.messageId || null) : null,
  };
}

/// The people who can see a stored channel key: everyone (null), or the
/// DM's two, a group's people, a private channel's members.
const audienceOf = (relay, orgId, key) => closedAudience(relay.db, orgId, key);

async function announceState(relay, orgId, key, members, exclude) {
  const meta = await relay.state.storage.get(STORE(orgId, key));
  const state = jamState(jamPeers(relay.state.getWebSockets(), orgId, key, exclude), members, meta);
  const logins = await audienceOf(relay, orgId, key);
  if (!logins) {
    relay.broadcast(orgId, customEvent("jam_state", { channel: key, ...state }), exclude);
    return state;
  }
  for (const login of logins) {
    const view = viewOf(key, login, members);
    if (view) relay.sendTo(orgId, login, customEvent("jam_state", { channel: view, ...state }));
  }
  return state;
}

/// Say something in the channel as the AI, and tell whoever can see it.
async function sayInChannel(relay, orgId, key, members, body, parentId = null) {
  const out = await postMessage(relay.db, { orgId, key, authorLogin: null, body, kind: "ai", parentId });
  if (!out.row) return null;
  const logins = await audienceOf(relay, orgId, key);
  if (!logins) {
    const [message] = await present(relay.db, orgId, [out.row], null, key, members);
    relay.broadcast(orgId, customEvent("channel_message", { message }));
    return out.row;
  }
  for (const login of logins) {
    const view = viewOf(key, login, members);
    if (!view) continue;
    const [message] = await present(relay.db, orgId, [out.row], login, view, members);
    relay.sendTo(orgId, login, customEvent("channel_message", { message }));
  }
  return out.row;
}

/// An event for everyone who can see a stored channel key, each in their
/// own terms: `make(view)` builds it for the name they give the channel.
async function tellAudience(relay, orgId, key, members, make, exclude) {
  const logins = await audienceOf(relay, orgId, key);
  if (!logins) { relay.broadcast(orgId, make(key), exclude); return; }
  for (const login of logins) {
    const view = viewOf(key, login, members);
    if (view) relay.sendTo(orgId, login, make(view));
  }
}

/// What was said in a Jam, as one message for its thread.
export function transcriptMessage(locale, lines) {
  const head = `*${serverText(locale, "jam.transcript")}*`;
  const body = lines.map((l) => `${l.name}: ${l.text}`).join("\n");
  const full = `${head}\n${body}`;
  return full.length > MAX_MESSAGE_CHARS ? `${full.slice(0, MAX_MESSAGE_CHARS - 1)}…` : full;
}

async function localeOf(db, githubId) {
  return (await getUserByGithubId(db, githubId).catch(() => null))?.locale || "en";
}

export function minutesBetween(from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60000)) : 1;
}

function namesOf(logins, members) {
  return logins.map((l) => members.find((m) => m.login === l)?.name || l).join(", ");
}

function reply(ws, event) {
  try { ws.send(JSON.stringify(event)); } catch { /* gone */ }
}

/// Out of the Jam this socket is in, if any; the Jam ends with its last.
const leavingPeers = new WeakMap();
export async function leaveJam(relay, ws, att, { closing = false } = {}) {
  const jam = att?.jam;
  if (!jam) return;
  const orgId = att.orgId;
  let current=null;
  try { current=ws.deserializeAttachment?.(); } catch { /* the socket may already be closed */ }
  if(current && current.jam?.peerId!==jam.peerId)return;
  let leaving=leavingPeers.get(ws);
  if(!leaving){leaving=new Set();leavingPeers.set(ws,leaving);}
  if(leaving.has(jam.peerId))return;
  leaving.add(jam.peerId);
  // Detach immediately, even if another join is awaiting TURN credentials.
  // A revoked peer must not continue to receive signals while queued.
  if (!closing) {
    try { ws.serializeAttachment({ ...(current||att), jam: null }); } catch { /* closing anyway */ }
  }
  // A join must finish its authorization and attachment before a last leave
  // can decide whether to end the Jam or delete its metadata.
  const unlock=await lockJoin(relay,joinKey(orgId,jam.key));
  try {
  const members = await listMembers(relay.db, orgId, att.githubId);
  const state = await announceState(relay, orgId, jam.key, members, ws);
  if (state.active) return;
  const meta = await relay.state.storage.get(STORE(orgId, jam.key));
  await relay.state.storage.delete(STORE(orgId, jam.key));
  if (!meta || meta.startedAnnounced===false) return;
  const locale = await localeOf(relay.db, att.githubId);
  const minutes = minutesBetween(meta.startedAt, new Date().toISOString());
  // What was said, kept under the Jam's own message where it can be read
  // back — the live transcript, as the people in it saw it.
  if (meta.messageId && Array.isArray(meta.transcript) && meta.transcript.length) {
    await sayInChannel(relay, orgId, jam.key, members, transcriptMessage(locale, meta.transcript), meta.messageId).catch(() => null);
  }
  await sayInChannel(relay, orgId, jam.key, members, serverText(locale, "jam.ended", { minutes, people: namesOf(meta.people || [], members) }));
  relay.state.waitUntil(emitCall(relay.env, orgId, jam.key, "call.ended", {
    startedAt: meta.startedAt, endedAt: new Date().toISOString(), minutes,
    participants: (meta.people || []).map((l) => ({ name: members.find((m) => m.login === l)?.name || null })),
  }));
  } finally { unlock();leaving.delete(jam.peerId); }
}

/// The Jams a socket that just joined can see, so its channel headers show
/// who is talking without waiting for the next change.
export async function jamStatesFor(relay, orgId, login, githubId) {
  const keys = new Set();
  for (const ws of relay.state.getWebSockets()) {
    const att = ws.deserializeAttachment?.();
    if (att?.orgId === orgId && att.jam?.key) keys.add(att.jam.key);
  }
  if (!keys.size) return [];
  const members = await listMembers(relay.db, orgId, githubId);
  const access = await accessFor(relay.db, orgId, login);
  const out = [];
  for (const key of keys) {
    const view = viewOf(key, login, members, access);
    if (!view) continue;
    const meta = await relay.state.storage.get(STORE(orgId, key));
    out.push(customEvent("jam_state", { channel: view, ...jamState(jamPeers(relay.state.getWebSockets(), orgId, key), members, meta) }));
  }
  return out;
}

/// One Jam message from a browser. `att` is the socket's attachment, already
/// signed in.
const joiningSockets = new WeakMap();
export function cancelJamSocketJoin(ws) { const joining=joiningSockets.get(ws);if(joining)joining.cancelled=true; }
export async function handleJamMessage(relay, ws, att, type, payload) {
  if(type==='jam_join') {
    if(joiningSockets.has(ws)) {
      reply(ws,customEvent('jam_error',{channel:payload.channel??null,message:'A Jam join is already in progress.'}));
      return;
    }
    const joining={cancelled:false,orgId:att.orgId,userId:att.userId};
    joiningSockets.set(ws,joining);
    // Register before the first membership/channel lookup. Eviction must also
    // cancel a lookup which later returns after the person was re-invited.
    const key=typeof payload.channel==='string'?joinKey(att.orgId,payload.channel):null;
    let registry=resolvingJoins.get(relay),entries;
    if(key){if(!registry){registry=new Map();resolvingJoins.set(relay,registry);}entries=registry.get(key);if(!entries){entries=new Set();registry.set(key,entries);}entries.add(joining);}
    try { return await handleJamMessageInner(relay,ws,att,type,payload,joining); }
    finally {
      if(joiningSockets.get(ws)===joining)joiningSockets.delete(ws);
      if(entries){entries.delete(joining);if(!entries.size)registry.delete(key);}
    }
  }
  if(type==='jam_leave') {
    const joining=joiningSockets.get(ws);
    if(joining)joining.cancelled=true;
  }
  return handleJamMessageInner(relay,ws,att,type,payload,null);
}
async function handleJamMessageInner(relay, ws, att, type, payload, joining) {
  const orgId = att.orgId;
  // A joining socket is not a peer until its current access is rechecked.
  if(att.jam?.pending && type!=='jam_join') {
    // A user may cancel while access or TURN credentials are still loading.
    if(type==='jam_leave')try { ws.serializeAttachment({...att,jam:null}); } catch { /* socket already closed */ }
    return;
  }

  if (type === "jam_signal") {
    const to = typeof payload.to === "string" ? payload.to : "";
    if (!att.jam || !to || !payload.data || typeof payload.data !== "object") return;
    for (const other of relay.state.getWebSockets()) {
      const oatt = other.deserializeAttachment?.();
      if (oatt?.orgId === orgId && oatt.jam?.key === att.jam.key && oatt.jam.peerId === to) {
        relay.constructor.deliver(other, JSON.stringify(customEvent("jam_signal", { from: att.jam.peerId, data: payload.data })));
        return;
      }
    }
    return;
  }

  if (type === "jam_mute") {
    if (!att.jam) return;
    ws.serializeAttachment({ ...att, jam: { ...att.jam, muted: Boolean(payload.muted) } });
    const members = await listMembers(relay.db, orgId, att.githubId);
    await announceState(relay, orgId, att.jam.key, members);
    return;
  }

  if (type === "jam_leave") {
    await leaveJam(relay, ws, att);
    return;
  }

  // A camera switched on or off, a screen shared or not.
  if (type === "jam_media") {
    if (!att.jam) return;
    ws.serializeAttachment({ ...att, jam: { ...att.jam, video: Boolean(payload.video), screen: Boolean(payload.screen) } });
    const members = await listMembers(relay.db, orgId, att.githubId);
    await announceState(relay, orgId, att.jam.key, members);
    return;
  }

  // A reaction, floated over everyone's screen for a moment.
  if (type === "jam_react") {
    const emoji = typeof payload.emoji === "string" ? payload.emoji.trim() : "";
    if (!att.jam || !REACTION.test(emoji)) return;
    const members = await listMembers(relay.db, orgId, att.githubId);
    const name = members.find((m) => m.login === att.userId)?.name || "";
    await tellAudience(relay, orgId, att.jam.key, members, (view) => customEvent("jam_reaction", { channel: view, peerId: att.jam.peerId, name, emoji, at: new Date().toISOString() }));
    return;
  }

  // A line of what someone said, from their own browser's speech
  // recognition: shown live to everyone, and — once final — kept for
  // whoever joins late and for the thread when the Jam ends.
  if (type === "jam_transcript") {
    const text = typeof payload.text === "string" ? payload.text.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    if (!att.jam || !text) return;
    const members = await listMembers(relay.db, orgId, att.githubId);
    const me = members.find((m) => m.login === att.userId);
    const at = new Date().toISOString();
    const final = payload.final === true;
    if (final) {
      const storeKey = STORE(orgId, att.jam.key);
      const meta = await relay.state.storage.get(storeKey);
      if (meta) {
        meta.transcript = [...(meta.transcript || []), { at, name: me?.name || "", ref: me?.ref || null, text }].slice(-MAX_TRANSCRIPT_LINES);
        await relay.state.storage.put(storeKey, meta);
      }
    }
    await tellAudience(relay, orgId, att.jam.key, members, (view) => customEvent("jam_transcript", {
      channel: view, peerId: att.jam.peerId, ref: me?.ref || null, name: me?.name || "", text, final, at,
    }));
    return;
  }

  if (type === "jam_join") {
    const members = await listMembers(relay.db, orgId, att.githubId);
    const resolved = await resolveChannel(relay.db, orgId, { login: att.userId, github_id: att.githubId }, payload.channel, members);
    const refuse = (message) => reply(ws, customEvent("jam_error", { channel: payload.channel ?? null, message }));
    if (!resolved) return refuse("No such channel.");
    // Leave the previous channel before locking the next one. Holding the next
    // lock while waiting for the previous one would deadlock cross-room swaps.
    att=ws.deserializeAttachment()||att;
    if(joining.cancelled || (typeof ws.readyState==='number' && ws.readyState!==1))return;
    if(att.jam?.pending) {
      const abandoned=att.jam;
      const unlockAbandoned=await lockJoin(relay,joinKey(orgId,abandoned.key));
      try {
        const current=ws.deserializeAttachment()||att;
        if(current.jam?.peerId===abandoned.peerId && current.jam.pending){
          ws.serializeAttachment({...current,jam:null});
          await discardPendingJoin(relay,orgId,abandoned);
        }
      } finally { unlockAbandoned(); }
      att=ws.deserializeAttachment()||att;
    }
    if(joining.cancelled || (typeof ws.readyState==='number' && ws.readyState!==1))return;
    if(att.jam?.key===resolved.key)return;
    if(att.jam) {
      await leaveJam(relay,ws,att);
      att=ws.deserializeAttachment()||att;
    }
    if(joining.cancelled)return;
    const key=joinKey(orgId,resolved.key);
    joining.locked=true;
    const locked=lockJoin(relay,key);
    const epoch=joinEpoch(relay,key);
    const unlock=await locked;
    try {
    // A prior join on this same socket can have finished while we waited.
    att=ws.deserializeAttachment()||att;
    if(joining.cancelled || (typeof ws.readyState==='number' && ws.readyState!==1))return;
    if (att.jam) return; // another event changed this socket while waiting
    if(joining.cancelled)return;
    const peers = jamPeers(relay.state.getWebSockets(), orgId, resolved.key, ws);
    if (peers.length >= MAX_JAM_PEERS) return refuse(`A Jam holds ${MAX_JAM_PEERS} people.`);
    const now = new Date().toISOString();
    const storeKey = STORE(orgId, resolved.key);
    let meta = peers.length ? await relay.state.storage.get(storeKey) : null;
    // The previous object may have stopped while another socket was pending.
    // Resolve its marker before recording a new join, preserving any peer that
    // had already committed and any current Jam/transcript.
    if(meta?.pendingJoin){
      const staleId=typeof meta.pendingJoin==='string'?meta.pendingJoin:meta.pendingJoin.peerId;
      if(staleId){await discardPendingJoin(relay,orgId,{key:resolved.key,peerId:staleId});meta=await relay.state.storage.get(storeKey);}
    }
    const starting = !meta;
    if (!meta) {
      meta = { startedAt: now, startedBy: att.userId, mode: JAM_MODES.includes(payload.mode) ? payload.mode : "notes", people: [], startedAnnounced:false };
    }
    const hadPerson=meta.people.includes(att.userId);
    if (!hadPerson) meta.people.push(att.userId);
    const peerId = crypto.randomUUID();
    meta.pendingJoin={peerId,login:att.userId,added:!hadPerson,starting};
    let committed=false, servers;
    try {
      await relay.state.storage.put(storeKey, meta);
      if(joining.cancelled){await discardPendingJoin(relay,orgId,{key:resolved.key,peerId});return;}
      try { ws.serializeAttachment({ ...att, jam: { key: resolved.key, peerId, muted: Boolean(payload.muted), since: now, mode: meta.mode, pending:true } }); }
      catch { await discardPendingJoin(relay,orgId,{key:resolved.key,peerId}); return; }
      servers=await iceServers(relay.env);
      let verified=null;
      try {
        const currentMembers=await listMembers(relay.db,orgId,att.githubId);
        if(currentMembers.some(member=>String(member.userId)===String(att.githubId)))
          verified=await resolveChannel(relay.db,orgId,{login:att.userId,github_id:att.githubId},payload.channel,currentMembers);
      } catch { /* A failed authorization read must not authorize a join. */ }
      const current=ws.deserializeAttachment();
      const connected=typeof ws.readyState!=='number'||ws.readyState===1;
      if(joining.cancelled || !connected || !current?.jam || current.jam.peerId!==peerId || joinEpoch(relay,key)!==epoch || !sameResolvedRoom(resolved,verified)) {
        if(current?.jam?.peerId===peerId)try { ws.serializeAttachment({...current,jam:null}); } catch { /* closed */ }
        await discardPendingJoin(relay,orgId,{key:resolved.key,peerId});
        if(connected && current?.jam?.peerId===peerId)refuse('Your access to this channel changed.');
        return;
      }
      ws.serializeAttachment({...current,jam:{...current.jam,pending:false}});
      committed=true;
      // A matching marker left by a crash is harmless once the peer is live.
      await relay.state.storage.transaction(async tx=>{const saved=await tx.get(storeKey);if(saved?.pendingJoin?.peerId===peerId){delete saved.pendingJoin;await tx.put(storeKey,saved);}}).catch(()=>{});
    } catch(error) {
      if(!committed){
        try { const current=ws.deserializeAttachment();if(current?.jam?.peerId===peerId)ws.serializeAttachment({...current,jam:null}); } catch { /* closed */ }
        await discardPendingJoin(relay,orgId,{key:resolved.key,peerId}).catch(()=>{});
      }
      throw error;
    }
    const currentPeers=jamPeers(relay.state.getWebSockets(),orgId,resolved.key,ws);
    reply(ws, customEvent("jam_joined", {
      channel: payload.channel,
      peerId,
      peers: currentPeers.map((p) => p.att.jam.peerId),
      iceServers: servers,
      mode: meta.mode,
      startedAt: meta.startedAt,
      messageId: meta.messageId || null,
      // Joined late: what has been said so far.
      transcript: (meta.transcript || []).slice(-200),
    }));
    await announceState(relay, orgId, resolved.key, members);
    if (starting) {
      const name = members.find((m) => m.login === att.userId)?.name || att.userId;
      const locale = await localeOf(relay.db, att.githubId);
      const row = await sayInChannel(relay, orgId, resolved.key, members, serverText(locale, "jam.started", { name }));
      if (row) {
        const kept = await relay.state.storage.get(storeKey);
        if (kept) { kept.messageId = row.id; kept.startedAnnounced=true; await relay.state.storage.put(storeKey, kept); }
        await announceState(relay, orgId, resolved.key, members);
      }
      if(row)relay.state.waitUntil(emitCall(relay.env, orgId, resolved.key, "call.started", { startedAt: meta.startedAt, startedBy: { name } }));
    }
    } finally { unlock(); }
  }
}

// ---- The recording ----

function bareType(header) {
  return String(header || "").split(";")[0].trim().toLowerCase();
}

const EXTENSIONS = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

/// What was said, as text. Only OpenAI's endpoint takes audio; null
/// without it or when it fails.
export async function transcribe(env, provider, bytes, contentType, { locale }) {
  if (!provider || provider.providerName !== "OpenAI") return null;
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), `jam.${EXTENSIONS[contentType] || "webm"}`);
  const model = env.JAM_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
  form.append("model", model);
  form.append("response_format", "json");
  const lang = String(locale || "").split("-")[0];
  if (/^[a-z]{2}$/.test(lang)) form.append("prompt", `A team's conversation. Main language: ${lang}.`);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      signal: AbortSignal.timeout(170_000),
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      console.error("jam transcription refused", res.status);
      return null;
    }
    const data = await res.json();
    const text = String(data?.text || "").trim();
    return text || null;
  } catch (err) {
    console.error("jam transcription failed", safe(err?.message));
    return null;
  }
}

const NOTES_PROMPT = `You take notes of a team's spoken conversation (a transcript, possibly imperfect) for the channel it happened in.
Return JSON: {"notes":"..."}.
- In the reader's language. Plain lines starting with "- ", at most 10: decisions made, who will do what (by name when said), open questions, numbers and dates mentioned.
- Say only what the transcript says. No greetings, no filler, no headings.`;

/// Notes from a transcript, by the model; null when it could not.
export async function jamNotes(provider, transcript, { locale, allowance }) {
  if (!provider || (allowance && !allowance.allowed)) return null;
  try {
    const res = await fetch(provider.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model, temperature: 0.2, max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NOTES_PROMPT },
          { role: "user", content: `Reader language: ${locale}\n<transcript>\n${transcript.slice(0, 60_000)}\n</transcript>` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    noteUsage(provider, "jam_notes", data);
    if (allowance?.metered) await allowance.consume();
    let parsed = null;
    try { parsed = JSON.parse(data?.choices?.[0]?.message?.content || ""); } catch { /* not JSON */ }
    const notes = typeof parsed?.notes === "string" ? parsed.notes.trim() : "";
    return notes || null;
  } catch (err) {
    console.error("jam notes failed", safe(err?.message));
    return null;
  }
}

/// The message a recorded Jam leaves in its channel.
export function recordingMessage(locale, { minutes, people, notes, url }) {
  const lines = [`*${serverText(locale, "jam.notes", { minutes, people })}*`];
  lines.push(notes || serverText(locale, "jam.noNotes"));
  if (url) lines.push("", serverText(locale, "jam.recording", { url }));
  let body = lines.join("\n");
  if (body.length > MAX_MESSAGE_CHARS) {
    const tail = url ? `\n\n${serverText(locale, "jam.recording", { url })}` : "";
    body = `${body.slice(0, MAX_MESSAGE_CHARS - tail.length - 1)}…${tail}`;
  }
  return body;
}

/// The recording's content type, when it is one we take.
export function recordingType(header) {
  const type = bareType(header);
  return AUDIO_TYPES.has(type) ? type : null;
}

/// A kept recording. One kept with its workspace is served only by a signed
/// address (recordingUrl); one from before, by its unguessable id alone,
/// until MEDIA_LEGACY_VIDEO is "off".
export async function serveRecording(env, id, url = null) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("not found", { status: 404 });
  const head = await env.MEDIA.head(`jam/${id}`);
  if (!head) return new Response("not found", { status: 404 });
  const { addressHolds, canSign } = await import("./addressSigning.js");
  // Without a key to sign with (a development Worker), nothing could play.
  const owner = canSign(env) ? head.customMetadata?.orgId : null;
  if (owner) {
    if (!url || !(await addressHolds(env, url, "a1", owner, id))) return new Response("not found", { status: 404 });
  } else if (String(env.MEDIA_LEGACY_VIDEO || "").toLowerCase() === "off") {
    return new Response("This address has been retired.", { status: 410, headers: { "cache-control": "no-store" } });
  }
  const object = await env.MEDIA.get(`jam/${id}`);
  if (!object) return new Response("not found", { status: 404 });
  const stored = bareType(object.httpMetadata?.contentType);
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": AUDIO_TYPES.has(stored) ? stored : "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": owner ? "private, max-age=600" : "private, max-age=86400",
      "access-control-allow-origin": "*",
    },
  });
}

/// A signed address for a recording, for someone who may read the
/// conversation it was posted in; a recording from before, which names no
/// conversation, keeps its bare address. Null when it is not theirs to hear.
export async function recordingUrl(env, { orgId, login, id, origin }) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ""))) return null;
  const head = await env.MEDIA.head(`jam/${id}`);
  if (!head) return null;
  const meta = head.customMetadata || {};
  const bare = `${origin}/channels/jam/audio/${id}`;
  if (meta.orgId && meta.orgId !== orgId) return null;
  const { signedQuery, canSign } = await import("./addressSigning.js");
  if (!meta.orgId || !canSign(env)) return { url: bare, expiresAt: null };
  const { accessFor, mayRead } = await import("./access.js");
  if (!mayRead(meta.channel, await accessFor(env.DB, orgId, login))) return null;
  const signed = await signedQuery(env, "a1", orgId, id);
  return signed ? { url: `${bare}?${signed.query}`, expiresAt: signed.until * 1000 } : null;
}
