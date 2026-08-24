// The module system: what a module declares about itself, and the rules an
// archive has to satisfy before the app will install it. Shared between the
// main process (which enforces the rules) and the renderer (which shows the
// verdict), so there is exactly one definition of "a valid module".
import { isRecord } from './validation'

/**
 * Version of the contract between the app and a module's entry points. A
 * module declares which one it was written against; the app refuses anything
 * it cannot run. Bump only when an existing entry point changes shape.
 *
 * 2: the renderer half stopped being React compiled into the bundle and
 *    became a declarative `ui/*.json` spec the app renders itself (Phase 3).
 *    `entries.renderer` (the old React entry) is rejected outright - see
 *    `entries.renderer` below.
 */
export const MODULE_API_VERSION = 2

/**
 * Ids the app uses for itself - a module may not claim one of them. Beyond its
 * own pages, the id doubles as a history stream name, so the three streams the
 * app writes (`system`, `top`, `services`) are here too: a module called `top`
 * would otherwise append to the Overview's own history by simply doing what
 * every module does.
 */
export const RESERVED_MODULE_IDS = [
  'overview',
  'packages',
  'terminals',
  'settings',
  'core',
  'app',
  'module',
  'modules',
  'system',
  'top',
  'services',
  'metrics'
] as const

/**
 * History streams the app fills itself. A module may read one (`{ kind:
 * "history", stream: "system" }` behind a chart of its own), but never write
 * one - see `ownsHistoryStream`.
 */
export const CORE_HISTORY_STREAMS = ['system', 'top', 'services'] as const

/**
 * The alphabet a history stream name has to keep to, because it becomes part
 * of a file name (`<stream>-<YYYYMMDDHH>.jsonl`) that the retention sweep
 * parses back out again.
 */
export const HISTORY_STREAM_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Which history streams belong to a module: its own id, and anything under
 * `<id>-` for a module that keeps more than one series (`network-tcp`). The
 * prefix is what makes "this module's history" a decidable question - without
 * it, uninstalling could not tell which files on disk were its, and one module
 * could quietly append to another's chart.
 */
export function ownsHistoryStream(moduleId: string, stream: string): boolean {
  return stream === moduleId || stream.startsWith(`${moduleId}-`)
}

/** Why this module may not write that history stream, or null when it may. */
export function historyStreamProblem(moduleId: string, stream: string): string | null {
  if (!HISTORY_STREAM_PATTERN.test(stream)) {
    return `history stream "${stream}" is not a valid name (lowercase letters, digits and dashes)`
  }
  if (!ownsHistoryStream(moduleId, stream)) {
    return `history stream "${stream}" belongs to another module (write to "${moduleId}" or "${moduleId}-<name>")`
  }
  return null
}

/**
 * Lowercase, starts with a letter, 2-32 characters. The id doubles as the
 * folder name, the IPC channel prefix and the layout key of its cards, so it
 * has to be safe in all three.
 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/**
 * Same alphabet as a module id, one character shorter at the minimum. A page
 * or widget id only ever appears qualified by its module (`<moduleId>/<id>`,
 * `<moduleId>.<id>`), so `main` or `a` is unambiguous where a bare module id
 * would not be.
 */
export const SUB_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export const MODULE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** File that carries the manifest, at the root of the module folder. */
export const MODULE_MANIFEST_FILE = 'module.json'

/** Largest module archive the app will download. */
export const MODULE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024

export const MODULE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000

/** A sidebar page a module contributes. ≥2 pages become a dropdown (T4.1). */
export interface ModulePageDecl {
  /** Unique within the module; the route is `<moduleId>/<id>`. */
  id: string
  label: string
  /** lucide-react icon name, e.g. "HardDrive". */
  icon?: string
  /** Sort key among the module's own pages, and among sidebar entries when there is only one. */
  order?: number
}

/** An Overview widget a module contributes. */
export interface ModuleWidgetDecl {
  /** Unique within the module; the settings/layout key is `<moduleId>.<id>`. */
  id: string
  label: string
  /** Shown on unless the user turns it off. */
  defaultEnabled?: boolean
  /** Position among the Overview cards before the user drags anything. */
  order?: number
}

/**
 * A snapshot channel the main half emits. The app mirrors it into the
 * renderer's module bus so a block's `{ kind: 'stream' }` source can read it
 * without the module wiring anything itself.
 */
export interface ModuleStreamDecl {
  event: string
  /** `series` keeps a 5-minute ring keyed by `t`; `latest` keeps one value. */
  kind: 'series' | 'latest'
}

/** `module.json` - everything the app knows about a module before running it. */
export interface ModuleManifest {
  apiVersion: number
  id: string
  name: string
  version: string
  description: string
  author: string
  /** Lowest app version this module works with, e.g. "0.0.1". */
  minAppVersion?: string
  /** Whether the module is enabled on first install. Defaults to true. */
  defaultEnabled?: boolean
  entries: {
    /** Path inside the module folder to its main-process half, e.g. `main/index.ts`. */
    main: string
    /**
     * No longer supported (T3.7): the API v1 renderer half was a React entry
     * point compiled into the app's own bundle. Kept in the type only so
     * `manifestProblems` can recognise it and reject it with a clear
     * message instead of silently ignoring an unknown field.
     */
    renderer?: string
  }
  /** Sidebar pages; omit for a module that only adds Overview widgets. */
  pages?: ModulePageDecl[]
  widgets?: ModuleWidgetDecl[]
  streams?: ModuleStreamDecl[]
  /** Names registered with `ctx.handle`, callable from a block spec. */
  methods?: string[]
  /** Key in settings.refresh this module reads. */
  fastInterval?: string
  /** Key in settings.slowRefresh this module reads. */
  slowInterval?: string
}

/** Where an installed module came from. */
export type ModuleSource = 'default' | 'zip' | 'url'

/**
 * Whether the files on disk still hash to what was recorded when the module
 * was installed. `unknown` means the hash could not be computed (unreadable
 * folder), not that the module is broken.
 */
export type ModuleIntegrity = 'ok' | 'modified' | 'unknown'

/** The app's own record of an installed module, kept outside the module. */
export interface ModuleRuntimeState {
  id: string
  enabled: boolean
  /** Version recorded at install time; compared against the manifest on load. */
  version: string
  /** SHA-256 over the module folder, see moduleFolderHash. */
  hash: string
  source: ModuleSource
  installedAt: number
  updatedAt: number
}

/**
 * An installed module as the Settings page sees it. The module's own README
 * and CHANGELOG are deliberately not here: the list is pushed to every browser
 * whenever anything about any module changes, and shipping a few hundred KB of
 * prose nobody has asked to read made every toggle cost that much per client.
 * The Details dialog fetches them for one module with `modules:docs`.
 */
export interface ModuleDescriptor {
  manifest: ModuleManifest
  state: ModuleRuntimeState
  integrity: ModuleIntegrity
  /** Set when the module is present but cannot be run, with the reason. */
  problem?: string
}

/** What a module ships to read, fetched on demand for the Details dialog. */
export interface ModuleDocs {
  /** Undefined when the module ships no such file. */
  readme?: string
  changelog?: string
}

/**
 * One rule the app checked an archive against. `error` blocks the install,
 * `warning` needs the user to confirm, `info` and `pass` are informational.
 */
export type ModuleCheckLevel = 'pass' | 'info' | 'warning' | 'error'

export interface ModuleCheckItem {
  id: string
  level: ModuleCheckLevel
  label: string
  detail?: string
}

/** What installing the inspected archive would do to the current install. */
export type ModuleInstallKind = 'new' | 'upgrade' | 'reinstall' | 'downgrade'

export interface ModuleValidation {
  /** error = cannot install; warning = install only after confirming. */
  status: 'pass' | 'warning' | 'error'
  kind: ModuleInstallKind
  moduleId?: string
  moduleName?: string
  newVersion?: string
  /** Version currently installed, absent for a new module. */
  installedVersion?: string
  /** True when this would overwrite a module that shipped with the app. */
  overwritesDefault: boolean
  checks: ModuleCheckItem[]
}

export type ModuleInstallPhase =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'ready'
  | 'installing'
  | 'building'
  | 'done'
  | 'error'

/**
 * An interrupted install/uninstall that startup recovery could not finish.
 *
 * The journal stays on disk, so module operations stay blocked until either a
 * retry succeeds or the operator discards it: renaming it aside automatically
 * would unblock the app while the module folder, its config and the registry
 * may still be half rolled back.
 */
export interface ModuleRecoveryFailure {
  /** Journal file name without `.json`; empty when the directory itself could not be listed. */
  transactionId: string
  /** The module it was for - null when the journal was too damaged to say. */
  moduleId: string | null
  operation: 'install' | 'uninstall' | null
  /** Why recovery stopped, already stripped of host paths. */
  reason: string
}

export interface ModuleInstallState {
  phase: ModuleInstallPhase
  /** Archive being inspected: a URL or the path of the picked file. */
  source?: string
  progress?: { receivedBytes: number; totalBytes: number | null }
  validation?: ModuleValidation
  /** One-use capability for this exact inspected tree; omitted outside ready. */
  confirmation?: {
    token: string
    expiresAt: number
  }
  /** Tail of the build output while phase is 'building'. */
  log?: string[]
  /**
   * What the last recovery pass could not finish. Non-empty means every
   * module operation is blocked until Settings -> Modules retries or discards
   * these.
   */
  recoveryFailures?: ModuleRecoveryFailure[]
  error?: string
}

// ---------- The community catalog ----------
//
// registry/modules.json on the configured update repo's main branch: modules
// someone has reviewed and vouched for. The installer hashes every archive it
// grades and checks it against this list (see module-installer.ts's
// 'catalog-verified' / 'unverified-source' checks) - fetching and caching the
// file itself is server/services/registry.ts.

/** Version of the `registry/modules.json` schema below. */
export const REGISTRY_VERSION = 1

/** One module a maintainer has reviewed and is willing to vouch for. */
export interface RegistryEntry {
  /** Must match the module's own `module.json` id. */
  id: string
  name: string
  description: string
  author: string
  /** Opened in a new tab from the catalog; not every entry has one. */
  homepage?: string
  /** The version that was reviewed - not necessarily the module's latest. */
  version: string
  minAppVersion?: string
  /** Direct link to the reviewed archive, normally a GitHub release asset. */
  download: string
  /** hex SHA-256 of that exact archive; this is what "verified" is checked against. */
  sha256: string
  /** `YYYY-MM-DD` the entry was last reviewed. */
  verifiedAt: string
}

/** The shape of `registry/modules.json`. */
export interface RegistryFile {
  registryVersion: number
  modules: RegistryEntry[]
}

/** What `modules:catalog` and `modules:catalogRefresh` answer. */
export interface ModuleCatalog {
  entries: RegistryEntry[]
  /** Exact configured repository this response was fetched for. */
  sourceRepo: string
  /** Exact registry URL derived from sourceRepo. */
  sourceUrl: string
  /** When this list was fetched; null when a fetch has never succeeded. */
  fetchedAt: number | null
  /** True when a refetch failed and this is a cached (possibly older) copy. */
  stale: boolean
}

// ---------- The runtime contract ----------
//
// A module's entry points are typed entirely from this file: nothing here
// imports from `server/` or `src/`, so a module never has to reach into the
// app's internals to describe what it does. The server implements these
// shapes (see server/services/modules-host.ts).

export interface ModuleExecResult {
  stdout: string
  stderr: string
  code: number
}

export interface ModuleExecOptions {
  stdin?: string
  timeoutMs?: number
  /** Kill the command early - e.g. a user-cancelled or module-disabled batch job - instead of waiting out timeoutMs. */
  signal?: AbortSignal
}

/** A command that keeps running, with its output arriving as it comes. */
export interface ModuleStreamHandle {
  write(data: string): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null) => void): void
}

/**
 * A repeating job. Starting it runs the tick immediately and then on the
 * interval; a tick that is still running never overlaps with the next one.
 *
 * The app holds on to every poller it hands out and stops it when the module
 * is deactivated, so forgetting one in `dispose()` cannot leave a timer
 * hitting the target machine for a module the user has switched off. That is
 * a backstop, not a licence: the leak is logged against the module.
 */
export interface ModulePoller {
  start(intervalMs: number): void
  stop(): void
}

/** One reduced history sample: a timestamp plus a few numbers. */
export interface ModuleHistoryPoint {
  t: number
  [key: string]: number
}

/**
 * Everything a module may do in the main process. Deliberately narrow: a
 * module talks to the target machine and to its own renderer half, and never
 * touches the app folder or another module's state.
 *
 * The context is **revoked** when the module is deactivated (switched off,
 * reloaded, uninstalled, or on a clean close). A module that kept a reference
 * to `ctx` in a stray timer or an unresolved promise therefore cannot go on
 * running commands, emitting or writing files after the app has been told it
 * is gone. What that looks like depends on the member:
 *
 * - `exec`, `execSudo`, `stream`, `streamSudo` reject with
 *   `module "<id>" is no longer running`, and `handle`, `createPoller` (and a
 *   poller's `start`) throw it. A module has to be able to tell that its
 *   command did not run.
 * - `emit`, `addHistory`, `log`, `configSet` and `hostDataSet` do nothing;
 *   `configGet`, `hostDataGet` and `hostKey` return `null`. The point of
 *   revoking those is "write nothing more", which doing nothing satisfies -
 *   and unlike a throw it cannot escape a detached promise and take the
 *   server down. The first such call is logged against the module.
 *
 * Either way, work that outlives `dispose()` is a bug in the module: see the
 * checklist in docs/MODULE-RULESET.md.
 */
export interface ModuleContext {
  readonly id: string
  /** Run a command on the target machine (local shell or SSH). */
  exec(command: string, opts?: ModuleExecOptions): Promise<ModuleExecResult>
  /** Same, elevated when a sudo password was given; plain otherwise. */
  execSudo(command: string, opts?: ModuleExecOptions): Promise<ModuleExecResult>
  /** Long-running command with a live output stream (e.g. `docker logs -f`). */
  stream(command: string): Promise<ModuleStreamHandle>
  /** Long-running elevated command with a live output stream. */
  streamSudo(command: string): Promise<ModuleStreamHandle>
  /** True when a target machine is connected. */
  readonly connected: boolean
  /** True when commands can be elevated (root, or a sudo password was given). */
  readonly hasSudo: boolean
  createPoller(name: string, tick: () => Promise<void>): ModulePoller
  /**
   * Fast interval in ms for a settings.refresh key; 0 means "paused".
   * A key with no entry in settings.refresh reads as "normal", not paused.
   */
  fastIntervalMs(key: string): number
  /**
   * Slow interval in seconds for a settings.slowRefresh key; 0 means manual.
   * A key with no entry in settings.slowRefresh reads back as 60.
   */
  slowIntervalSec(key: string): number
  /** Detail collector mode for a settings.detailPolling key. */
  detailMode(key: string): 'tab' | 'always' | 'off'
  /** True while any of this module's pages is the visible tab (`<id>` or `<id>/<page>`). */
  readonly tabActive: boolean
  /**
   * The narrower form of `tabActive`: true while a surface that is open right
   * now - a page of this module, or one of its Overview cards - actually
   * reads `event`.
   *
   * For a module whose collectors all feed the same page, `tabActive` is the
   * right gate and this adds nothing. It is for the module with one cheap
   * stream and one expensive one: Disk's Overview card and its File systems
   * page read only the slow `storage` stream, so gating the per-process I/O
   * sweep on `tabActive` ran a walk of `/proc` on the target every couple of
   * seconds for a card that never shows it.
   *
   * Only `{ kind: "stream" }` sources and a history source's `liveEvent`
   * count. A `log` block's stream is started and stopped by the block itself
   * (`module:logs:start` / `module:logs:stop`), so it is never gated here.
   *
   * Anything the host cannot answer for - a spec that failed to load, or one
   * it has not read yet - falls back to `tabActive` rather than to false: a
   * page that never fills in is a worse failure than a poller that runs.
   */
  streamActive(event: string): boolean
  /**
   * True for exactly one connected machine's instance of this module at a
   * time. Most modules never need this - their poller collects from the
   * machine they are bound to, so one instance per machine is the point. It
   * is for the few (a fleet or BMC sweep) whose slow section reaches a list
   * the user configured rather than the machine this instance happens to be
   * connected through, where two connected machines running the same
   * automatic sweep would be duplicate work against the same targets. The
   * instance whose tab is open wins; with none open, whichever connected
   * first does, so there is still exactly one primary. A manual,
   * user-pressed refresh should run regardless of this flag - only the
   * automatic poller needs to check it.
   */
  readonly isPrimaryInstance: boolean
  /** Push a payload to the module's renderer half under this event name. */
  emit(event: string, payload: unknown): void
  /**
   * Answer a call from the module's renderer half. `method` has to be one of
   * the manifest's `methods` - registering anything else throws, so what a
   * module exposes is exactly what its manifest says it does.
   */
  handle(method: string, fn: (...args: never[]) => unknown): void
  /**
   * Append a reduced sample to this module's metrics history on disk. The
   * stream defaults to the module's id and may only be one this module owns
   * (`<id>` or `<id>-<name>`); anything else throws.
   */
  addHistory(point: ModuleHistoryPoint, stream?: string): void
  /**
   * This module's own settings, shared by every target machine. Returns null
   * until something has been written. Meant for the handful of values a user
   * tunes once - not for cached readings.
   */
  configGet(): unknown
  /** Replace the settings above. Throws if the payload is over 512 KB. */
  configSet(value: unknown): void
  /**
   * Called with the new value whenever this module's config changes,
   * including a write made by another instance of this module on a
   * different connected machine - the two do not share process memory, so a
   * module that keeps its own copy of `configGet()` instead of reading it
   * fresh every time needs this to notice. Returns a function that stops
   * listening; a module that subscribes does not have to unsubscribe itself
   * before `dispose()`, since revoking the context drops it anyway, but
   * doing so is tidier.
   */
  onConfigChange(cb: (value: unknown) => void): () => void
  /**
   * What this module remembers about the machine that is connected right now,
   * kept on the app's disk and not on the target. Returns null when nothing is
   * connected, so a caller has to cope with "no host" either way.
   */
  hostDataGet(): unknown
  /** Replace the per-host data above. Does nothing while disconnected. */
  hostDataSet(value: unknown): void
  /** Which machine hostDataGet/Set are pointed at, or null when disconnected. */
  readonly hostKey: string | null
  /** Whether another module is installed and enabled, for optional probes. */
  isModuleEnabled(id: string): boolean
  log(message: string): void
}

/** What a module's main entry returns. Only `dispose` is required. */
export interface ModuleMainInstance {
  /**
   * Start or stop this module's pollers to match the current settings and
   * connection. Called on connect, disconnect, every settings change and when
   * the visible tab changes, so it has to be idempotent.
   */
  applyPollers?(): void
  /** Drop per-session state: rate baselines, session totals, caches. */
  reset?(): void
  /**
   * What a freshly connected renderer needs so its charts do not start empty,
   * keyed by the event name the module emits that data under.
   */
  snapshots?(): Record<string, unknown>
  /** Take an immediate reading of a slow section this module owns. */
  refreshSlow?(target: string): Promise<void>
  /** Slow sections this module answers refreshSlow for. */
  slowTargets?(): string[]
  /**
   * Release everything: pollers, watchers, log streams. Called before the
   * context is revoked, so this is the last chance to use `ctx` - and the
   * only place a module can shut down cleanly rather than having the app cut
   * its pollers and streams off for it.
   */
  dispose(): void
}

/** The default export of `main/index.ts`. */
export type ModuleActivate = (ctx: ModuleContext) => ModuleMainInstance

/**
 * Compare two `x.y.z` strings. Returns a negative number when `a` is older,
 * 0 when they are the same, positive when `a` is newer. Anything that is not
 * a number counts as 0, so a malformed version sorts as the lowest.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Why this id cannot be used, or null when it is fine. */
export function moduleIdProblem(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'no id'
  if (!MODULE_ID_PATTERN.test(id)) {
    return `"${id}" is not a valid id (lowercase letters, digits and dashes, 2-32 characters)`
  }
  if ((RESERVED_MODULE_IDS as readonly string[]).includes(id)) {
    return `"${id}" is a name the app uses itself`
  }
  return null
}

/** The full card id as used in settings and the Overview layout. */
export function moduleCardId(moduleId: string, cardId: string): string {
  return `${moduleId}.${cardId}`
}

/** A relative path has to stay inside the module folder. */
function badRelativePath(value: string): boolean {
  if (
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\')
  ) {
    return true
  }
  return value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

function pathProblem(field: string, value: unknown, required: boolean): string | null {
  if (value == null) return required ? `${field} is required` : null
  if (typeof value !== 'string' || !value.trim()) return `${field} is not a path`
  if (badRelativePath(value)) return `${field} must be a relative path inside the module folder`
  return null
}

/** Why this id cannot be used as a page or widget id, or null when it is fine. */
function subIdProblem(kind: string, id: unknown): string | null {
  if (typeof id !== 'string' || !SUB_ID_PATTERN.test(id)) {
    return `${kind} id "${String(id)}" is not valid (lowercase letters, digits and dashes, 1-32 characters)`
  }
  return null
}

/**
 * Check a parsed `module.json` against the schema. Returns the reasons it is
 * unusable - empty means the manifest is fine. Used both when installing an
 * archive and when loading what is already on disk, so a module can never be
 * half-accepted.
 */
export function manifestProblems(raw: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(raw)) return ['module.json is not an object']
  const m = raw as Partial<ModuleManifest>

  if (!Number.isSafeInteger(m.apiVersion)) problems.push('apiVersion is missing or not an integer')
  else if (m.apiVersion !== MODULE_API_VERSION) {
    problems.push(
      `apiVersion ${m.apiVersion} cannot be run by this app (it speaks ${MODULE_API_VERSION})`
    )
  }

  const idProblem = moduleIdProblem(m.id)
  if (idProblem) problems.push(idProblem)

  if (typeof m.name !== 'string' || !m.name.trim()) problems.push('name is missing')
  if (typeof m.description !== 'string' || !m.description.trim()) problems.push('description is missing')
  if (typeof m.author !== 'string' || !m.author.trim()) problems.push('author is missing')
  if (m.defaultEnabled != null && typeof m.defaultEnabled !== 'boolean') {
    problems.push('defaultEnabled is not a boolean')
  }
  if (typeof m.version !== 'string' || !MODULE_VERSION_PATTERN.test(m.version)) {
    problems.push('version is not in x.y.z form')
  }
  if (
    m.minAppVersion != null &&
    (typeof m.minAppVersion !== 'string' || !MODULE_VERSION_PATTERN.test(m.minAppVersion))
  ) {
    problems.push('minAppVersion is not in x.y.z form')
  }

  const entries = m.entries
  if (!isRecord(entries)) {
    problems.push('entries is missing')
  } else {
    const mainProblem = pathProblem('entries.main', entries.main, true)
    if (mainProblem) problems.push(mainProblem)
    if (entries.renderer != null) {
      problems.push(
        'entries.renderer is no longer supported (API v2) - the renderer half must be ui/pages/*.json and ui/widgets/*.json, not a compiled-in React entry'
      )
    }
  }

  const seenPages = new Set<string>()
  if (m.pages != null && !Array.isArray(m.pages)) problems.push('pages is not an array')
  if (Array.isArray(m.pages) && m.pages.length > 1_000) problems.push('pages contains too many entries')
  for (const page of Array.isArray(m.pages) ? m.pages : []) {
    if (!isRecord(page)) {
      problems.push('pages contains something that is not an object')
      continue
    }
    const p = page as Partial<ModulePageDecl>
    const problem = subIdProblem('page', p.id)
    if (problem) problems.push(problem)
    else if (seenPages.has(p.id as string)) problems.push(`page id "${p.id}" is declared twice`)
    else seenPages.add(p.id as string)
    if (typeof p.label !== 'string' || !p.label.trim()) {
      problems.push(`page "${String(p.id)}" has no label`)
    }
    if (p.order != null && typeof p.order !== 'number') {
      problems.push(`page "${String(p.id)}".order is not a number`)
    }
    if (typeof p.order === 'number' && !Number.isFinite(p.order)) {
      problems.push(`page "${String(p.id)}".order is not finite`)
    }
    if (p.icon != null && (typeof p.icon !== 'string' || !p.icon.trim())) {
      problems.push(`page "${String(p.id)}".icon is not a non-empty string`)
    }
  }

  const seenWidgets = new Set<string>()
  if (m.widgets != null && !Array.isArray(m.widgets)) problems.push('widgets is not an array')
  if (Array.isArray(m.widgets) && m.widgets.length > 1_000) {
    problems.push('widgets contains too many entries')
  }
  for (const widget of Array.isArray(m.widgets) ? m.widgets : []) {
    if (!isRecord(widget)) {
      problems.push('widgets contains something that is not an object')
      continue
    }
    const w = widget as Partial<ModuleWidgetDecl>
    const problem = subIdProblem('widget', w.id)
    if (problem) problems.push(problem)
    else if (seenWidgets.has(w.id as string)) problems.push(`widget id "${w.id}" is declared twice`)
    else seenWidgets.add(w.id as string)
    if (typeof w.label !== 'string' || !w.label.trim()) {
      problems.push(`widget "${String(w.id)}" has no label`)
    }
    if (w.defaultEnabled != null && typeof w.defaultEnabled !== 'boolean') {
      problems.push(`widget "${String(w.id)}".defaultEnabled is not a boolean`)
    }
    if (w.order != null && (typeof w.order !== 'number' || !Number.isFinite(w.order))) {
      problems.push(`widget "${String(w.id)}".order is not a finite number`)
    }
  }

  const seenStreams = new Set<string>()
  if (m.streams != null && !Array.isArray(m.streams)) problems.push('streams is not an array')
  if (Array.isArray(m.streams) && m.streams.length > 1_000) {
    problems.push('streams contains too many entries')
  }
  for (const stream of Array.isArray(m.streams) ? m.streams : []) {
    if (!isRecord(stream)) {
      problems.push('streams contains something that is not an object')
      continue
    }
    const s = stream as Partial<ModuleStreamDecl>
    if (typeof s.event !== 'string' || !s.event.trim()) {
      problems.push('a stream is missing its event name')
    } else if (seenStreams.has(s.event)) {
      problems.push(`stream event "${s.event}" is declared twice`)
    } else {
      seenStreams.add(s.event)
    }
    if (s.kind !== 'series' && s.kind !== 'latest') {
      problems.push(`stream "${String(s.event)}" has an invalid kind (must be "series" or "latest")`)
    }
  }

  if (
    m.methods != null &&
    (!Array.isArray(m.methods) ||
      m.methods.some((value) => typeof value !== 'string' || !value.trim()))
  ) {
    problems.push('methods is not an array of strings')
  }
  if (Array.isArray(m.methods)) {
    if (m.methods.length > 10_000) problems.push('methods contains too many entries')
    const seenMethods = new Set<string>()
    for (const method of m.methods) {
      if (typeof method !== 'string') continue
      if (seenMethods.has(method)) problems.push(`method "${method}" is declared twice`)
      seenMethods.add(method)
    }
  }
  if (m.fastInterval != null && (typeof m.fastInterval !== 'string' || !m.fastInterval.trim())) {
    problems.push('fastInterval is not a non-empty string')
  }
  if (m.slowInterval != null && (typeof m.slowInterval !== 'string' || !m.slowInterval.trim())) {
    problems.push('slowInterval is not a non-empty string')
  }

  return problems
}
