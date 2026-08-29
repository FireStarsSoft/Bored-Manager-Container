import { vi } from 'vitest'
import type {
  ModuleContext,
  ModuleExecOptions,
  ModuleExecResult,
  ModulePoller,
  ModuleRecord,
  ModuleRecordQuery,
  ModuleStorageGrant,
  ModuleStreamHandle
} from '@shared/modules'

export type ModuleHandler = (...args: unknown[]) => unknown

export interface ModuleHarnessOptions {
  mode?: 'tab' | 'always' | 'off'
  tabActive?: boolean
  /**
   * Which stream events the surfaces that are open read - what the host works
   * out from the module's own spec files. Omitted means "whatever `tabActive`
   * says", which is how the host behaves before it has read them.
   */
  activeStreams?: string[]
  /** Defaults to true: most tests only ever run one instance, which is trivially the primary one. */
  isPrimaryInstance?: boolean
  hostData?: unknown
  /** Backing store for configGet/configSet/onConfigChange; share one across two harnesses to simulate two connected machines' instances of the same module. */
  config?: SharedModuleConfig
  streamError?: Error
  hasSudo?: boolean
  /**
   * Record sets this module declared, as `storage.records` in its manifest.
   * A `recordAppend` to anything else rejects, the way ModuleStorage does -
   * so a test cannot pass by writing to a set the real module never declared.
   */
  recordSets?: string[]
  /** What `storageGrant()` answers with; the defaults are the app's own. */
  storageGrant?: Partial<ModuleStorageGrant>
}

/** A `config` document shared between two or more `moduleHarness()` calls, standing in for the one file two connected machines' instances of a module both read and write. */
export interface SharedModuleConfig {
  get(): unknown
  set(value: unknown): void
  onChange(cb: (value: unknown) => void): () => void
}

/** `moduleHarness(id, ..., { config: sharedModuleConfig(seed) })` twice, sharing the same object, is two instances of one module over one file. */
export function sharedModuleConfig(initial: unknown = null): SharedModuleConfig {
  let value = initial
  const listeners = new Set<(value: unknown) => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      for (const cb of listeners) cb(next)
    },
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

export interface ModuleHarness {
  ctx: ModuleContext
  /** Everything `recordAppend` was given, by set, oldest first. */
  records: Map<string, ModuleRecord[]>
  /**
   * Revoke the context the way ModulesHost does when a module stops, so a
   * test can prove that work still in flight does not keep using it. The
   * split matches the host: things that act on the machine reject or throw,
   * bookkeeping and the two stores go quiet.
   */
  revoke(): void
  /**
   * Every ctx member a module touched after `revoke()`. The rule is that a
   * module stops using its context once it has been disposed
   * (docs/MODULE-RULESET.md), so for a well-behaved module this stays empty -
   * which is what makes it a useful assertion rather than a log.
   */
  afterStopCalls: string[]
  exec: ReturnType<typeof vi.fn<(command: string, options?: ModuleExecOptions) => Promise<ModuleExecResult>>>
  handlers: Map<string, ModuleHandler>
  ticks: Array<() => Promise<void>>
  pollers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>
  emit: ReturnType<typeof vi.fn>
  stream: {
    start: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    pushData(data: string): void
    exit(code: number | null): void
  }
}

/** A ModuleContext that records exec/stream/poller calls instead of talking to a host. */
export function moduleHarness(
  id: string,
  answer: (command: string) => ModuleExecResult | Promise<ModuleExecResult>,
  options: ModuleHarnessOptions = {}
): ModuleHarness {
  const handlers = new Map<string, ModuleHandler>()
  const ticks: Array<() => Promise<void>> = []
  const pollers: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  // The second argument is recorded for tests to inspect (e.g. a `stdin`
  // payload) but never changes what `answer` is asked to respond to - a
  // fixture keyed only on the command stays valid whether or not a call
  // happens to carry options.
  const exec = vi.fn(async (command: string, _options?: ModuleExecOptions) => answer(command))
  const addHistory = vi.fn()
  const configSet = vi.fn()
  const hostDataSet = vi.fn()
  const logMock = vi.fn()
  let dataListener: ((data: string) => void) | null = null
  let exitListener: ((code: number | null) => void) | null = null
  const kill = vi.fn()
  const stream: ModuleStreamHandle = {
    write: vi.fn(),
    kill,
    onData: (listener) => {
      dataListener = listener
    },
    onExit: (listener) => {
      exitListener = listener
    }
  }
  const streamStart = vi.fn(async (_command: string) => {
    if (options.streamError) throw options.streamError
    return stream
  })
  const emit = vi.fn()
  const records = new Map<string, ModuleRecord[]>()
  const declaredSets = new Set(options.recordSets ?? [])
  const grant: ModuleStorageGrant = {
    moduleId: id,
    config: { requestedBytes: 512 * 1024, grantedBytes: 512 * 1024 },
    hostData: { requestedBytes: 512 * 1024, grantedBytes: 512 * 1024 },
    history: { requestedBytes: 64 * 1024 * 1024, grantedBytes: 64 * 1024 * 1024, streams: [id] },
    records: (options.recordSets ?? []).map((setId) => ({
      id: setId,
      label: setId,
      retentionDays: 400,
      overflow: 'evict-oldest' as const,
      requestedBytes: 128 * 1024 * 1024,
      grantedBytes: 128 * 1024 * 1024
    })),
    ...options.storageGrant
  }
  let revoked = false
  const afterStopCalls: string[] = []
  /** Mirrors ModulesHost: record the attempt, then behave as the host does. */
  const afterStop = (member: string): boolean => {
    if (!revoked) return false
    afterStopCalls.push(member)
    return true
  }
  const refuse = (member: string): Promise<never> => {
    afterStopCalls.push(member)
    return Promise.reject(new Error(`module "${id}" is no longer running`))
  }
  const active = (member: string): void => {
    if (!revoked) return
    afterStopCalls.push(member)
    throw new Error(`module "${id}" is no longer running`)
  }
  // A rest parameter forwards exactly the arguments a module passed - a call
  // with no options stays a one-argument call, so existing assertions like
  // `toHaveBeenCalledWith('cmd')` do not start seeing a trailing `undefined`.
  const execOrRefuse = (...args: Parameters<typeof exec>): Promise<ModuleExecResult> =>
    revoked ? refuse('exec') : exec(...args)
  const ctx = {
    id,
    exec: execOrRefuse,
    execSudo: execOrRefuse,
    stream: (command: string) => (revoked ? refuse('stream') : streamStart(command)),
    streamSudo: (command: string) =>
      revoked ? refuse('streamSudo') : streamStart(command),
    connected: true,
    hasSudo: options.hasSudo ?? false,
    createPoller: (_name: string, tick: () => Promise<void>): ModulePoller => {
      active('createPoller')
      ticks.push(tick)
      const poller = { start: vi.fn(), stop: vi.fn() }
      pollers.push(poller)
      return poller
    },
    fastIntervalMs: () => 2_000,
    slowIntervalSec: () => 60,
    detailMode: () => options.mode ?? 'tab',
    get tabActive() {
      return options.tabActive ?? true
    },
    streamActive: (event: string) =>
      (options.tabActive ?? true) &&
      (options.activeStreams == null || options.activeStreams.includes(event)),
    get isPrimaryInstance() {
      return !revoked && (options.isPrimaryInstance ?? true)
    },
    emit: (event: string, payload: unknown) => {
      if (afterStop('emit')) return
      emit(event, payload)
    },
    handle: (method: string, fn: (...args: never[]) => unknown) => {
      active('handle')
      handlers.set(method, fn as unknown as ModuleHandler)
    },
    addHistory: (...args: unknown[]) => {
      if (afterStop('addHistory')) return
      addHistory(...args)
    },
    configGet: () => (afterStop('configGet') ? null : (options.config?.get() ?? null)),
    configSet: (value: unknown) => {
      if (afterStop('configSet')) return
      configSet(value)
      options.config?.set(value)
    },
    onConfigChange: (cb: (value: unknown) => void) => {
      if (afterStop('onConfigChange') || !options.config) return () => {}
      return options.config.onChange(cb)
    },
    // A plain property, not a getter: tests replace these to stand in for a
    // stored document, and a getter-only member cannot be assigned.
    hostDataGet: () => (afterStop('hostDataGet') ? null : (options.hostData ?? null)),
    hostDataSet: (value: unknown) => {
      if (afterStop('hostDataSet')) return
      hostDataSet(value)
    },
    get hostKey() {
      return revoked ? null : 'local'
    },
    isModuleEnabled: () => false,
    // The record store rejects after revocation rather than going quiet, the
    // way ModulesHost does: a collector advances a cursor on a successful
    // append, so an append that silently did nothing would move that cursor
    // past rows nothing kept.
    recordAppend: (setId: string, rows: readonly ModuleRecord[]) => {
      if (revoked) return refuse('recordAppend')
      if (!declaredSets.has(setId)) {
        return Promise.reject(
          new Error(
            `module "${id}" did not declare a record set "${setId}" - add it to storage.records in module.json`
          )
        )
      }
      const bucket = records.get(setId) ?? []
      bucket.push(...rows.map((row) => ({ ...row })))
      records.set(setId, bucket)
      return Promise.resolve()
    },
    recordQuery: (setId: string, query?: ModuleRecordQuery) => {
      if (revoked) return refuse('recordQuery')
      const from = query?.from ?? Number.NEGATIVE_INFINITY
      const to = query?.to ?? Number.POSITIVE_INFINITY
      let rows = (records.get(setId) ?? []).filter(
        (row) => row.t >= from && row.t < to && (query?.key == null || row.key === query.key)
      )
      rows = rows.sort((a, b) => (query?.order === 'desc' ? b.t - a.t : a.t - b.t))
      const limit = query?.limit ?? 500
      return Promise.resolve({ rows: rows.slice(0, limit) })
    },
    recordDelete: (setId: string, query?: ModuleRecordQuery) => {
      if (revoked) return refuse('recordDelete')
      const from = query?.from ?? Number.NEGATIVE_INFINITY
      const to = query?.to ?? Number.POSITIVE_INFINITY
      const before = records.get(setId) ?? []
      const kept = before.filter(
        (row) => !(row.t >= from && row.t < to && (query?.key == null || row.key === query.key))
      )
      records.set(setId, kept)
      return Promise.resolve(before.length - kept.length)
    },
    storageGrant: () => grant,
    storageUsage: () => {
      if (revoked) return refuse('storageUsage')
      const recordBytes = [...records.values()]
        .flat()
        .reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
      return Promise.resolve({
        moduleId: id,
        configBytes: 0,
        hostDataBytes: 0,
        historyBytes: 0,
        recordBytes,
        totalBytes: recordBytes,
        sets: grant.records.map((set) => ({
          id: set.id,
          label: set.label,
          bytes: (records.get(set.id) ?? []).reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0),
          grantedBytes: set.grantedBytes,
          rows: (records.get(set.id) ?? []).length,
          oldestMs: (records.get(set.id) ?? [])[0]?.t ?? null,
          newestMs: (records.get(set.id) ?? []).at(-1)?.t ?? null
        }))
      })
    },
    log: (message: string) => {
      if (afterStop('log')) return
      logMock(message)
    }
  } as unknown as ModuleContext
  return {
    ctx,
    records,
    afterStopCalls,
    revoke: () => {
      revoked = true
    },
    exec,
    handlers,
    ticks,
    pollers,
    emit,
    stream: {
      start: streamStart,
      kill,
      pushData: (data) => dataListener?.(data),
      exit: (code) => exitListener?.(code)
    }
  }
}
