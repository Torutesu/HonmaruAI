import type {
  CardMessage,
  Channel,
  ChatMessage,
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

interface Session {
  token: string;
  user: User;
}

const QUICK_REPLIES = ["👍 Got it", "On it — today", "Need more info", "Ship it 🚀"];

type FeedView = "inbox" | "sent" | "watching" | "all";

// --- app state -------------------------------------------------------------

interface AppState {
  self: Member | null;
  org: Org | null;
  members: Member[];
  edges: OrgEdge[];
  cards: Record<string, DecisionCard>;
  messages: Record<string, CardMessage[]>;
  channels: Channel[];
  chatMessages: Record<string, ChatMessage[]>;
  activeChannelId: string | null;
  unseenByChannel: Record<string, number>;
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
  channels: [],
  chatMessages: {},
  activeChannelId: null,
  unseenByChannel: {},
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
  | { kind: "open_channel"; channelId: string; messages: ChatMessage[] }
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
    case "thread": {
      const streamed = state.messages[action.cardId] ?? [];
      const merged = [...action.messages];
      for (const message of streamed) {
        if (!merged.some((m) => m.id === message.id)) merged.push(message);
      }
      merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { ...state, messages: { ...state.messages, [action.cardId]: merged } };
    }
    case "open_channel": {
      const streamed = state.chatMessages[action.channelId] ?? [];
      const merged = [...action.messages];
      for (const message of streamed) {
        if (!merged.some((m) => m.id === message.id)) merged.push(message);
      }
      merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        ...state,
        activeChannelId: action.channelId,
        chatMessages: { ...state.chatMessages, [action.channelId]: merged },
        unseenByChannel: { ...state.unseenByChannel, [action.channelId]: 0 },
      };
    }
    case "server":
      return applyServer(state, action.message, action.selfId);
  }
}

function applyServer(state: AppState, msg: ServerMessage, selfId: string): AppState {
  switch (msg.type) {
    case "welcome":
      return {
        ...state,
        self: msg.self,
        org: msg.org,
        members: msg.members,
        edges: msg.edges,
        channels: msg.channels,
      };
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
        const visible =
          card.recipientUserId === selfId ||
          card.senderUserId === selfId ||
          card.watcherUserIds.includes(selfId);
        const cards = { ...state.cards };
        if (visible) cards[card.id] = card;
        else delete cards[card.id];
        return { ...state, cards };
      }
      if (ev.type === "card_deleted") {
        const cards = { ...state.cards };
        delete cards[ev.payload.cardId];
        return { ...state, cards };
      }
      if (ev.type === "message_created") {
        const { message } = ev.payload;
        const existing = state.messages[message.cardId] ?? [];
        if (existing.some((m) => m.id === message.id)) return state;
        return {
          ...state,
          messages: { ...state.messages, [message.cardId]: [...existing, message] },
        };
      }
      if (ev.type === "channel_created") {
        const channel = ev.payload.channel;
        if (state.channels.some((c) => c.id === channel.id)) return state;
        return { ...state, channels: [...state.channels, channel] };
      }
      if (ev.type === "chat_message_created") {
        const { message } = ev.payload;
        const existing = state.chatMessages[message.channelId] ?? [];
        if (existing.some((m) => m.id === message.id)) return state;
        const unseen =
          message.channelId !== state.activeChannelId && message.authorUserId !== selfId
            ? (state.unseenByChannel[message.channelId] ?? 0) + 1
            : state.unseenByChannel[message.channelId] ?? 0;
        return {
          ...state,
          chatMessages: {
            ...state.chatMessages,
            [message.channelId]: [...existing, message],
          },
          unseenByChannel: { ...state.unseenByChannel, [message.channelId]: unseen },
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
  revised: "Changes requested",
  delegated: "Delegated",
  completed: "Completed",
};

// Highlight @mentions inside message text.
function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@[\p{L}\p{N}_]+)/gu);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@") ? (
          <span key={index} className="mention">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

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
  const [exchanging, setExchanging] = useState(
    () => new URLSearchParams(location.search).has("code") && !session
  );

  // GitHub OAuth callback: ?code= arrives on /auth/github/callback.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("code");
    if (!code || session) return;
    api<Session>("/v1/auth/github/exchange", { body: { code } })
      .then((result) => {
        sessionStorage.setItem("honmaru.session", JSON.stringify(result));
        setSession(result);
      })
      .finally(() => {
        history.replaceState(null, "", "/");
        setExchanging(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (exchanging) {
    return <div className="gate"><div className="muted">Signing in with GitHub…</div></div>;
  }
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
  const [devMode, setDevMode] = useState(true);
  const [github, setGithub] = useState<{ clientId: string; redirectUri: string } | null>(null);

  useEffect(() => {
    api<{ devMode: boolean }>("/health")
      .then((h) => setDevMode(h.devMode))
      .catch(() => {});
    api<{ clientId: string; redirectUri: string }>("/v1/auth/github/config")
      .then(setGithub)
      .catch(() => {});
  }, []);

  const submit = async () => {
    if (!name.trim()) return;
    try {
      const result = await api<Session>("/v1/auth/dev", { body: { name: name.trim() } });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    }
  };
  const githubSignIn = () => {
    if (!github) return;
    const params = new URLSearchParams({
      client_id: github.clientId,
      redirect_uri: github.redirectUri,
    });
    location.href = `https://github.com/login/oauth/authorize?${params}`;
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">HonmaruAI</div>
        <p className="muted">AI-native decision feed</p>
        {github && (
          <button className="primary" onClick={githubSignIn}>
            Sign in with GitHub
          </button>
        )}
        {devMode && (
          <>
            {github && <div className="divider">Or dev sign in</div>}
            <input
              autoFocus
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className={github ? "" : "primary"} onClick={submit}>Continue</button>
          </>
        )}
        {!devMode && !github && (
          <p className="error">
            Sign-in is not configured on this server (enable GitHub OAuth or dev mode).
          </p>
        )}
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
  const [mode, setMode] = useState<"feed" | "chat">("feed");
  const [view, setView] = useState<FeedView>("inbox");
  const [threadCard, setThreadCard] = useState<string | null>(null);
  const [chatThread, setChatThread] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [newChannel, setNewChannel] = useState("");
  const rt = useRef<Realtime | null>(null);
  const selfId = session.user.id;

  useEffect(() => {
    const realtime = new Realtime(session.token, org.id, {
      onMessage: (message) => dispatch({ kind: "server", message, selfId }),
      onStatus: (status) => dispatch({ kind: "status", status }),
    });
    rt.current = realtime;
    realtime.connect();
    api<{ notifications: Notification[]; unreadCount: number }>(
      `/v1/orgs/${org.id}/notifications`,
      { token: session.token }
    ).then((r) => dispatch({ kind: "inbox", notifications: r.notifications, unread: r.unreadCount }));
    return () => realtime.close();
  }, [session, org.id, selfId]);

  const allCards = useMemo(
    () => rankCards(Object.values(state.cards), state.edges),
    [state.cards, state.edges]
  );
  const counts = useMemo(() => {
    const inbox = allCards.filter((c) => c.recipientUserId === selfId && c.status === "pending");
    return { inboxPending: inbox.length };
  }, [allCards, selfId]);

  const feed = useMemo(() => {
    switch (view) {
      case "inbox":
        return allCards.filter((c) => c.recipientUserId === selfId);
      case "sent":
        return allCards.filter((c) => c.senderUserId === selfId);
      case "watching":
        return allCards.filter(
          (c) =>
            c.watcherUserIds.includes(selfId) &&
            c.recipientUserId !== selfId &&
            c.senderUserId !== selfId
        );
      case "all":
        return allCards;
    }
  }, [allCards, view, selfId]);

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

  const openChannel = useCallback(
    async (channelId: string) => {
      setChatThread(null);
      dispatch({ kind: "open_channel", channelId, messages: [] });
      const r = await api<{ messages: ChatMessage[] }>(
        `/v1/channels/${channelId}/messages`,
        { token: session.token }
      );
      dispatch({ kind: "open_channel", channelId, messages: r.messages });
    },
    [session.token]
  );

  const openDmWith = useCallback(
    async (userId: string) => {
      const r = await api<{ channel: Channel }>(`/v1/orgs/${org.id}/dms`, {
        token: session.token,
        body: { userId },
      });
      await openChannel(r.channel.id);
    },
    [org.id, session.token, openChannel]
  );

  const addChannel = async () => {
    const name = newChannel.trim();
    if (!name) return;
    setNewChannel("");
    const r = await api<{ channel: Channel }>(`/v1/orgs/${org.id}/channels`, {
      token: session.token,
      body: { name },
    });
    await openChannel(r.channel.id);
  };

  // Entering chat mode lands in #general.
  useEffect(() => {
    if (mode === "chat" && !state.activeChannelId && state.channels.length > 0) {
      const general =
        state.channels.find((c) => c.kind === "channel" && c.name === "general") ??
        state.channels[0];
      if (general) void openChannel(general.id);
    }
  }, [mode, state.activeChannelId, state.channels, openChannel]);

  const makeInvite = async () => {
    const r = await api<{ code: string }>(`/v1/orgs/${org.id}/invites`, {
      token: session.token,
      body: {},
    });
    setInvite(r.code);
  };

  const signOut = () => {
    sessionStorage.clear();
    location.reload();
  };

  const memberName = (id: string) =>
    state.members.find((m) => m.userId === id)?.name ?? "…";

  const VIEWS: { key: FeedView; label: string; badge?: number }[] = [
    { key: "inbox", label: "Inbox", badge: counts.inboxPending },
    { key: "sent", label: "Sent" },
    { key: "watching", label: "Watching" },
    { key: "all", label: "All" },
  ];

  const activeThread = threadCard ? state.cards[threadCard] : undefined;
  const chatUnseen = Object.values(state.unseenByChannel).reduce((a, b) => a + b, 0);
  const activeChannel = state.channels.find((c) => c.id === state.activeChannelId);
  const activeChannelMessages = activeChannel
    ? state.chatMessages[activeChannel.id] ?? []
    : [];
  const chatThreadParent = chatThread
    ? activeChannelMessages.find((m) => m.id === chatThread)
    : undefined;
  const dmName = (channel: Channel) =>
    memberName(channel.memberUserIds.find((id) => id !== selfId) ?? "");
  const withThread =
    (mode === "feed" && activeThread) || (mode === "chat" && chatThreadParent);

  return (
    <div className={`shell ${withThread ? "with-thread" : ""}`}>
      <aside className="sidebar">
        <div className="side-org">
          <span className={`conn ${state.connection}`} />
          <span className="org-name">{org.name}</span>
        </div>

        <div className="mode-tabs">
          <button
            className={`mode-tab ${mode === "feed" ? "active" : ""}`}
            onClick={() => setMode("feed")}
          >
            ⚡ Feed
          </button>
          <button
            className={`mode-tab ${mode === "chat" ? "active" : ""}`}
            onClick={() => setMode("chat")}
          >
            💬 Chat{chatUnseen > 0 && <span className="nav-badge">{chatUnseen}</span>}
          </button>
        </div>

        {mode === "feed" ? (
          <>
            <nav className="side-nav">
              {VIEWS.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item ${view === item.key ? "active" : ""}`}
                  onClick={() => setView(item.key)}
                >
                  <span>{item.label}</span>
                  {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
                </button>
              ))}
            </nav>

            <div className="side-section">Members</div>
            <div className="side-members">
              {state.members.map((member) => (
                <div key={member.userId} className="member-row">
                  <span className="avatar">{initials(member.name)}</span>
                  <span className="member-name">
                    {member.name}
                    {member.userId === selfId && <span className="you"> (you)</span>}
                  </span>
                  <span
                    className={`presence ${state.online[member.userId] || member.userId === selfId ? "on" : ""}`}
                  />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="side-section">Channels</div>
            <nav className="side-nav">
              {state.channels
                .filter((c) => c.kind === "channel")
                .map((channel) => (
                  <button
                    key={channel.id}
                    className={`nav-item chan-item ${state.activeChannelId === channel.id ? "active" : ""}`}
                    onClick={() => openChannel(channel.id)}
                  >
                    <span># {channel.name}</span>
                    {state.unseenByChannel[channel.id] ? (
                      <span className="nav-badge">{state.unseenByChannel[channel.id]}</span>
                    ) : null}
                  </button>
                ))}
              <div className="new-channel">
                <input
                  placeholder="+ new channel"
                  value={newChannel}
                  onChange={(e) => setNewChannel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addChannel()}
                />
              </div>
            </nav>

            <div className="side-section">Direct messages</div>
            <nav className="side-nav">
              {state.members
                .filter((m) => m.userId !== selfId)
                .map((member) => {
                  const dm = state.channels.find(
                    (c) => c.kind === "dm" && c.memberUserIds.includes(member.userId)
                  );
                  const unseen = dm ? state.unseenByChannel[dm.id] ?? 0 : 0;
                  return (
                    <button
                      key={member.userId}
                      className={`nav-item chan-item ${dm && state.activeChannelId === dm.id ? "active" : ""}`}
                      onClick={() => openDmWith(member.userId)}
                    >
                      <span>
                        <span
                          className={`presence inline ${state.online[member.userId] ? "on" : ""}`}
                        />
                        {member.name}
                      </span>
                      {unseen ? <span className="nav-badge">{unseen}</span> : null}
                    </button>
                  );
                })}
            </nav>
          </>
        )}

        <div className="side-members">
          <button className="side-invite" title="Invite a teammate" onClick={makeInvite}>
            + Invite a teammate
          </button>
          {invite && (
            <div className="invite-strip">
              <code>{invite}</code>
              <button className="icon" onClick={() => setInvite(null)}>✕</button>
            </div>
          )}
        </div>

        <div className="side-footer">
          <span className="avatar me">{initials(session.user.name)}</span>
          <span className="member-name">{session.user.name}</span>
          <button className="icon" title="Sign out" onClick={signOut}>⏻</button>
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          {mode === "feed" ? (
            <>
              <h1>{VIEWS.find((v) => v.key === view)?.label}</h1>
              <span className="muted small">
                {view === "inbox"
                  ? `${counts.inboxPending} to decide`
                  : `${feed.length} cards`}
              </span>
            </>
          ) : (
            <>
              <h1>
                {activeChannel
                  ? activeChannel.kind === "channel"
                    ? `# ${activeChannel.name}`
                    : dmName(activeChannel)
                  : "Chat"}
              </h1>
              <span className="muted small">
                {activeChannel?.kind === "dm"
                  ? state.online[activeChannel.memberUserIds.find((id) => id !== selfId) ?? ""]
                    ? "online"
                    : "offline"
                  : `${state.members.length} members`}
              </span>
              {activeChannel && (
                <button
                  className="mini digest-btn"
                  title="AI digest of this conversation → a card on your feed"
                  onClick={async () => {
                    await api(`/v1/channels/${activeChannel.id}/summarize`, {
                      token: session.token,
                      body: {},
                    });
                    setMode("feed");
                    setView("inbox");
                  }}
                >
                  ✨ Digest
                </button>
              )}
            </>
          )}
          <span className="spacer" />
          <div className="bell-wrap">
            <button
              className="bell icon"
              onClick={() => {
                setShowInbox(!showInbox);
                if (!showInbox) markAllRead();
              }}
            >
              🔔{state.unread > 0 && <span className="badge">{state.unread}</span>}
            </button>
            {showInbox && (
              <div className="inbox-pop">
                {state.notifications.length === 0 && (
                  <div className="muted pad">All caught up.</div>
                )}
                {state.notifications.slice(0, 20).map((n) => (
                  <button
                    key={n.id}
                    className={`ntf ${n.readAt ? "" : "unread"}`}
                    onClick={() => {
                      if (n.channelId) {
                        setMode("chat");
                        void openChannel(n.channelId);
                      } else if (n.cardId && state.cards[n.cardId]) {
                        setMode("feed");
                        openThread(n.cardId);
                      }
                      setShowInbox(false);
                    }}
                  >
                    <span className="t">{n.title}</span>
                    <span className="b">{n.body}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {mode === "feed" ? (
          <>
            <div className="cards">
              {feed.length === 0 && (
                <div className="empty">
                  <p>Nothing here.</p>
                  <p className="muted small">
                    Message your AI below — it routes the right card to the right person.
                  </p>
                </div>
              )}
              {feed.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  selfId={selfId}
                  members={state.members}
                  online={state.online}
                  memberName={memberName}
                  replyCount={(state.messages[card.id] ?? []).length}
                  active={threadCard === card.id}
                  onAction={(action, extra) => rt.current?.cardAction(card.id, action, extra)}
                  onThread={() => openThread(card.id)}
                />
              ))}
            </div>
            <Composer
              members={state.members}
              selfId={selfId}
              onSend={(text) => rt.current?.instruction(text)}
            />
          </>
        ) : (
          <ChatPane
            channel={activeChannel}
            messages={activeChannelMessages}
            selfId={selfId}
            memberName={memberName}
            onSend={(text) =>
              activeChannel && rt.current?.chatMessage(activeChannel.id, text)
            }
            onOpenThread={setChatThread}
            onMakeCard={(text) => {
              rt.current?.instruction(text);
              setMode("feed");
              setView("sent");
            }}
          />
        )}
      </main>

      {mode === "chat" && activeChannel && chatThreadParent && (
        <ChatThreadPanel
          parent={chatThreadParent}
          replies={activeChannelMessages.filter(
            (m) => m.parentMessageId === chatThreadParent.id
          )}
          selfId={selfId}
          memberName={memberName}
          onSend={(text) =>
            rt.current?.chatMessage(activeChannel.id, text, chatThreadParent.id)
          }
          onClose={() => setChatThread(null)}
        />
      )}

      {mode === "feed" && activeThread && (
        <ThreadPanel
          card={activeThread}
          messages={state.messages[activeThread.id] ?? []}
          selfId={selfId}
          members={state.members}
          memberName={memberName}
          onSend={(text) => rt.current?.cardMessage(activeThread.id, text)}
          onClose={() => setThreadCard(null)}
        />
      )}
    </div>
  );
}

function CardRow(props: {
  card: DecisionCard;
  selfId: string;
  members: Member[];
  online: Record<string, boolean>;
  memberName: (id: string) => string;
  replyCount: number;
  active: boolean;
  onAction: (
    action: "approve" | "reject" | "request_revision" | "delegate" | "delete",
    extra?: { note?: string; delegateToUserId?: string }
  ) => void;
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
    <article className={`card ${card.status} ${props.active ? "active" : ""}`}>
      <div className="row meta-row">
        <span className={`chip type-${card.type}`}>{card.type}</span>
        <span className={`chip prio-${card.priority}`}>{card.priority}</span>
        {due && <span className={`chip ${due.overdue ? "overdue" : "due"}`}>{due.text}</span>}
        {card.status !== "pending" && (
          <span className={`chip st-${card.status}`}>{STATUS_LABEL[card.status]}</span>
        )}
        <span className="spacer" />
        <span className="muted small who">
          {props.online[counterpart] && <span className="presence on inline" />}
          {isRecipient ? `from ${memberName(card.senderUserId)}` : `to ${memberName(card.recipientUserId)}`}
          {" · "}
          {ago(card.createdAt)}
        </span>
      </div>
      <button className="card-body" onClick={props.onThread}>
        <h3>{card.title}</h3>
        <p className="sum">{card.summary}</p>
      </button>
      <div className="row foot-row">
        {card.status === "pending" && isRecipient && !revising && !delegating && (
          <>
            <button className="mini approve" onClick={() => props.onAction("approve")}>Approve</button>
            <button className="mini reject" onClick={() => props.onAction("reject")}>Decline</button>
            <button className="mini" onClick={() => setRevising(true)}>Changes</button>
            <button className="mini" onClick={() => setDelegating(true)}>Delegate</button>
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
            <button className="mini" onClick={() => setRevising(false)}>✕</button>
          </div>
        )}
        {delegating && (
          <div className="inline-form wrap">
            {props.members
              .filter((m) => m.userId !== selfId && m.userId !== card.recipientUserId)
              .map((m) => (
                <button
                  key={m.userId}
                  className="mini"
                  onClick={() => {
                    props.onAction("delegate", { delegateToUserId: m.userId });
                    setDelegating(false);
                  }}
                >
                  → {m.name}
                </button>
              ))}
            <button className="mini" onClick={() => setDelegating(false)}>✕</button>
          </div>
        )}
        <button className="mini thread-btn" onClick={props.onThread}>
          💬 {props.replyCount > 0 ? props.replyCount : "Reply"}
        </button>
        {card.status === "rejected" && (
          <button className="mini" onClick={() => props.onAction("delete")}>Remove</button>
        )}
        <span className="spacer" />
        {gh && (
          <span className="gh small">
            {gh.url ? (
              <a href={gh.url} target="_blank" rel="noreferrer">#{gh.externalId}</a>
            ) : (
              `#${gh.externalId}`
            )}
          </span>
        )}
        {card.watcherUserIds.length > 0 && (
          <span className="muted small" title={card.watcherUserIds.map(memberName).join(", ")}>
            👁 {card.watcherUserIds.length}
          </span>
        )}
      </div>
    </article>
  );
}

function ThreadPanel(props: {
  card: DecisionCard;
  messages: CardMessage[];
  selfId: string;
  members: Member[];
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
  const mentionables = props.members.filter((m) => m.userId !== props.selfId);
  return (
    <aside className="thread">
      <div className="thread-head">
        <div>
          <div className="t">{props.card.title}</div>
          <div className="muted small">
            {props.card.agentRoute} · {STATUS_LABEL[props.card.status]}
          </div>
        </div>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <div className="thread-body" ref={bodyRef}>
        <div className="thread-card muted small">
          {props.card.summary}
          <div className="ctx">{props.card.context}</div>
        </div>
        {props.messages.length === 0 && (
          <div className="muted small center">Replies land instantly — no AI in this path.</div>
        )}
        {props.messages.map((m) => (
          <div key={m.id} className={`msg ${m.authorUserId === props.selfId ? "me" : "them"}`}>
            <MentionText text={m.text} />
            <span className="meta">{props.memberName(m.authorUserId)} · {ago(m.createdAt)}</span>
          </div>
        ))}
      </div>
      <div className="quick">
        {QUICK_REPLIES.map((q) => (
          <button key={q} onClick={() => send(q)}>{q}</button>
        ))}
        {mentionables.slice(0, 3).map((m) => (
          <button
            key={m.userId}
            title={`Mention ${m.name} — pulls them into this card`}
            onClick={() => setText((t) => `${t}@${m.name.split(" ")[0]} `)}
          >
            @{m.name.split(" ")[0]}
          </button>
        ))}
      </div>
      <div className="thread-input">
        <input
          autoFocus
          placeholder="Reply… (@name to pull someone in)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(text)}
        />
        <button className="primary send" onClick={() => send(text)}>↑</button>
      </div>
    </aside>
  );
}

function ChatPane(props: {
  channel: Channel | undefined;
  messages: ChatMessage[];
  selfId: string;
  memberName: (id: string) => string;
  onSend: (text: string) => void;
  onOpenThread: (messageId: string) => void;
  onMakeCard: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [props.messages.length, props.channel?.id]);

  const send = () => {
    if (!text.trim()) return;
    props.onSend(text.trim());
    setText("");
  };
  const makeCard = () => {
    if (!text.trim()) return;
    props.onMakeCard(text.trim());
    setText("");
  };

  if (!props.channel) {
    return <div className="chat-body empty"><p className="muted">Pick a channel.</p></div>;
  }

  const topLevel = props.messages.filter((m) => !m.parentMessageId);
  const replyCount = (id: string) =>
    props.messages.filter((m) => m.parentMessageId === id).length;

  return (
    <>
      <div className="chat-body" ref={bodyRef}>
        {topLevel.length === 0 && (
          <div className="muted small center">
            No messages yet. @name mentions notify; DMs always notify.
          </div>
        )}
        {topLevel.map((message, index) => {
          const prev = topLevel[index - 1];
          const grouped =
            prev &&
            prev.authorUserId === message.authorUserId &&
            Date.parse(message.createdAt) - Date.parse(prev.createdAt) < 180_000;
          const replies = replyCount(message.id);
          return (
            <div key={message.id} className={`cmsg ${grouped ? "grouped" : ""}`}>
              {!grouped && (
                <div className="cmsg-head">
                  <span className="avatar">{initials(props.memberName(message.authorUserId))}</span>
                  <span className="cmsg-author">{props.memberName(message.authorUserId)}</span>
                  <span className="muted small">{ago(message.createdAt)}</span>
                </div>
              )}
              <div className="cmsg-text">
                <MentionText text={message.text} />
                <button
                  className="cmsg-thread"
                  onClick={() => props.onOpenThread(message.id)}
                >
                  {replies > 0 ? `↳ ${replies} repl${replies === 1 ? "y" : "ies"}` : "↳ reply"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <footer className="composer chat-composer">
        <input
          placeholder={
            props.channel.kind === "channel"
              ? `Message #${props.channel.name} (@name to mention)`
              : "Message… (@name to mention)"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button
          className="make-card"
          title="Send this to your AI as a decision card instead"
          onClick={makeCard}
        >
          ⚡
        </button>
        <button className="primary send" onClick={send}>↑</button>
      </footer>
    </>
  );
}

function ChatThreadPanel(props: {
  parent: ChatMessage;
  replies: ChatMessage[];
  selfId: string;
  memberName: (id: string) => string;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight);
  }, [props.replies.length]);
  const send = () => {
    if (!text.trim()) return;
    props.onSend(text.trim());
    setText("");
  };
  const bubble = (message: ChatMessage) => (
    <div
      key={message.id}
      className={`msg ${message.authorUserId === props.selfId ? "me" : "them"}`}
    >
      <MentionText text={message.text} />
      <span className="meta">
        {props.memberName(message.authorUserId)} · {ago(message.createdAt)}
      </span>
    </div>
  );
  return (
    <aside className="thread">
      <div className="thread-head">
        <div>
          <div className="t">Thread</div>
          <div className="muted small">
            {props.replies.length} repl{props.replies.length === 1 ? "y" : "ies"}
          </div>
        </div>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <div className="thread-body" ref={bodyRef}>
        <div className="thread-card small">
          <b>{props.memberName(props.parent.authorUserId)}</b>{" "}
          <MentionText text={props.parent.text} />
        </div>
        {props.replies.map(bubble)}
      </div>
      <div className="thread-input">
        <input
          autoFocus
          placeholder="Reply in thread… (@name to mention)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="primary send" onClick={send}>↑</button>
      </div>
    </aside>
  );
}

function Composer({
  members,
  selfId,
  onSend,
}: {
  members: Member[];
  selfId: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  const names = members
    .filter((m) => m.userId !== selfId)
    .map((m) => m.name.split(" ")[0])
    .slice(0, 3)
    .join(", ");
  return (
    <footer className="composer">
      <input
        placeholder={`Message your AI… (e.g. "tell ${names.split(", ")[0] || "Bob"} to fix the login bug asap")`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
      />
      <button className="primary send" onClick={send}>↑</button>
    </footer>
  );
}
