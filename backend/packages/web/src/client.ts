import type {
  CardAction,
  CardPriority,
  DecisionCard,
  Member,
  Notification,
  Org,
  OrgEdge,
  ServerMessage,
  Team,
  User,
} from "@honmaru/protocol";

// Backend origin. Same-origin by default; override for local dev where the
// web app runs on the Vite port and the API on 8081.
export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  (location.port === "5173" || location.port === "4173"
    ? `http://${location.hostname}:8081`
    : location.origin);

const WS_BASE = API_BASE.replace(/^http/, "ws");

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; token?: string | null; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      String(data.code ?? "http_error"),
      String(data.message ?? `Request failed (${response.status})`)
    );
  }
  return data as T;
}

export interface AuthResult {
  token: string;
  user: User;
}

export interface WelcomeState {
  self: Member;
  org: Org;
  members: Member[];
  teams: Team[];
  edges: OrgEdge[];
  seq: number;
}

export interface RealtimeHandlers {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: "connecting" | "open" | "closed") => void;
}

// WebSocket client with automatic reconnect + cursor resume. The caller
// tracks lastSeq (from welcome/snapshot/event frames) via onMessage; this
// class re-sends hello with sinceSeq so a reconnect replays only the gap.
export class Realtime {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 800;
  lastSeq: number | undefined = undefined;

  constructor(
    private token: string,
    private orgId: string,
    private handlers: RealtimeHandlers
  ) {}

  connect(): void {
    this.closed = false;
    this.handlers.onStatus("connecting");
    const ws = new WebSocket(WS_BASE);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 800;
      ws.send(
        JSON.stringify({
          type: "hello",
          token: this.token,
          orgId: this.orgId,
          ...(this.lastSeq !== undefined ? { sinceSeq: this.lastSeq } : {}),
        })
      );
      this.handlers.onStatus("open");
    };
    ws.onmessage = (raw) => {
      const message = JSON.parse(String(raw.data)) as ServerMessage;
      if (message.type === "welcome" || message.type === "snapshot") {
        this.lastSeq = message.seq;
      } else if (message.type === "event") {
        this.lastSeq = message.event.seq;
      }
      this.handlers.onMessage(message);
    };
    ws.onclose = () => {
      this.handlers.onStatus("closed");
      if (!this.closed) {
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  instruction(text: string, priorityOverride?: CardPriority): void {
    this.send({ type: "instruction", clientRef: crypto.randomUUID(), text, priorityOverride });
  }

  cardAction(
    cardId: string,
    action: CardAction,
    extra: { note?: string; delegateToUserId?: string } = {}
  ): void {
    this.send({ type: "card_action", clientRef: crypto.randomUUID(), cardId, action, ...extra });
  }

  cardMessage(cardId: string, text: string): void {
    this.send({ type: "card_message", clientRef: crypto.randomUUID(), cardId, text });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

// Mirror of the server's feed scoring so ordering stays stable as events
// arrive between snapshots.
const PRIORITY_WEIGHT: Record<DecisionCard["priority"], number> = {
  urgent: 400,
  high: 200,
  medium: 100,
  low: 20,
};

export function rankCards(cards: DecisionCard[], edges: OrgEdge[]): DecisionCard[] {
  const nowMs = Date.now();
  const score = (card: DecisionCard): number => {
    let s = PRIORITY_WEIGHT[card.priority];
    s += Math.min((Math.max(0, nowMs - Date.parse(card.createdAt)) / 3_600_000) * 8, 300);
    if (
      edges.some(
        (edge) =>
          edge.kind === "manages" &&
          edge.fromId === card.senderUserId &&
          edge.toId === card.recipientUserId
      )
    ) {
      s += 80;
    }
    if (card.status === "pending") s += 10_000;
    return s;
  };
  return [...cards].sort((a, b) => score(b) - score(a));
}

export type { DecisionCard, Member, Notification, Org, OrgEdge };
