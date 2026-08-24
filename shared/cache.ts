export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>
  clear(key?: string): void
}

/**
 * A small in-memory cache for module RPC reads. Concurrent callers for one key
 * share the same promise; only successful values enter the TTL cache.
 */
export function createTtlCache<T>(
  ttlMs: number | (() => number),
  now: () => number = Date.now
): TtlCache<T> {
  const values = new Map<string, { value: T; expiresAt: number }>()
  const pending = new Map<string, Promise<T>>()
  const revisions = new Map<string, number>()
  let globalRevision = 0
  const ttl = (): number => {
    const value = typeof ttlMs === 'function' ? ttlMs() : ttlMs
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  }

  return {
    get(key, load) {
      const current = values.get(key)
      if (current && current.expiresAt > now()) return Promise.resolve(current.value)
      if (current) values.delete(key)
      const active = pending.get(key)
      if (active) return active

      const startedAtRevision = `${globalRevision}:${revisions.get(key) ?? 0}`
      let request!: Promise<T>
      request = Promise.resolve()
        .then(load)
        .then((value) => {
          const duration = ttl()
          const currentRevision = `${globalRevision}:${revisions.get(key) ?? 0}`
          if (duration > 0 && currentRevision === startedAtRevision) {
            values.set(key, { value, expiresAt: now() + duration })
          }
          return value
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key)
        })
      pending.set(key, request)
      return request
    },
    clear(key) {
      if (key === undefined) {
        globalRevision++
        values.clear()
        pending.clear()
      } else {
        revisions.set(key, (revisions.get(key) ?? 0) + 1)
        values.delete(key)
        pending.delete(key)
      }
    }
  }
}
