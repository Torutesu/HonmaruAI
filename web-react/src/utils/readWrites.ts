// Preserve the order of this client's read/unread writes for each conversation.
// An older response may settle after a newer intent; it must not redraw it.
export class ReadWrites {
  private tails = new Map<string, Promise<unknown>>()
  private versions = new Map<string, number>()
  run<T>(key: string, write: (latest: () => boolean) => Promise<T>): Promise<T> {
    const version = (this.versions.get(key) || 0) + 1
    this.versions.set(key, version)
    const previous = this.tails.get(key) || Promise.resolve()
    const result = previous.catch(() => {}).then(() => write(() => this.versions.get(key) === version))
    this.tails.set(key, result)
    const clean = () => { if (this.tails.get(key) === result) this.tails.delete(key) }
    void result.then(clean, clean)
    return result
  }
}
