import { decodeServerEvent, encodeClientEvent } from "./protocol";
import type { ClientEvent, ServerEvent } from "./protocol";

type Listener = (event: ServerEvent) => void;
type StatusListener = (connected: boolean) => void;

export interface RelaySocketOptions {
  url: string;
  userId: string;
  orgId?: string;
  /** Native clients only. The web client authenticates with its session cookie. */
  token?: string;
  reconnectDelayMs?: number;
}

/**
 * Mirrors WebSocketService.swift: join on open, snapshot + deltas, automatic
 * reconnect with the same join payload. Uses the global WebSocket, so the same
 * code runs in the browser and in Node tests.
 */
export class RelaySocket {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private attempts = 0;

  constructor(private options: RelaySocketOptions) {}

  get connected() {
    return this.socket?.readyState === 1;
  }

  onEvent(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect() {
    this.closedByUs = false;
    this.clearReconnect();

    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.send({
        type: "join",
        payload: {
          userId: this.options.userId,
          orgId: this.options.orgId ?? "core-team",
          ...(this.options.token ? { token: this.options.token } : {}),
        },
      });
      this.emitStatus(true);
    };

    socket.onmessage = (message: MessageEvent) => {
      const event = decodeServerEvent(String(message.data));
      if (event) this.listeners.forEach((listener) => listener(event));
    };

    socket.onclose = () => {
      this.emitStatus(false);
      this.scheduleReconnect();
    };

    // Reconnection must be driven by BOTH events: browsers fire error→close
    // on a failed connection, but Node/undici fires only error when the
    // connection is refused — relying on close alone stalls the retry loop
    // exactly when the relay is down. scheduleReconnect() is idempotent.
    socket.onerror = () => {
      this.emitStatus(false);
      this.scheduleReconnect();
    };
  }

  send(event: ClientEvent) {
    if (this.socket?.readyState === 1) {
      this.socket.send(encodeClientEvent(event));
    }
  }

  /** Switch identity (user picker) without tearing down the caller's listeners. */
  reidentify(userId: string) {
    this.options = { ...this.options, userId };
    this.disconnect();
    this.connect();
  }

  disconnect() {
    this.closedByUs = true;
    this.clearReconnect();
    this.socket?.close();
    this.socket = null;
    this.emitStatus(false);
  }

  private scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return;

    // Gentle backoff so a long outage doesn't hammer the relay, capped so
    // recovery still feels immediate.
    const base = this.options.reconnectDelayMs ?? 1000;
    const delay = Math.min(base * 2 ** Math.min(this.attempts, 4), 15000);
    this.attempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emitStatus(connected: boolean) {
    this.statusListeners.forEach((listener) => listener(connected));
  }
}
