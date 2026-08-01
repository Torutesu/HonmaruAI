import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./core/api";
import { setRelaySocket } from "./core/relay";
import { RelaySocket } from "./core/socket";
import { useCardStore } from "./core/stores/cards";
import { useChannelStore } from "./core/stores/channels";
import { applyAppearance, useSessionStore } from "./core/stores/session";
import type { CardSource } from "./core/types";
import { registerServiceWorker } from "./lib/push";
import { useIsDesktop } from "./lib/useMediaQuery";
import { useOfflineCache } from "./lib/useOfflineCache";
import { ConnectionBanner } from "./ui/ConnectionBanner";
import { ChannelsScreen } from "./features/channels/ChannelsScreen";
import { FeedScreen } from "./features/feed/FeedScreen";
import { LedgerScreen } from "./features/ledger/LedgerScreen";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { DocPreview } from "./features/sources/DocPreview";
import { Workbench } from "./features/workbench/Workbench";
import styles from "./App.module.css";

type Tab = "feed" | "channels" | "ledger" | "settings";

function relayUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // The dev server proxies HTTP but not WS, so talk to the relay directly there.
  const host = import.meta.env.DEV ? "127.0.0.1:8080" : location.host;
  return `${protocol}//${host}`;
}

export function App() {
  const { me, appearance, loading, signedIn, setSession, setLoading, setOrganization } =
    useSessionStore();
  const applyCardEvent = useCardStore((state) => state.apply);
  const applyChannelEvent = useChannelStore((state) => state.apply);
  const setConnected = useCardStore((state) => state.setConnected);
  const connected = useCardStore((state) => state.connected);

  const isDesktop = useIsDesktop();
  const restoredAt = useOfflineCache(me?.id ?? null);
  const [tab, setTab] = useState<Tab>("feed");
  const [deepLink, setDeepLink] = useState<{ channelID: string; messageID?: string } | null>(null);
  const [focusCardID, setFocusCardID] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<RelaySocket | null>(null);

  useEffect(() => applyAppearance(appearance), [appearance]);

  // Installable shell + a place for push notifications to land.
  useEffect(() => {
    registerServiceWorker();
  }, []);

  // Notification click → that exact card. Cold start carries ?card=…; a
  // focused tab is told by the service worker.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get("card");
    if (fromUrl) {
      setFocusCardID(fromUrl);
      setTab("feed");
      history.replaceState(null, "", location.pathname);
    }

    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "open-card" && event.data.cardID) {
        setFocusCardID(event.data.cardID);
        setTab("feed");
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Who am I? The session cookie answers; 401 means we need to sign in.
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((response) => {
        if (cancelled) return;
        setSession({
          me: response.user,
          githubLogin: response.githubLogin,
          repository: response.repository,
          users: response.organization.users ?? [],
          organization: {
            nodes: response.organization.nodes,
            edges: response.organization.edges,
          },
          vapidPublicKey: response.push.publicKey,
        });
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setSession, setLoading]);

  // One socket per identity; every store consumes the same event stream.
  useEffect(() => {
    if (!me?.id) return;

    const socket = new RelaySocket({ url: relayUrl(), userId: me.id });
    socketRef.current = socket;
    setRelaySocket(socket);

    const offEvent = socket.onEvent((event) => {
      if (event.type === "error") {
        setError(event.payload.message);
        return;
      }
      if (event.type === "org_updated") {
        setOrganization(event.payload.users, {
          nodes: event.payload.nodes,
          edges: event.payload.edges,
        });
        return;
      }
      applyCardEvent(event);
      applyChannelEvent(event);
    });
    const offStatus = socket.onStatusChange(setConnected);

    socket.connect();
    return () => {
      offEvent();
      offStatus();
      socket.disconnect();
      socketRef.current = null;
      setRelaySocket(null);
    };
  }, [me?.id, applyCardEvent, applyChannelEvent, setConnected, setOrganization]);

  // A card's channel source opens the conversation at the exact message.
  const openSource = useCallback((source: CardSource) => {
    if (source.url) {
      window.open(source.url, "_blank", "noreferrer");
      return;
    }
    if (source.channelID) {
      setDeepLink({ channelID: source.channelID, messageID: source.messageID });
      setTab("channels");
    }
  }, []);

  if (loading) return <div className={styles.centered}>Restoring session…</div>;

  if (!signedIn) {
    return (
      <div className={styles.centered}>
        <p>Decisions, not messages.</p>
        <a className={styles.signIn} href="/auth/github/start">
          Sign in with GitHub
        </a>
      </div>
    );
  }

  if (!me) {
    return (
      <div className={styles.centered}>
        <p>Your GitHub account isn't linked to an org member yet.</p>
        <p>Ask an admin to add you, or pick a member in Settings.</p>
      </div>
    );
  }

  // Same stores, same relay socket — only the surface changes with the room
  // the browser gives us.
  if (isDesktop) {
    return (
      <>
        <ConnectionBanner connected={connected} restoredAt={restoredAt} />
        <DocPreview />
        <Workbench
          connected={connected}
          focusCardID={focusCardID}
          onFocusHandled={() => setFocusCardID(null)}
        />
        {error && (
          <div className={styles.errorBar} role="alert">
            {error}
            <button onClick={() => setError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className={styles.shell}>
      <ConnectionBanner connected={connected} restoredAt={restoredAt} />
      <DocPreview />
      <nav className={styles.nav}>
        <button className={styles.user}>
          <span className={`${styles.dot} ${connected ? styles.dotOnline : ""}`} />
          {me.name}
        </button>
        <div className={styles.tabs}>
          {(["feed", "channels", "ledger", "settings"] as Tab[]).map((id) => (
            <button
              key={id}
              className={`${styles.tab} ${tab === id ? styles.tabActive : ""}`}
              aria-current={tab === id}
              onClick={() => {
                setTab(id);
                if (id !== "channels") setDeepLink(null);
              }}
            >
              {id === "feed"
                ? "Feed"
                : id === "channels"
                  ? "Channels"
                  : id === "ledger"
                    ? "History"
                    : "⚙"}
            </button>
          ))}
        </div>
      </nav>

      <div className={styles.body}>
        {tab === "feed" && (
          <FeedScreen
            onOpenSource={openSource}
            focusCardID={focusCardID}
            onFocusHandled={() => setFocusCardID(null)}
          />
        )}
        {tab === "channels" && (
          <ChannelsScreen
            initialChannelID={deepLink?.channelID ?? null}
            highlightMessageID={deepLink?.messageID ?? null}
            onConsumeDeepLink={() => setDeepLink(null)}
          />
        )}
        {tab === "ledger" && <LedgerScreen />}
        {tab === "settings" && <SettingsScreen />}
      </div>

      {error && (
        <div className={styles.errorBar} role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
