import type { ChatChannel, ChatMessage, DecisionCard } from "./types";

// Offline read cache. The relay is the source of truth; this only makes a
// cold start on a bad connection show your last known feed instead of an
// empty screen. It is never written back to the relay and never used to
// decide anything — a decision always needs the network.

export interface CachedSnapshot {
  /** Whose view this is: switching members must not show the previous one's feed. */
  userID: string;
  savedAt: string;
  cardsByUser: Record<string, DecisionCard[]>;
  channels: ChatChannel[];
  messagesByChannel: Record<string, ChatMessage[]>;
}

/** Enough to fill the screen and scroll a little; not a full mirror. */
export const CACHE_LIMITS = { cardsPerUser: 100, messagesPerChannel: 60 };

/** A week-old feed is worse than no feed — it invites deciding on stale facts. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAME = "ttfw-cache";
const STORE = "snapshot";
const KEY = "latest";

/** Cards are newest-first, messages oldest-first: keep the recent end of each. */
export function trimSnapshot(
  snapshot: CachedSnapshot,
  limits = CACHE_LIMITS
): CachedSnapshot {
  return {
    ...snapshot,
    cardsByUser: Object.fromEntries(
      Object.entries(snapshot.cardsByUser).map(([userID, cards]) => [
        userID,
        cards.slice(0, limits.cardsPerUser),
      ])
    ),
    messagesByChannel: Object.fromEntries(
      Object.entries(snapshot.messagesByChannel).map(([channelID, messages]) => [
        channelID,
        messages.slice(-limits.messagesPerChannel),
      ])
    ),
  };
}

export function isStale(
  snapshot: Pick<CachedSnapshot, "savedAt">,
  now = Date.now(),
  maxAgeMs = MAX_AGE_MS
): boolean {
  const savedAt = Date.parse(snapshot.savedAt);
  if (Number.isNaN(savedAt)) return true;
  return now - savedAt > maxAgeMs;
}

/** Usable means: same person, not expired, and actually carrying something. */
export function isUsable(
  snapshot: CachedSnapshot | null | undefined,
  userID: string,
  now = Date.now()
): snapshot is CachedSnapshot {
  if (!snapshot || snapshot.userID !== userID) return false;
  if (isStale(snapshot, now)) return false;
  return (snapshot.cardsByUser[userID] ?? []).length > 0 || snapshot.channels.length > 0;
}

function openDB(): Promise<IDBDatabase | null> {
  // Node (the integration test) and private-mode browsers have no IndexedDB;
  // the cache is an optimisation, so absence is not an error.
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readSnapshot(userID: string): Promise<CachedSnapshot | null> {
  const db = await openDB();
  if (!db) return null;
  try {
    const value = await run<CachedSnapshot>(db, "readonly", (store) => store.get(KEY));
    return isUsable(value, userID) ? value : null;
  } finally {
    db.close();
  }
}

export async function writeSnapshot(snapshot: CachedSnapshot): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    await run(db, "readwrite", (store) => store.put(trimSnapshot(snapshot), KEY));
  } finally {
    db.close();
  }
}

export async function clearSnapshot(): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    await run(db, "readwrite", (store) => store.delete(KEY));
  } finally {
    db.close();
  }
}
