import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type AppSettings,
  type CollectorSettings,
  type Density,
  type DetailPollingMode,
  type DetailPollingSettings,
  type FastRefreshSettings,
  type OverviewLayout,
  type OverviewLayoutItem,
  type RefreshSpeed,
  type SessionIdle,
  type SessionIdleUnit,
  type SlowRefreshSettings,
  type Theme
} from './types'
import { asRecord, finiteInteger, isFiniteNumber, isRecord, oneOf, stringValue } from './validation'

const THEMES = ['dark', 'light', 'system'] as const satisfies readonly Theme[]
const DENSITIES = ['low', 'medium', 'high'] as const satisfies readonly Density[]
const REFRESH_SPEEDS = ['high', 'normal', 'low', 'paused'] as const satisfies readonly RefreshSpeed[]
const DETAIL_MODES = ['tab', 'always', 'off'] as const satisfies readonly DetailPollingMode[]
const IDLE_UNITS = ['minute', 'hour', 'day'] as const satisfies readonly SessionIdleUnit[]

/**
 * Bounds for values that eventually feed timers, storage retention or layout
 * calculations. UI-created values are well inside these ranges; the bounds
 * primarily protect hand-edited/imported JSON and non-finite numbers.
 */
export const APP_SETTINGS_LIMITS = {
  historyWindowSeconds: { min: 1, max: 31 * 24 * 60 * 60 },
  slowRefreshSeconds: { min: 0, max: 24 * 60 * 60 },
  historyRetentionHours: { min: 1, max: 365 * 24 },
  historyStorageMB: { min: 10, max: 100_000 },
  authMaxFailures: { min: 1, max: 1_000 },
  sessionIdleValue: { min: 0, max: 3_650 },
  allowedHosts: { maxEntries: 64, maxLength: 253 },
  layoutCoordinate: { min: 0, max: 1_000_000 },
  layoutWidth: { min: 1, max: 6 }
} as const

/** v2 card names -> current widget ids. */
const V2_CARD_IDS: Record<string, string> = {
  gpu: 'gpu.summary',
  docker: 'container.summary',
  sensors: 'sensors.summary',
  filesystems: 'disk.filesystems',
  gpuProcesses: 'gpu.processes',
  dockerCounts: 'container.resources'
}

/** v5 widget ids -> v6: Docker became the Container module. */
const V5_CARD_IDS: Record<string, string> = {
  'docker.summary': 'container.summary',
  'docker.resources': 'container.resources'
}

function schemaVersion(raw: Record<string, unknown>): number {
  const value = raw['settingsVersion']
  return isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  if (!isFiniteNumber(value)) return null
  const integer = Math.trunc(value)
  return integer >= min && integer <= max ? integer : null
}

/**
 * A settings allowlist entry is one hostname or IP address, never an
 * authority (no port), wildcard or URL.
 */
export function normalizeAllowedHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let hostname = value.trim().toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  if (
    hostname.length === 0 ||
    hostname.length > APP_SETTINGS_LIMITS.allowedHosts.maxLength ||
    /[\s/*@?#\\]/.test(hostname)
  ) {
    return null
  }

  if (hostname.includes(':')) {
    if (!/^[0-9a-f:.]+$/i.test(hostname)) return null
    try {
      const parsed = new URL(`http://[${hostname}]/`)
      return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    } catch {
      return null
    }
  }

  if (/^\d+(?:\.\d+){3}$/.test(hostname)) {
    const octets = hostname.split('.')
    return octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
      ? hostname
      : null
  }

  const labels = hostname.split('.')
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )
    ? hostname
    : null
}

function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.server.allowedHosts]
  const out: string[] = []
  for (const entry of value) {
    const hostname = normalizeAllowedHostname(entry)
    if (!hostname || out.includes(hostname)) continue
    out.push(hostname)
    if (out.length >= APP_SETTINGS_LIMITS.allowedHosts.maxEntries) break
  }
  return out
}

function renameIntervalKey(
  source: Record<string, unknown>,
  from: string,
  to: string
): void {
  if (!(from in source)) return
  if (!(to in source)) source[to] = source[from]
  delete source[from]
}

function normalizeRefresh(value: unknown): FastRefreshSettings {
  const out: FastRefreshSettings = { ...DEFAULT_SETTINGS.refresh }
  for (const [key, speed] of Object.entries(asRecord(value))) {
    if ((REFRESH_SPEEDS as readonly unknown[]).includes(speed)) {
      out[key] = speed as RefreshSpeed
    }
  }
  return out
}

function normalizeSlowRefresh(value: unknown): SlowRefreshSettings {
  const out: SlowRefreshSettings = { ...DEFAULT_SETTINGS.slowRefresh }
  for (const [key, seconds] of Object.entries(asRecord(value))) {
    const normalized = boundedInteger(
      seconds,
      APP_SETTINGS_LIMITS.slowRefreshSeconds.min,
      APP_SETTINGS_LIMITS.slowRefreshSeconds.max
    )
    if (normalized != null) out[key] = normalized
  }
  return out
}

function normalizeBooleanRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, enabled] of Object.entries(asRecord(value))) {
    if (typeof enabled === 'boolean') out[key] = enabled
  }
  return out
}

function normalizeCollectors(value: unknown): CollectorSettings {
  const raw = asRecord(value)
  const out = { ...DEFAULT_SETTINGS.collectors }
  for (const key of Object.keys(out) as Array<keyof CollectorSettings>) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key]
  }
  return out
}

function normalizeDetailPolling(value: unknown): DetailPollingSettings {
  const raw = asRecord(value)
  const out = { ...DEFAULT_SETTINGS.detailPolling }
  for (const key of Object.keys(out) as Array<keyof DetailPollingSettings>) {
    out[key] = oneOf(raw[key], DETAIL_MODES, out[key])
  }
  return out
}

function normalizeLayoutItem(value: unknown): OverviewLayoutItem | null {
  if (!isRecord(value)) return null
  const id = stringValue(value['i'], '', { allowEmpty: false, maxLength: 256 })
  const x = boundedInteger(
    value['x'],
    APP_SETTINGS_LIMITS.layoutCoordinate.min,
    APP_SETTINGS_LIMITS.layoutCoordinate.max
  )
  const y = boundedInteger(
    value['y'],
    APP_SETTINGS_LIMITS.layoutCoordinate.min,
    APP_SETTINGS_LIMITS.layoutCoordinate.max
  )
  const width = boundedInteger(
    value['w'],
    APP_SETTINGS_LIMITS.layoutWidth.min,
    APP_SETTINGS_LIMITS.layoutWidth.max
  )
  return id && x != null && y != null && width != null ? { i: id, x, y, w: width } : null
}

function normalizeLayout(value: unknown): OverviewLayout {
  const raw = asRecord(value)
  const out: OverviewLayout = {}
  for (const breakpoint of ['lg', 'md'] as const) {
    const items = raw[breakpoint]
    if (!Array.isArray(items)) continue
    const seen = new Set<string>()
    const normalized: OverviewLayoutItem[] = []
    for (const item of items) {
      const valid = normalizeLayoutItem(item)
      if (!valid || seen.has(valid.i)) continue
      seen.add(valid.i)
      normalized.push(valid)
    }
    out[breakpoint] = normalized
  }
  return out
}

function renameKeys<T>(source: Record<string, T>, ids: Record<string, string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(source)) out[ids[key] ?? key] = value
  return out
}

function renameLayout(layout: OverviewLayout, ids: Record<string, string>): OverviewLayout {
  const out: OverviewLayout = {}
  for (const breakpoint of ['lg', 'md'] as const) {
    const items = layout[breakpoint]
    if (!items) continue
    out[breakpoint] = items.map((item) => ({ ...item, i: ids[item.i] ?? item.i }))
  }
  return out
}

function migrateV2Widgets(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, enabled] of Object.entries(asRecord(value))) {
    if (typeof enabled === 'boolean') out[V2_CARD_IDS[key] ?? key] = enabled
  }
  return out
}

function normalizeIdle(value: unknown): SessionIdle {
  const raw = asRecord(value)
  return {
    value: finiteInteger(
      raw['value'],
      DEFAULT_SETTINGS.auth.sessionIdle.value,
      APP_SETTINGS_LIMITS.sessionIdleValue
    ),
    unit: oneOf(raw['unit'], IDLE_UNITS, DEFAULT_SETTINGS.auth.sessionIdle.unit)
  }
}

/**
 * Bring settings from disk, imports or RPC into the complete current shape.
 * Unknown/ill-typed fields are dropped, module-owned interval/widget keys are
 * retained when valid, and old schema names are migrated before validation.
 */
export function normalizeAppSettings(value: unknown): AppSettings {
  const raw = asRecord(value)
  const version = schemaVersion(raw)
  const fromV2 = version < 3
  const fromV3 = version < 4
  const fromV4 = version < 5
  const fromV5 = version < 6

  const fileRefresh = { ...asRecord(raw['refresh']) }
  const fileSlowRefresh = { ...asRecord(raw['slowRefresh']) }
  if (fromV5) {
    renameIntervalKey(fileRefresh, 'docker', 'container')
    renameIntervalKey(fileSlowRefresh, 'docker', 'container')
  }
  const refresh = normalizeRefresh(fileRefresh)
  const slowRefresh = normalizeSlowRefresh(fileSlowRefresh)
  if (raw['slowRefresh'] == null) {
    const legacySlow = boundedInteger(
      raw['refreshSlow'],
      APP_SETTINGS_LIMITS.slowRefreshSeconds.min,
      APP_SETTINGS_LIMITS.slowRefreshSeconds.max
    )
    if (legacySlow != null) slowRefresh.storage = legacySlow
  }

  let overviewWidgets = normalizeBooleanRecord(raw['overviewWidgets'])
  if (fromV2) Object.assign(overviewWidgets, migrateV2Widgets(raw['overviewExtended']))
  else if (fromV5) overviewWidgets = renameKeys(overviewWidgets, V5_CARD_IDS)

  let overviewLayout = normalizeLayout(raw['overviewLayout'])
  if (fromV2) overviewLayout = renameLayout(overviewLayout, V2_CARD_IDS)
  else if (fromV5) overviewLayout = renameLayout(overviewLayout, V5_CARD_IDS)

  const historyRaw = asRecord(raw['history'])
  const serverRaw = asRecord(raw['server'])
  const authRaw = asRecord(raw['auth'])
  const updateRaw = asRecord(raw['update'])
  const update = {
    repo: stringValue(updateRaw['repo'], DEFAULT_SETTINGS.update.repo, {
      allowEmpty: false,
      maxLength: 512
    }),
    lastUrl: stringValue(updateRaw['lastUrl'], DEFAULT_SETTINGS.update.lastUrl, {
      maxLength: 8_192
    })
  }
  if (fromV3 && typeof raw['lastUpdateUrl'] === 'string') {
    update.lastUrl = stringValue(raw['lastUpdateUrl'], update.lastUrl, { maxLength: 8_192 })
  }

  return {
    settingsVersion: SETTINGS_VERSION,
    theme: fromV4
      ? 'dark'
      : oneOf(raw['theme'], THEMES, DEFAULT_SETTINGS.theme),
    density: oneOf(raw['density'], DENSITIES, DEFAULT_SETTINGS.density),
    densityAutoDetected:
      typeof raw['densityAutoDetected'] === 'boolean'
        ? raw['densityAutoDetected']
        : DEFAULT_SETTINGS.densityAutoDetected,
    historyWindow: finiteInteger(
      raw['historyWindow'],
      DEFAULT_SETTINGS.historyWindow,
      APP_SETTINGS_LIMITS.historyWindowSeconds
    ),
    refresh,
    slowRefresh,
    overviewWidgets,
    overviewLayout,
    collectors: normalizeCollectors(raw['collectors']),
    detailPolling: normalizeDetailPolling(raw['detailPolling']),
    history: {
      enabled:
        typeof historyRaw['enabled'] === 'boolean'
          ? historyRaw['enabled']
          : DEFAULT_SETTINGS.history.enabled,
      retentionHours: finiteInteger(
        historyRaw['retentionHours'],
        DEFAULT_SETTINGS.history.retentionHours,
        APP_SETTINGS_LIMITS.historyRetentionHours
      ),
      maxStorageMB: finiteInteger(
        historyRaw['maxStorageMB'],
        DEFAULT_SETTINGS.history.maxStorageMB,
        APP_SETTINGS_LIMITS.historyStorageMB
      )
    },
    server: {
      port: finiteInteger(serverRaw['port'], DEFAULT_SETTINGS.server.port, {
        min: 1,
        max: 65_535
      }),
      host: stringValue(serverRaw['host'], DEFAULT_SETTINGS.server.host, {
        trim: true,
        allowEmpty: false,
        maxLength: 255
      }),
      allowedHosts: normalizeAllowedHosts(serverRaw['allowedHosts']),
      trustProxy:
        typeof serverRaw['trustProxy'] === 'boolean'
          ? serverRaw['trustProxy']
          : DEFAULT_SETTINGS.server.trustProxy,
      reconnectOnStart:
        typeof serverRaw['reconnectOnStart'] === 'boolean'
          ? serverRaw['reconnectOnStart']
          : DEFAULT_SETTINGS.server.reconnectOnStart
    },
    auth: {
      enabled:
        typeof authRaw['enabled'] === 'boolean'
          ? authRaw['enabled']
          : DEFAULT_SETTINGS.auth.enabled,
      maxFailures: finiteInteger(
        authRaw['maxFailures'],
        DEFAULT_SETTINGS.auth.maxFailures,
        APP_SETTINGS_LIMITS.authMaxFailures
      ),
      sessionIdle: normalizeIdle(authRaw['sessionIdle'])
    },
    update
  }
}

/**
 * What one settings control changes. The nested groups are merged over what is
 * already stored, so a card can save one field without restating the rest -
 * which is the point: a full-document write from a browser holding a stale copy
 * silently reverts every change made since it loaded.
 */
export type SettingsPatch = Partial<Omit<AppSettings, 'server' | 'auth' | 'update'>> & {
  server?: Partial<AppSettings['server']>
  auth?: Partial<AppSettings['auth']>
  update?: Partial<AppSettings['update']>
}

/**
 * Apply a patch to the settings in force. Every nested group is merged rather
 * than replaced; the flat fields are taken as given. The result still goes
 * through `normalizeAppSettings` before it is stored, so a patch cannot smuggle
 * a value the schema would reject.
 *
 * This runs on the server, against the document the server holds. Merging in
 * the browser - which is where it used to happen - meant merging into whatever
 * copy that tab loaded, however long ago.
 */
export function applySettingsPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    ...current,
    ...patch,
    refresh: { ...current.refresh, ...(patch.refresh ?? {}) },
    slowRefresh: { ...current.slowRefresh, ...(patch.slowRefresh ?? {}) },
    overviewWidgets: { ...current.overviewWidgets, ...(patch.overviewWidgets ?? {}) },
    // The layout is one value, not a set of keys: a drag rewrites the whole
    // arrangement for that breakpoint, and merging would resurrect cards the
    // user just moved away.
    overviewLayout: patch.overviewLayout ?? current.overviewLayout,
    collectors: { ...current.collectors, ...(patch.collectors ?? {}) },
    detailPolling: { ...current.detailPolling, ...(patch.detailPolling ?? {}) },
    history: { ...current.history, ...(patch.history ?? {}) },
    server: { ...current.server, ...(patch.server ?? {}) },
    auth: { ...current.auth, ...(patch.auth ?? {}) },
    update: { ...current.update, ...(patch.update ?? {}) }
  }
}
