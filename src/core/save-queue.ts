// A debounced save can fire while its previous request is still in
// flight. Keep the newest immutable snapshot dirty until it has
// actually persisted, and drain snapshots one at a time. Updates that
// arrive during a request are picked up by the same drain loop.
export interface SerializedSaveQueue<T> {
  enqueue(snapshot: T): void
  flush(): Promise<boolean>
  discard(): Promise<void>
  isDirty(): boolean
  pending(): T | null
}

export function createSerializedSaveQueue<T>(
  persist: (snapshot: T) => Promise<void>,
  onError?: (error: unknown, snapshot: T) => void,
): SerializedSaveQueue<T> {
  let queuedRevision = 0
  let persistedRevision = 0
  let latest: T | null = null
  let draining: Promise<boolean> | null = null

  async function drain(): Promise<boolean> {
    while (persistedRevision < queuedRevision) {
      const revision = queuedRevision
      const snapshot = latest
      if (snapshot === null) {
        persistedRevision = revision
        continue
      }
      try {
        await persist(snapshot)
      } catch (error) {
        try { onError?.(error, snapshot) } catch { /* reporting must not break the queue */ }
        return false
      }
      persistedRevision = Math.max(persistedRevision, revision)
    }
    return true
  }

  return {
    enqueue(snapshot: T): void {
      latest = snapshot
      queuedRevision += 1
    },
    flush(): Promise<boolean> {
      if (draining) return draining
      const run = drain()
      const tracked: Promise<boolean> = run.finally(() => {
        if (draining === tracked) draining = null
      })
      draining = tracked
      return tracked
    },
    async discard(): Promise<void> {
      persistedRevision = queuedRevision
      latest = null
      if (draining) await draining
    },
    isDirty(): boolean {
      return persistedRevision < queuedRevision
    },
    pending(): T | null {
      return persistedRevision < queuedRevision ? latest : null
    },
  }
}
