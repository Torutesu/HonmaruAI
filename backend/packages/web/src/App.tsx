import type {
  CardMessage,
  DecisionCard,
  Member,
  Notification,
  Org,
  OrgEdge,
  ServerMessage,
  User,
} from "@honmaru/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { api, rankCards, Realtime } from "./client.js";

// ---------------------------------------------------------------------------
// 仮フロントエンド (deliberately plain): one column, feed-first, wired to the
// real protocol. Visual polish comes later; the flows are the real ones.
// ---------------------------------------------------------------------------

interface Session {
  token: string;
  user: User;
}

const QUICK_REPLIES = ["👍 Got it", "On it — today", "Need more info", "Ship it 🚀"];

// --- app state -------------------------------------------------------------

interface AppState {
  self: Member | null;
  org: Org | null;
  members: Member[];
  edges: OrgEdge[];
  cards: Record<string, DecisionCard>;
  messages: Record<string, CardMessage[]>;
  notifications: Notification[];
  unread: number;
  online: Record<string, boolean>;
  connection: "connecting" | "open" | "closed";
}

const initialState: AppState = {
  self: null,
  org: null,
  members: [],
  edges: [],
  cards: {},
  messages: {},
  notifications: [],
  unread: 0,
  online: {},
  connection: "connecting",
};

type Action =
  | { kind: "server"; message: ServerMessage; selfId: string }
  | { kind: "status"; status: AppState["connection"] }
  | { kind: "inbox"; notifications: Notification[]; unread: number }
  | { kind: "thread"; cardId: string; messages: CardMessage[] }
  | { kind: "read_all" };

function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case "status":
      return { ...state, connection: action.status };
    case "inbox":
      return { ...state, notifications: action.notifications, unread: action.unread };
    case "read_all":
      return {
        ...state,
        unread: 0,
        notifications: state.notifications.map((n) => ({ ...n, readAt: n.readAt ?? "now" })),
      };
    case "thread":
      return { ...state, messages: { ...state.messages, [action.cardId]: action.messages } };
    case "server":
      return applyServer(state, action.message, action.selfId);
  }
}

function applyServer(state: AppState, msg: ServerMessage, selfId: string): AppState {
  switch (msg.type) {
    case "welcome":
      return { ...state, self: msg.self, org: msg.org, members: msg.members, edges: msg.edges };
    case "snapshot": {
      const cards: Record<string, DecisionCard> = {};
      for (const card of msg.cards) cards[card.id] = card;
      return { ...state, cards };
    }
    case "presence":
      return { ...state, online: { ...state.online, [msg.userId]: msg.status === "online" } };
    case "notification":
      return {
        ...state,
        notifications: [msg.notification, ...state.notifications],
        unread: state.unread + 1,
      };
    case "event": {
      const ev = msg.event;
      if (ev.type === "card_created" || ev.type === "card_updated") {
        const card = ev.payload.card;
        const visible = card.recipientUserId === selfId || card.senderUserId === selfId;
        const cards = { ...state.cards };
        if (visible) cards[card.id] = card;
        else delete cards[card.id]; // re-routed away from me
        return { ...state, cards };
      }
      if (ev.type === "card_deleted") {
        const cards = { ...state.cards };
        delete cards[ev.payload.cardId];
        return { ...state, cards };
      }
      if (ev.type === "message_created") {
        const { message } = ev.payload;
        const existing = state.messages[message.cardId];
        if (!existing || existing.some((m) => m.id === message.id)) return state;
        return {
          ...state,
          messages: { ...state.messages, [message.cardId]: [...existing, message] },
        };
      }
      if (ev.type === "member_joined" || ev.type === "member_updated") {
        const member = ev.payload.member;
        const rest = state.members.filter((m) => m.userId !== member.userId);
        return { ...state, members: [...rest, member] };
      }
      if (ev.type === "org_graph_updated") {
        return { ...state, edges: ev.payload.edges };
      }
      return state;
    }
    default:
      return state;
  }
}

// --- helpers ---------------------------------------------------------------

function ago(iso: string): string {
  const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function dueLabel(card: DecisionCard): { text: string; overdue: boolean } | null {
  if (!card.dueAt || card.status !== "pending") return null;
  const ms = Date.parse(card.dueAt) - Date.now();
  if (ms <= 0) return { text: "Overdue", overdue: true };
  const h = ms / 3_600_000;
  return { text: h < 1 ? `due ${Math.ceil(ms / 60000)}m` : `due ${Math.ceil(h)}h`, overdue: false };
}

const STATUS_LABEL: Record<DecisionCard["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Declined",
  revised: "Revision requested",
  delegated: "Delegated",
  completed: "Completed",
};

// --- root ------------------------------------------------------------------

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = sessionStorage.getItem("honmaru.session");
    return raw ? (JSON.parse(raw) as Session) : null;
  });
  const [org, setOrg] = useState<Org | null>(() => {
    const raw = sessionStorage.getItem("honmaru.org");
    return raw ? (JSON.parse(raw) as Org) : null;
  });

  if (!session) {
    return (
      <Login
        onDone={(s) => {
          sessionStorage.setItem("honmaru.session", JSON.stringify(s));
          setSession(s);
        }}
      />
    );
  }
  if (!org) {
    return (
      <OrgGate
        session={session}
        onDone={(o) => {
          sessionStorage.setItem("honmaru.org", JSON.stringify(o));
          setOrg(o);
        }}
      />
    );
  }
  return <Main session={session} org={org} />;
}

function Login({ onDone }: { onDone: (s: Session) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    if (!name.trim()) return;
    try {
      const result = await api<Session>("/v1/auth/dev", { body: { name: name.trim() } });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    }
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">HonmaruAI</div>
        <p className="muted">AI-native decision feed — dev sign in</p>
        <input
          autoFocus
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="primary" onClick={submit}>Continue</button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function OrgGate({ session, onDone }: { session: Session; onDone: (o: Org) => void }) {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ orgs: Org[] }>("/v1/me", { token: session.token })
      .then((r) => setOrgs(r.orgs))
      .catch(() => setOrgs([]));
  }, [session.token]);

  const create = async () => {
    try {
      const r = await api<{ org: Org }>("/v1/orgs", {
        token: session.token,
        body: { name: name || "My Org", title: title || "Founder" },
      });
      onDone(r.org);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  };
  const join = async () => {
    try {
      const r = await api<{ org: Org }>("/v1/invites/accept", {
        token: session.token,
        body: { code: code.trim(), title: title || "Member" },
      });
      onDone(r.org);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid invite code");
    }
  };

  if (orgs === null) return <div className="gate"><div className="muted">Loading…</div></div>;
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">Choose a workspace</div>
        {orgs.map((o) => (
          <button key={o.id} onClick={() => onDone(o)}>{o.name}</button>
        ))}
        <div className="divider">Your role</div>
        <input placeholder="Job title (e.g. Engineer)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="divider">Create new</div>
        <input placeholder="Org name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" onClick={create}>Create org</button>
        <div className="divider">Or join with invite code</div>
        <input placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
        <button onClick={join}>Join</button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

// --- main app --------------------------------------------------------------

function Main({ session, org }: { session: Session; org: Org }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [threadCard, setThreadCard] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const rt = useRef<Realtime | null>(null);

  useEffect(() => {
    const realtime = new Realtime(session.token, org.id, {
      onMessage: (message) => dispatch({ kind: "server", message, selfId: session.user.id }),
      onStatus: (status) => dispatch({ kind: "status", status }),
    });
    rt.current = realtime;
    realtime.connect();
    api<{ notifications: Notification[]; unreadCount: number }>(
      `/v1/orgs/${org.id}/notifications`,
      { token: session.token }
    ).then((r) => dispatch({ kind: "inbox", notifications: r.notifications, unread: r.unreadCount }));
    return () => realtime.close();
  }, [session, org.id]);

  const feed = useMemo(
    () => rankCards(Object.values(state.cards), state.edges),
    [state.cards, state.edges]
  );

  const openThread = useCallback(
    async (cardId: string) => {
      setThreadCard(cardId);
      const r = await api<{ messages: CardMessage[] }>(`/v1/cards/${cardId}/messages`, {
        token: session.token,
      });
      dispatch({ kind: "thread", cardId, messages: r.messages });
    },
    [session.token]
  );

  const markAllRead = async () => {
    dispatch({ kind: "read_all" });
    await api("/v1/notifications/read", { token: session.token, body: { all: true } });
  };

  const makeInvite = async () => {
    const r = await api<{ code: string }>(`/v1/orgs/${org.id}/invites`, {
      token: session.token,
      body: {},
    });
    setInvite(r.code);
  };

  const memberName = (id: string) =>
    state.members.find((m) => m.userId === id)?.name ?? "…";

  return (
    <div className="shell">
      <header className="topbar">
        <div className={`conn ${state.connection}`} title={state.connection} />
        <div className="org-name">{org.name}</div>
        <div className="me">{session.user.name}</div>
        <button className="icon" onClick={makeInvite} title="Invite a teammate">+👤</button>
        <button className="icon bell" onClick={() => { setShowInbox(!showInbox); if (!showInbox) markAllRead(); }}>
          🔔{state.unread > 0 && <span className="badge">{state.unread}</span>}
        </button>
      </header>

      {invite && (
        <div className="invite-strip">
          Invite code: <code>{invite}</code>
          <button className="icon" onClick={() => setInvite(null)}>✕</button>
        </div>
      )}

      {showInbox && (
        <div className="inbox">
          {state.notifications.length === 0 && <div className="muted pad">All caught up.</div>}
          {state.notifications.slice(0, 20).map((n) => (
            <div key={n.id} className={`ntf ${n.readAt ? "" : "unread"}`}>
              <div className="t">{n.title}</div>
              <div className="b">{n.body}</div>
            </div>
          ))}
        </div>
      )}

      <main className="feed">
        {feed.length === 0 && (
          <div className="empty">
            <p>No decisions waiting.</p>
            <p className="muted">Message your AI below — it will route the right card to the right person.</p>
          </div>
        )}
        {feed.map((card) => (
          <Card
            key={card.id}
            card={card}
            selfId={session.user.id}
            members={state.members}
            online={state.online}
            memberName={memberName}
            onAction={(action, extra) => rt.current?.cardAction(card.id, action, extra)}
            onThread={() => openThread(card.id)}
          />
        ))}
      </main>

      {threadCard && state.cards[threadCard] && (
        <Thread
          card={state.cards[threadCard]}
          messages={state.messages[threadCard] ?? []}
          selfId={session.user.id}
          memberName={memberName}
          onSend={(text) => rt.current?.cardMessage(threadCard, text)}
          onClose={() => setThreadCard(null)}
        />
      )}

      <Composer onSend={(text) => rt.current?.instruction(text)} />
    </div>
  );
}

function Card(props: {
  card: DecisionCard;
  selfId: string;
  members: Member[];
  online: Record<string, boolean>;
  memberName: (id: string) => string;
  onAction: (action: "approve" | "reject" | "request_revision" | "delegate" | "delete", extra?: { note?: string; delegateToUserId?: string }) => void;
  onThread: () => void;
}) {
  const { card, selfId, memberName } = props;
  const isRecipient = card.recipientUserId === selfId;
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const [delegating, setDelegating] = useState(false);
  const due = dueLabel(card);
  const gh = card.externalRefs.find((r) => r.integration === "github_issues");
  const counterpart = isRecipient ? card.senderUserId : card.recipientUserId;

  return (
    <article className={`card ${card.status}`}>
      <div className="row">
        <span className={`chip type-${card.type}`}>{card.type}</span>
        <span className={`chip prio-${card.priority}`}>{card.priority}</span>
        {due && <span className={`chip ${due.overdue ? "overdue" : "due"}`}>{due.text}</span>}
        <span className="spacer" />
        <span className="muted small">
          {props.online[counterpart] && <span className="dot on" title="online" />}
          {isRecipient ? `from ${memberName(card.senderUserId)}` : `to ${memberName(card.recipientUserId)}`} · {ago(card.createdAt)}
        </span>
      </div>
      <h3>{card.title}</h3>
      <p className="sum">{card.summary}</p>
      <p className="ctx">{card.context}</p>
      <p className="route">
        {card.agentRoute} · {card.routingReason}
      </p>
      {gh && (
        <p className="gh">
          {gh.url ? <a href={gh.url} target="_blank" rel="noreferrer">Issue #{gh.externalId}</a> : `Issue #${gh.externalId}`}
          {" "}on GitHub · {gh.state}
        </p>
      )}
      {card.status !== "pending" && (
        <div className="row">
          <span className={`chip st-${card.status}`}>{STATUS_LABEL[card.status]}</span>
          {card.revisionNote && <span className="muted small">“{card.revisionNote}”</span>}
        </div>
      )}
      <div className="actions">
        {card.status === "pending" && isRecipient && !revising && !delegating && (
          <>
            <button className="approve" onClick={() => props.onAction("approve")}>Approve</button>
            <button className="reject" onClick={() => props.onAction("reject")}>Decline</button>
            <button onClick={() => setRevising(true)}>Request changes</button>
            <button onClick={() => setDelegating(true)}>Delegate</button>
          </>
        )}
        {revising && (
          <div className="inline-form">
            <input
              autoFocus
              placeholder="What should change?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) {
                  props.onAction("request_revision", { note: note.trim() });
                  setRevising(false);
                }
              }}
            />
            <button onClick={() => setRevising(false)}>✕</button>
          </div>
        )}
        {delegating && (
          <div className="inline-form wrap">
            {props.members
              .filter((m) => m.userId !== selfId && m.userId !== card.recipientUserId)
              .map((m) => (
                <button key={m.userId} onClick={() => { props.onAction("delegate", { delegateToUserId: m.userId }); setDelegating(false); }}>
                  → {m.name}
                </button>
              ))}
            <button onClick={() => setDelegating(false)}>✕</button>
          </div>
        )}
        <button className="thread-btn" onClick={props.onThread}>💬 Thread</button>
        {card.status === "rejected" && (
          <button onClick={() => props.onAction("delete")}>Remove</button>
        )}
      </div>
    </article>
  );
}

function Thread(props: {
  card: DecisionCard;
  messages: CardMessage[];
  selfId: string;
  memberName: (id: string) => string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [props.messages.length]);
  const send = (value: string) => {
    if (!value.trim()) return;
    props.onSend(value.trim());
    setText("");
  };
  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <div className="t">{props.card.title}</div>
          <div className="muted small">Replies land instantly — no AI in this path</div>
        </div>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <div className="sheet-body" ref={bodyRef}>
        {props.messages.length === 0 && <div className="muted pad">Start the rally.</div>}
        {props.messages.map((m) => (
          <div key={m.id} className={`msg ${m.authorUserId === props.selfId ? "me" : "them"}`}>
            {m.text}
            <span className="meta">{props.memberName(m.authorUserId)} · {ago(m.createdAt)}</span>
          </div>
        ))}
      </div>
      <div className="quick">
        {QUICK_REPLIES.map((q) => (
          <button key={q} onClick={() => send(q)}>{q}</button>
        ))}
      </div>
      <div className="sheet-input">
        <input
          autoFocus
          placeholder="Reply…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(text)}
        />
        <button className="primary" onClick={() => send(text)}>↑</button>
      </div>
    </div>
  );
}

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <footer className="composer">
      <input
        placeholder="Message your AI… (e.g. tell Bob to fix the login bug asap)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <button className="primary" onClick={send}>↑</button>
    </footer>
  );
}
