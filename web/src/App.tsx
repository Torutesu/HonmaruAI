import { useEffect, useRef, useState } from "react";
import { api } from "./core/api";
import { RelaySocket } from "./core/socket";
import { useCardStore } from "./core/stores/cards";
import { applyAppearance, useSessionStore } from "./core/stores/session";
import { FeedScreen } from "./features/feed/FeedScreen";

function relayUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Dev server proxies HTTP but not WS, so talk to the relay directly there.
  const host = import.meta.env.DEV ? "127.0.0.1:8080" : location.host;
  return `${protocol}//${host}`;
}

export function App() {
  const { me, appearance, loading, signedIn, setSession, setLoading } = useSessionStore();
  const applyEvent = useCardStore((state) => state.apply);
  const setConnected = useCardStore((state) => state.setConnected);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<RelaySocket | null>(null);

  useEffect(() => applyAppearance(appearance), [appearance]);

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
        });
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setSession, setLoading]);

  // One socket per identity; the store consumes snapshot + deltas.
  useEffect(() => {
    if (!me?.id) return;

    const socket = new RelaySocket({ url: relayUrl(), userId: me.id });
    socketRef.current = socket;

    const offEvent = socket.onEvent((event) => {
      if (event.type === "error") setError(event.payload.message);
      else applyEvent(event);
    });
    const offStatus = socket.onStatusChange(setConnected);

    socket.connect();
    return () => {
      offEvent();
      offStatus();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [me?.id, applyEvent, setConnected]);

  if (loading) return <Centered>Restoring session…</Centered>;
  if (!signedIn) {
    return (
      <Centered>
        <a href="/auth/github/start">Sign in with GitHub</a>
      </Centered>
    );
  }
  if (!me) return <Centered>Pick your org member to continue.</Centered>;

  return (
    <>
      <FeedScreen />
      {error && <Centered>{error}</Centered>}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        color: "var(--t2)",
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}
