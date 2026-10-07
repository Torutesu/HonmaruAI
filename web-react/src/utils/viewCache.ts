// What a screen last showed, kept in memory for this account and workspace
// (issue #209): a profile, a thread, the Threads, Activity and Sent lists.
// Opened again, the screen draws it at once and asks the server behind it;
// what the server says replaces it. Memory only — nothing here goes to
// disk — and dropped with the account's message cache on sign-out.
const MAX_ENTRIES = 200

export class ViewCache {
  private entries = new Map<string, { value: unknown; at: number }>()
  get<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined
  }
  /// Whether what is kept was read from the server within `ms`.
  fresh(key: string, ms: number): boolean {
    const e = this.entries.get(key)
    return Boolean(e && Date.now() - e.at < ms)
  }
  set<T>(key: string, value: T, { read = true }: { read?: boolean } = {}): void {
    // A change made here (a reply sent, an item read) is kept without
    // counting as a fresh read from the server.
    const at = read ? Date.now() : (this.entries.get(key)?.at ?? 0)
    this.entries.delete(key)
    this.entries.set(key, { value, at })
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
  }
  delete(key: string): void { this.entries.delete(key) }
  /// Everything under a prefix ("profile:") is stale: kept to draw, but
  /// read again the next time it is shown.
  stale(prefix: string): void {
    for (const [k, e] of this.entries) if (k.startsWith(prefix)) e.at = 0
  }
  clear(): void { this.entries.clear() }
}
