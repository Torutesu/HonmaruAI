import {
  joinEvents, upsertEvents, removeEvents, clearEvents,
  presenceEvents, contextEvents, applyDecision, applyRollback,
} from "./agui/adapter.js";
import { toolCallResult, runError } from "./agui/events.js";
import {
  loadStore, saveCard, removeCard, clearCards, loadContexts, saveContext,
} from "./db.js";

export class OrgRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.DB;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") || "core-team";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server); // hibernation API
    server.serializeAttachment({ orgId, userId: null, agui: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(orgId, obj, exclude) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && ws !== exclude) ws.send(text);
    }
  }

  sendTo(orgId, userId, obj) {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.orgId === orgId && att?.userId === userId) ws.send(text);
    }
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const orgId = att.orgId || "core-team";
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    try {
    if (type === "join") {
      const userId = payload.userId;
      const agui = payload.protocol === "agui/1";
      ws.serializeAttachment({ orgId, userId, agui });
      const store = await loadStore(this.db, orgId);
      const contexts = await loadContexts(this.db, orgId);
      if (agui) {
        for (const ev of joinEvents(userId, store, contexts)) ws.send(JSON.stringify(ev));
      } else {
        ws.send(JSON.stringify({ type: "snapshot", payload: { cardsByUser: store } }));
      }
      this.broadcast(orgId, { type: "presence", payload: { userId, status: "online" } }, ws);
      for (const ev of presenceEvents(userId, "online")) this.broadcast(orgId, ev, ws);
      return;
    }

    if (type === "tool_result") {
      const content = typeof payload.content === "string" ? JSON.parse(payload.content) : payload.content;
      await this.applyAndPublish(orgId, content, payload.toolCallId);
      return;
    }

    if (type === "card_created" || type === "card_updated") {
      if (!payload.card?.id) return;
      const card = payload.card;
      await saveCard(this.db, orgId, card);
      const { forEveryone, forRecipient } = upsertEvents(card, { isNew: type === "card_created" });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      for (const ev of forRecipient) this.sendTo(orgId, card.recipientUserID, ev);
      return;
    }

    if (type === "card_deleted") {
      if (!payload.cardId) return;
      await removeCard(this.db, orgId, payload.cardId);
      for (const ev of removeEvents(payload.cardId)) this.broadcast(orgId, ev);
      return;
    }

    if (type === "context_updated") {
      const userId = payload.userId || att.userId;
      const existing = await loadContexts(this.db, orgId);
      const isNew = !(userId in existing);
      await saveContext(this.db, orgId, userId, payload.context);
      for (const ev of contextEvents(userId, payload.context, { isNew })) this.broadcast(orgId, ev);
      return;
    }

    if (type === "rollback") {
      const store = await loadStore(this.db, orgId);
      const { card, notice } = applyRollback(store, payload.cardId, att.userId);
      await saveCard(this.db, orgId, card);
      this.broadcast(orgId, notice);
      const { forEveryone } = upsertEvents(card, { isNew: false });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
      return;
    }

    if (type === "clear_store") {
      await clearCards(this.db, orgId);
      for (const ev of clearEvents()) this.broadcast(orgId, ev);
      return;
    }
    } catch (err) {
      try { ws.send(JSON.stringify(runError(err.message))); } catch {}
    }
  }

  async applyAndPublish(orgId, content, toolCallId) {
    const store = await loadStore(this.db, orgId);
    const out = applyDecision(store, content);
    if (out.removed) {
      await removeCard(this.db, orgId, out.card.id);
      for (const ev of removeEvents(out.card.id)) this.broadcast(orgId, ev);
    } else if (!out.unchanged) {
      await saveCard(this.db, orgId, out.card);
      const { forEveryone } = upsertEvents(out.card, { isNew: false });
      for (const ev of forEveryone) this.broadcast(orgId, ev);
    }
    if (toolCallId) this.broadcast(orgId, toolCallResult(toolCallId, out.card));
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.userId) {
      for (const ev of presenceEvents(att.userId, "offline")) this.broadcast(att.orgId, ev, ws);
    }
  }

  webSocketError(ws, err) {
    console.error("ws error", err);
  }
}
