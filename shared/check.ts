// The "check, then confirm" protocol shared by the app and every module that
// ships a `checkForm` block. A module answers a check with a report the user
// can read before anything happens; the app only offers to apply once that
// report says it may, and hands back the token it came with.
//
// This file is imported by module code compiled with esbuild, so it may not
// use Node builtins - hence no `crypto` below.
import type { ModuleCheckLevel } from './modules'

/**
 * One line of a check report. `pass` is the summary a user reads to confirm
 * the plan is what they meant, `info` is something that will happen anyway,
 * `warning` is worth reading twice but does not block, `error` does.
 */
export interface ModuleCheckFinding {
  level: ModuleCheckLevel
  label: string
  detail?: string
}

/**
 * What a `checkMethod` returns. `ok` is the module's own verdict, not a count
 * of error findings, so a module may refuse for a reason it does not want to
 * spell out. A report with `ok: true` carries the `token` that its matching
 * `applyMethod` requires.
 */
export interface ModuleCheckReport {
  ok: boolean
  token?: string
  findings: ModuleCheckFinding[]
}

/** A report the user cannot act on, for the "this cannot work at all" cases. */
export function failedCheck(label: string, detail?: string): ModuleCheckReport {
  return { ok: false, findings: [{ level: 'error', label, detail }] }
}

/** True when nothing in the report is fatal. */
export function hasBlockingFinding(findings: readonly ModuleCheckFinding[]): boolean {
  return findings.some((f) => f.level === 'error')
}

/** Ten minutes is long enough to read a report and short enough to go stale. */
const TOKEN_TTL_MS = 10 * 60 * 1000

/** A user cannot have many checks open at once; the rest is a leak. */
const MAX_OUTSTANDING = 50

/**
 * Key order is whatever the renderer's field list produced, and the same form
 * can be re-rendered between check and apply, so the comparison has to be
 * order-independent.
 */
function canonical(values: unknown): string {
  if (values === null || typeof values !== 'object') return JSON.stringify(values) ?? 'null'
  if (Array.isArray(values)) return `[${values.map(canonical).join(',')}]`
  const entries = Object.entries(values as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

interface Issued {
  /** The exact values that were checked, not a digest: a collision here would apply something nobody read. */
  values: string
  expiresAt: number
  /** Whatever the check resolved and the apply must not resolve again (a frozen target list, a parsed plan). */
  payload: unknown
}

export interface CheckSession<T = unknown> {
  /** Hand out a token for values that just passed a check. */
  issue(values: unknown, payload?: T): string
  /**
   * Spend a token. False when it is unknown, expired, already used, or when
   * the values changed since the check - which is the whole point: what gets
   * applied is what the user read the report for.
   */
  consume(token: string, values: unknown): boolean
  /** Spend a token and get back what the check resolved, or null if it is not spendable. */
  take(token: string, values: unknown): { payload: T } | null
  /** Invalidate every outstanding token, e.g. when the target machine changed. */
  clear(): void
}

/**
 * The module half of the protocol. One session per check/apply pair, kept in
 * memory only: a token that does not survive a restart is a feature, since the
 * machine it described may not have survived either.
 */
export function createCheckSession<T = unknown>(): CheckSession<T> {
  const open = new Map<string, Issued>()
  let counter = 0

  const sweep = (): void => {
    const now = Date.now()
    for (const [token, entry] of open) {
      if (entry.expiresAt <= now) open.delete(token)
    }
    // Still over the cap after dropping the expired ones: the oldest go, and
    // their forms ask for another check rather than applying something stale.
    while (open.size >= MAX_OUTSTANDING) {
      const oldest = open.keys().next()
      if (oldest.done) break
      open.delete(oldest.value)
    }
  }

  const take = (token: string, values: unknown): { payload: T } | null => {
    const entry = open.get(token)
    if (!entry) return null
    open.delete(token) // single use, whether or not it turns out to match
    if (entry.expiresAt <= Date.now()) return null
    if (entry.values !== canonical(values)) return null
    return { payload: entry.payload as T }
  }

  return {
    issue(values, payload) {
      sweep()
      counter += 1
      const token = `chk_${counter.toString(36)}_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`
      open.set(token, {
        values: canonical(values),
        expiresAt: Date.now() + TOKEN_TTL_MS,
        payload
      })
      return token
    },
    take,
    consume: (token, values) => take(token, values) !== null,
    clear: () => open.clear()
  }
}
