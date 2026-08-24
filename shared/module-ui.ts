// The declarative UI a module ships instead of React: a page or widget is a
// tree of `Block`s, each one naming where its data comes from (`DataSource`)
// and, for the interactive ones, which of the module's own methods it may
// call. The app renders this itself (src/modules/BlockRenderer.tsx); nothing
// here executes - it is read, validated (`specProblems`) and walked.
import type { ModuleManifest } from './modules'
import { CORE_HISTORY_STREAMS, ownsHistoryStream } from './modules'
import { isRecord } from './validation'

/**
 * How a raw value is printed. Maps 1-1 to formatBytes/Rate/Pct/Temp/Duration in
 * src/lib/utils.ts. Three are odd ones out: `duration`'s raw value is an
 * absolute `startedAt`-style ms timestamp, not an elapsed amount - a block
 * cannot compute `Date.now() - value` itself, so the formatter does it;
 * `time`/`datetime` are the same idea for a clock reading rather than an
 * elapsed amount - a module should always emit the raw epoch ms and let one
 * of these two format it, never pre-format a timestamp into a string itself
 * (that bakes in the server's own locale/timezone, not the viewer's); and
 * `badges` does not produce text at all, so it is only useful where a block
 * renders cells rather than a single string (table, list, keyValue).
 */
export type ValueFormat =
  | 'bytes'
  | 'rate'
  | 'pct'
  | 'temp'
  | 'number'
  | 'text'
  | 'duration'
  | 'time'
  | 'datetime'
  | 'badges'

/** The value behind a `badges`-formatted cell: chips, each with an optional colour. */
export interface ValueBadge {
  label: string
  /** Any CSS colour; omit for the neutral chip. */
  color?: string
}

/**
 * The swatches a `color` form field offers. Colours a user picks for their own
 * labels cannot come from the theme tokens - they have to survive a theme
 * switch and be stored as data - so this is the one place literal hex belongs.
 * Shared so a module choosing a colour on the user's behalf picks from the
 * same twelve the form shows.
 */
export const FORM_COLOR_SWATCHES: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
]

/**
 * Where a block's data comes from.
 *
 * - `stream`: mirrors one of the module's declared `streams` (series or
 *   latest, per the manifest) out of the renderer's module bus.
 * - `invoke`: calls one of the module's `methods` and re-polls it on
 *   `intervalKey`'s configured speed while the block is visible; omit
 *   `intervalKey` to call it once on mount/visible.
 * - `history`: reads a downsampled series back from the metrics history on
 *   disk (src/lib/history.ts). `liveEvent` names the module's own `series`
 *   stream that feeds the tail between refetches - it defaults to the
 *   module's one declared `series` stream, so it is only needed when a
 *   module has more than one. Limited to the module's own streams and the
 *   app's - see checkSource.
 * - `core`: one of the app's own streams - system metrics, top consumers, or
 *   (Phase 5) the services tracker - rather than anything the module itself emits.
 *
 * `path` is a dot-path into the resolved value (e.g. `"mem.used"`), applied
 * by the binding resolver (src/modules/binding.ts); arrays are indexable
 * (`"gpus.0.temp"`).
 */
export type DataSource =
  | { kind: 'stream'; event: string; path?: string }
  | { kind: 'invoke'; method: string; args?: unknown[]; intervalKey?: string; path?: string }
  | { kind: 'history'; stream: string; keys: string[]; liveEvent?: string }
  | { kind: 'core'; stream: 'system' | 'top' | 'services'; path?: string }

export interface ActionPrompt {
  label: string
  input: 'number' | 'text'
  /** Row key to prefill the prompt's value from. */
  initialKey?: string
}

/** A button that calls one of the module's methods, optionally with confirmation or a prompt. */
export interface ActionSpec {
  label: string
  /** Must be one of `manifest.methods`. */
  method: string
  /** Row/scope keys to read positional args from - the row's identity, so these come first (`kill(pid, ...)`, `containerAction(id, ...)`). */
  argsFromRow?: string[]
  /** Literal args, sent after `argsFromRow` and before the prompt/form values (`containerAction(id, "stop")`). */
  args?: unknown[]
  /** Question shown in a confirm dialog before the call is made. */
  confirm?: string
  /** `danger` styles the button and its confirm dialog as destructive. */
  kind?: 'default' | 'danger'
  /** Ask for one value (appended after `args`/`argsFromRow`) before calling. */
  prompt?: ActionPrompt
}

export interface SectionBlock {
  type: 'section'
  title?: string
  /** Grid columns for its own `blocks`; omit for a single column. */
  columns?: number
  /** Shows an IntervalBadge and a manual-refresh button wired to `metrics:refreshSlow`. */
  slowTarget?: string
  /** Resolved and shown as the age label next to `slowTarget`, instead of the button's own last-run bookkeeping. */
  slowAt?: DataSource
  blocks: Block[]
}

export interface SubnavBlock {
  type: 'subnav'
  items: Array<{
    id: string
    label: string
    icon?: string
    blocks: Block[]
  }>
  /** Id of the item shown first; defaults to the first item. */
  initial?: string
}

/** Static page-level guidance that does not need a data source. */
export interface NoteBlock {
  type: 'note'
  title?: string
  /** Each entry is rendered as one short paragraph. */
  lines: string[]
  /** Defaults to `info`. */
  tone?: 'info' | 'warning'
}

export interface StatBlock {
  type: 'stat'
  label: string
  source: DataSource
  format: ValueFormat
  /** Small trend chart under the value. */
  spark?: { source: DataSource; key: string }
}

export interface MeterBlock {
  type: 'meter'
  label: string
  source: DataSource
  format?: ValueFormat
  max?: number
}

/**
 * Swatches a `chart` series may name. Same tokens as the renderer palette
 * (`src/components/charts/chart-colors.ts`); listed here so a spec can be
 * checked without importing the UI layer.
 */
export const CHART_SERIES_COLORS = [
  'primary',
  'cpu',
  'mem',
  'gpu',
  'docker',
  'net',
  'disk',
  'download',
  'upload',
  'success',
  'warning',
  'destructive',
  'muted'
] as const

export type ChartSeriesColor = (typeof CHART_SERIES_COLORS)[number]

export interface ChartSeriesDecl {
  /** Key inside the resolved data point. */
  key: string
  label: string
  /** Only used when the chart has no `format` - a literal suffix with no scaling (e.g. "RPM"). */
  unit?: string
  /** Which Y-axis this series uses. Omit for the left axis (the only axis on a single-scale chart). */
  axis?: 'left' | 'right'
  /** How this series' axis and tooltip print a value. Overrides the chart-level `format`. */
  format?: ValueFormat
  /** Paint token; omit to take the next colour from the block palette. */
  color?: ChartSeriesColor
}

export interface ChartBlock {
  type: 'chart'
  title?: string
  kind: 'line' | 'area' | 'bar'
  source: DataSource
  /**
   * Declared series when the keys are known at spec time. Omit to take every
   * numeric key on the last point except `t` (machine-dependent sensors).
   */
  series?: ChartSeriesDecl[]
  /** Cap when inferring series from keys. Ignored when `series` is declared. */
  maxSeries?: number
  /**
   * Literal suffix when the chart has no `format` and series are inferred
   * (so there is no per-series `unit`). Declared series still prefer their own.
   */
  unit?: string
  /** Decimal places for the unit suffix (or a raw number). Ignored when `format` is set. */
  decimals?: number
  /** How the axis/tooltip prints a value - same formats as `stat`/`meter`. Omit for a raw number (or a series' own `unit` suffix). */
  format?: ValueFormat
  stacked?: boolean
  /** Seconds of history to show; omit to inherit the page/widget's window. */
  window?: number
}

/**
 * A slice of a `pie` block. Colour is a status, not a paint — same rule as
 * `statusCards`, so a theme switch does not leave a spec holding hex.
 */
export type PieSliceStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export interface PieSliceDecl {
  /** Key on the resolved object (e.g. `"online"` on `hosts.counts`). */
  key: string
  label: string
  status: PieSliceStatus
}

/**
 * A part-of-whole snapshot (counts by status). Not a `chart` kind: those are
 * time series of `{ t, … }`, and a pie cannot inherit a window or sparkline.
 */
export interface PieBlock {
  type: 'pie'
  source: DataSource
  slices: PieSliceDecl[]
  /** Number drawn in the donut hole. Omit to sum the slices. */
  center?: { key: string; label?: string }
  emptyText?: string
  format?: ValueFormat
}

export interface KeyValueRow {
  key: string
  label: string
  format?: ValueFormat
}

/** A fixed label/value list from one resolved object, e.g. an inspect panel. */
export interface KeyValueBlock {
  type: 'keyValue'
  source: DataSource
  rows: KeyValueRow[]
}

export interface ListColumn {
  key: string
  label?: string
  format?: ValueFormat
  align?: 'left' | 'right'
}

/** A short, unsorted, unfiltered list of rows - lighter than `table` for a Overview-sized widget. */
export interface ListBlock {
  type: 'list'
  source: DataSource
  columns: ListColumn[]
  /** Cap the number of rows shown; the source's own array is not truncated on disk. */
  limit?: number
  emptyText?: string
}

export interface TableColumn {
  key: string
  label: string
  format?: ValueFormat
  align?: 'left' | 'right'
  /** Defaults to true. */
  sortable?: boolean
  /** Show a group's total for this column instead of leaving it blank. */
  aggregate?: boolean
}

export interface TableGroupMode {
  id: string
  label: string
  /** Column key to group by; combined with `parentIdKey` this becomes a tree. */
  key: string
  /** Row key that names a row's own id, for matching against `key` on other rows. */
  parentIdKey?: string
}

export interface TableSortDefault {
  key: string
  dir: 'asc' | 'desc'
}

export interface TableBlock {
  type: 'table'
  source: DataSource
  columns: TableColumn[]
  /**
   * Row field used for React keys and for matching a `rowDetail` drawer back
   * to its row on every fresh poll. Defaults to the first column's key - set
   * this explicitly when no displayed column is unique on its own (several
   * connections can share a local port, several processes can share a GPU
   * index, several tags can share an image id).
   */
  rowKey?: string
  sortDefault?: TableSortDefault
  /** Columns the text filter searches; defaults to every text column. */
  filterKeys?: string[]
  groupModes?: TableGroupMode[]
  rowActions?: ActionSpec[]
  /**
   * Adds a tick column and a toolbar for `bulkActions`. Requires an explicit
   * `rowKey`: a selection is a list of those keys, so a column that repeats
   * would act on rows the user did not tick.
   */
  selectable?: boolean
  /**
   * Buttons that act on the ticked rows, called as
   * `method(selectedRowKeys[], ...args, promptValue?)`. The array of keys comes
   * first, before the spec's own `args` - `argsFromRow` means nothing here
   * because there is no single row.
   */
  bulkActions?: ActionSpec[]
  /** Blocks rendered in a drawer when a row is clicked, scoped to that row (`$row.*`). */
  rowDetail?: Block[]
  emptyText?: string
}

/**
 * A live-tailed event, not a declared stream: it does not have to be in
 * `manifest.streams`. `startMethod`/`stopMethod`, when present, must be in
 * `manifest.methods`.
 */
export interface LogBlock {
  type: 'log'
  event: string
  startMethod?: string
  stopMethod?: string
  /** Field names read off the current scope (e.g. `["id"]` for a table row) and passed as args to start/stop, in order. */
  argsFromScope?: string[]
}

/** Opens an embedded terminal running a command built from the current scope. */
export interface TerminalBlock {
  type: 'terminal'
  label: string
  /** `{{key}}` placeholders are filled from the current scope. */
  commandTemplate: string
}

export interface ActionsBlock {
  type: 'actions'
  actions: ActionSpec[]
}

export interface FormFieldOption {
  value: string
  label: string
}

/**
 * `color` is a hex string plus a swatch picker; leaving it empty is meaningful
 * (a module is free to read that as "pick one for me"). `password` only hides
 * the typing - it is sent over the same channel as everything else.
 */
export type FormInput =
  | 'number'
  | 'text'
  | 'select'
  | 'checkbox'
  | 'password'
  | 'textarea'
  | 'file'
  | 'color'

export interface FormField {
  key: string
  label: string
  input: FormInput
  /** `select` only: the fixed choices. */
  options?: FormFieldOption[]
  /**
   * `select` only: choices asked of the module instead of listed here, so a
   * form can offer what actually exists on the target machine. Must resolve to
   * an `Array<{ value, label }>`; read once when the block first becomes visible.
   */
  optionsFrom?: DataSource
  /** `file` only: browser file-picker filter; defaults to `.txt`. */
  accept?: string
  /** `file` only: maximum file size in KiB; defaults to 1024. */
  maxKb?: number
  /** `checkForm` only: send an empty value on apply after the check froze it. */
  omitOnApply?: boolean
  placeholder?: string
  /** A line under the field saying what it is for. */
  help?: string
  /** What the field starts out as. */
  initial?: string | number | boolean
  /** Scope key (a table row's field) to start from, which wins over `initial`. */
  initialFromScope?: string
  /**
   * A source (usually the module's own stream) the field starts from, so a
   * form that edits a setting opens showing what is saved instead of the
   * spec's default - "Save" then means "change this", not "reset everything
   * I am not looking at".
   *
   * Read once, from the first value the source produces; after that the field
   * belongs to whoever is typing in it, so later ticks do not move the cursor
   * out from under them. `initialFromScope` (an open row) still wins over it.
   */
  initialFrom?: DataSource
}

export interface FormBlock {
  type: 'form'
  /** Heading above the fields; worth having when a drawer stacks several forms. */
  title?: string
  fields: FormField[]
  submit: ActionSpec
}

/**
 * Fields the user cannot apply until the module has looked at them and said
 * what would happen. `checkMethod` is called as
 * `method(...argsFromScope, values)` and answers a `ModuleCheckReport`
 * (shared/check.ts); the app shows its findings and only offers
 * `method(...argsFromScope, { token, values })` when the report said `ok`.
 * Editing any field throws the report away, so what is applied is always what
 * was read. Use `kind: 'danger'` for anything destructive - it turns the apply
 * button red and puts a confirm dialog in front of it.
 */
export interface CheckFormBlock {
  type: 'checkForm'
  title?: string
  fields: FormField[]
  /** Must be one of `manifest.methods`. */
  checkMethod: string
  /** Must be one of `manifest.methods`. */
  applyMethod: string
  /** Scope keys passed to both methods before the values object, in order. */
  argsFromScope?: string[]
  checkLabel?: string
  applyLabel?: string
  kind?: 'default' | 'danger'
}

/**
 * One tinted card per array item, for a fleet-style status wall where the
 * number of cards is data rather than spec. `table` cannot do this: it has one
 * row per item and no data-driven colour.
 */
export interface StatusCardsBlock {
  type: 'statusCards'
  source: DataSource
  /** Field holding the card's own id - React key, and the drawer's identity across refreshes. */
  rowKey: string
  /** Field printed in the title row. */
  titleKey: string
  /** Field holding `ok` | `warn` | `bad` | `unknown`; tints the title row. */
  statusKey: string
  /** Field with a short right-aligned summary in the title row ("3/4 running"). */
  subtitleKey?: string
  /** A collapsible line under the title, for what the module knows about this item. */
  note?: { key: string; label?: string; startOpen?: boolean }
  /**
   * The chips inside the card. `key` is an array of `{ label, status, pinned? }`.
   *
   * A chip whose entry carries `formatKey` (default `'format'`) renders
   * differently: `labelKey` becomes a static prefix (may be empty) and the
   * raw value at `valueKey` (default `'value'`) is formatted through it, so
   * e.g. `{ label: 'seen', value: 1712345678000, format: 'time' }` reads
   * "seen 14:32:10" in the viewer's own locale instead of a module baking a
   * server-locale string into `label` itself.
   */
  items: {
    key: string
    /** Chip rows shown before the expand arrow; default 2. */
    visibleRows?: number
    labelKey?: string
    statusKey?: string
    pinnedKey?: string
    /** Field holding a `ValueFormat`, when this chip's label is a formatted value rather than plain text. */
    formatKey?: string
    /** Field holding the raw value to format, read only when `formatKey` resolves to a format. */
    valueKey?: string
    /** Adds a "pinned only" switch to the toolbar, filtering chips by `pinnedKey`. */
    pinnedFilterLabel?: string
    emptyText?: string
  }
  /** Card columns the user can change at runtime. */
  columns?: { default?: number; min?: number; max?: number }
  rowActions?: ActionSpec[]
  /** Blocks in a drawer when a card is clicked, scoped to that item (`$row.*`). */
  rowDetail?: Block[]
  emptyText?: string
}

export interface ConditionalWhen {
  source: DataSource
  path?: string
  op: 'exists' | 'eq' | 'gt'
  value?: unknown
}

/** Shows one of two block lists depending on the resolved data - e.g. "tool missing" copy. */
export interface ConditionalBlock {
  type: 'conditional'
  when: ConditionalWhen
  blocks: Block[]
  else?: Block[]
}

export type Block =
  | SectionBlock
  | SubnavBlock
  | NoteBlock
  | StatBlock
  | MeterBlock
  | ChartBlock
  | PieBlock
  | KeyValueBlock
  | ListBlock
  | TableBlock
  | StatusCardsBlock
  | LogBlock
  | TerminalBlock
  | ActionsBlock
  | FormBlock
  | CheckFormBlock
  | ConditionalBlock

/** `ui/pages/<pageId>.json` - one sidebar page. */
export interface PageSpec {
  blocks: Block[]
}

/** `ui/widgets/<widgetId>.json` - one Overview card. */
export interface WidgetSpec {
  blocks: Block[]
  /** Seconds of history charts inside it show; omit to inherit the Overview's own window. */
  window?: number
}

/** The `modules:specs` payload: one entry per enabled module, keyed by page/widget id. */
export interface ModuleSpecsEntry {
  id: string
  manifest: ModuleManifest
  pages: Record<string, PageSpec>
  widgets: Record<string, WidgetSpec>
  /**
   * Present for a declared page whose spec failed to load (no file, invalid
   * JSON, or `specProblems` findings) - so the id is not silently missing from
   * `pages` for no visible reason. Keyed by page id, value is a human-readable
   * reason.
   */
  pageProblems: Record<string, string>
  /** Same as `pageProblems`, for declared widgets missing from `widgets`. */
  widgetProblems: Record<string, string>
}

const BLOCK_TYPES = new Set<Block['type']>([
  'section',
  'subnav',
  'note',
  'stat',
  'meter',
  'chart',
  'pie',
  'keyValue',
  'list',
  'table',
  'statusCards',
  'log',
  'terminal',
  'actions',
  'form',
  'checkForm',
  'conditional'
])

// Kept in sync with the explicit renderer map in src/lib/module-registry.ts.
// Shared validation cannot import the renderer bundle.
const MODULE_ICON_NAMES = new Set<string>([
  'Activity',
  'Boxes',
  'Cable',
  'Container',
  'Cpu',
  'FileText',
  'FolderTree',
  'Gauge',
  'HardDrive',
  'Info',
  'Layers',
  'ListTree',
  'Network',
  'Server',
  'Settings2',
  'Sparkles',
  'Tag',
  'Thermometer',
  'Zap'
])

const CHART_SERIES_COLOR_SET = new Set<string>(CHART_SERIES_COLORS)

const VALUE_FORMATS = new Set<ValueFormat>([
  'bytes',
  'rate',
  'pct',
  'temp',
  'number',
  'text',
  'duration',
  'time',
  'datetime',
  'badges'
])

const FORM_INPUTS = new Set<FormInput>([
  'number',
  'text',
  'select',
  'checkbox',
  'password',
  'textarea',
  'file',
  'color'
])

const MAX_SPEC_BLOCKS = 20_000
const MAX_SPEC_DEPTH = 64
const MAX_COLLECTION_ITEMS = 10_000

/** Blocks nested inside `blocks`/`rowDetail`/`else`; walked to check they never reference a CDN. */
function nestedBlockArrays(block: Record<string, unknown>): Array<{ path: string; blocks: unknown[] }> {
  const out: Array<{ path: string; blocks: unknown[] }> = []
  const blocks = block['blocks']
  const rowDetail = block['rowDetail']
  const elseBlocks = block['else']
  const items = block['items']
  if (Array.isArray(blocks)) out.push({ path: 'blocks', blocks })
  if (Array.isArray(rowDetail)) out.push({ path: 'rowDetail', blocks: rowDetail })
  if (Array.isArray(elseBlocks)) out.push({ path: 'else', blocks: elseBlocks })
  if (Array.isArray(items)) {
    for (const [index, item] of items.entries()) {
      if (isRecord(item) && Array.isArray(item['blocks'])) {
        out.push({ path: `items[${index}].blocks`, blocks: item['blocks'] })
      }
    }
  }
  return out
}

function pushIf(problems: string[], condition: boolean, message: string): void {
  if (condition) problems.push(message)
}

function checkRequiredString(problems: string[], where: string, value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) problems.push(`${where} is missing`)
}

function checkOptionalString(problems: string[], where: string, value: unknown): void {
  if (value != null && typeof value !== 'string') problems.push(`${where} is not a string`)
}

function checkOptionalBoolean(problems: string[], where: string, value: unknown): void {
  if (value != null && typeof value !== 'boolean') problems.push(`${where} is not a boolean`)
}

function checkOptionalFiniteNumber(
  problems: string[],
  where: string,
  value: unknown,
  options: { min?: number; max?: number; integer?: boolean } = {}
): void {
  if (value == null) return
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.min != null && value < options.min) ||
    (options.max != null && value > options.max)
  ) {
    problems.push(`${where} is not a valid number`)
  }
}

function checkStringArray(
  problems: string[],
  where: string,
  value: unknown,
  options: { required?: boolean; nonEmpty?: boolean } = {}
): value is string[] {
  if (value == null && options.required !== true) return false
  if (
    !Array.isArray(value) ||
    (options.nonEmpty === true && value.length === 0) ||
    value.some((item) => typeof item !== 'string' || !item)
  ) {
    problems.push(`${where} is not an array of non-empty strings`)
    return false
  }
  if (value.length > MAX_COLLECTION_ITEMS) problems.push(`${where} contains too many items`)
  return true
}

function checkObjectArray(
  problems: string[],
  where: string,
  value: unknown,
  options: { required?: boolean; nonEmpty?: boolean } = {}
): value is unknown[] {
  if (value == null && options.required !== true) return false
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)) {
    problems.push(`${where} is not a${options.nonEmpty === true ? ' non-empty' : 'n'} array`)
    return false
  }
  if (value.length > MAX_COLLECTION_ITEMS) problems.push(`${where} contains too many items`)
  return true
}

function checkFormat(problems: string[], where: string, format: unknown): void {
  if (format != null && !VALUE_FORMATS.has(format as ValueFormat)) {
    problems.push(`${where}: "${String(format)}" is not a value format`)
  }
}

/** `where` names the source field itself (`blocks[0].source`, `...fields[1].optionsFrom`). */
function checkSource(problems: string[], where: string, source: unknown, manifest: ModuleManifest): void {
  if (!isRecord(source)) {
    problems.push(`${where} is missing`)
    return
  }
  const s = source
  const streams = Array.isArray(manifest.streams) ? manifest.streams : []
  const streamEvents = new Set(streams.filter(isRecord).map((x) => x['event']))
  const kind = s['kind']
  switch (kind) {
    case 'stream': {
      const event = s['event']
      const known = typeof event === 'string' && streamEvents.has(event)
      if (!known) problems.push(`${where}: stream "${String(event)}" is not declared in manifest.streams`)
      checkOptionalString(problems, `${where}.path`, s['path'])
      break
    }
    case 'invoke':
      checkMethod(problems, where, s['method'], manifest)
      if (s['args'] != null && !Array.isArray(s['args'])) {
        problems.push(`${where}.args is not an array`)
      }
      checkOptionalString(problems, `${where}.intervalKey`, s['intervalKey'])
      checkOptionalString(problems, `${where}.path`, s['path'])
      break
    case 'history': {
      // A module may chart its own history, or one of the app's own streams
      // behind a comparison. Naming a third module's stream is the one case
      // refused: that module can be uninstalled, and reading the chart of
      // something the user removed is not a dependency worth having.
      const stream = s['stream']
      if (typeof stream !== 'string' || !stream) {
        problems.push(`${where}.stream is missing`)
      } else if (
        !ownsHistoryStream(manifest.id, stream) &&
        !(CORE_HISTORY_STREAMS as readonly string[]).includes(stream)
      ) {
        problems.push(
          `${where}: history stream "${stream}" belongs to another module - use "${manifest.id}", "${manifest.id}-<name>", or one of ${CORE_HISTORY_STREAMS.join(', ')}`
        )
      }
      checkStringArray(problems, `${where}.keys`, s['keys'], { required: true, nonEmpty: true })
      const liveEvent = s['liveEvent']
      if (liveEvent != null) {
        const decl = streams.filter(isRecord).find((x) => x['event'] === liveEvent)
        if (!decl) {
          problems.push(`${where}.liveEvent: stream "${String(liveEvent)}" is not declared in manifest.streams`)
        } else if (decl['kind'] !== 'series') {
          problems.push(`${where}.liveEvent: stream "${String(liveEvent)}" is not a "series" stream`)
        }
      }
      break
    }
    case 'core': {
      const stream = s['stream']
      if (stream !== 'system' && stream !== 'top' && stream !== 'services') {
        problems.push(`${where}: "${String(stream)}" is not a core stream (system, top, services)`)
      }
      checkOptionalString(problems, `${where}.path`, s['path'])
      break
    }
    default:
      problems.push(`${where}.kind "${String(kind)}" is not a data source kind`)
  }
}

function checkMethod(problems: string[], where: string, method: unknown, manifest: ModuleManifest): void {
  const methods = new Set(Array.isArray(manifest.methods) ? manifest.methods : [])
  const known = typeof method === 'string' && methods.has(method)
  if (!known) problems.push(`${where}: method "${String(method)}" is not declared in manifest.methods`)
}

function checkAction(problems: string[], where: string, action: unknown, manifest: ModuleManifest): void {
  if (!isRecord(action)) {
    problems.push(`${where} is not an object`)
    return
  }
  const a = action
  checkRequiredString(problems, `${where}.label`, a['label'])
  checkMethod(problems, where, a['method'], manifest)
  checkStringArray(problems, `${where}.argsFromRow`, a['argsFromRow'])
  if (a['args'] != null && !Array.isArray(a['args'])) problems.push(`${where}.args is not an array`)
  checkOptionalString(problems, `${where}.confirm`, a['confirm'])
  if (a['kind'] != null && a['kind'] !== 'default' && a['kind'] !== 'danger') {
    problems.push(`${where}.kind must be default or danger`)
  }
  const prompt = a['prompt']
  if (prompt != null) {
    if (!isRecord(prompt)) {
      problems.push(`${where}.prompt is not an object`)
    } else {
      checkRequiredString(problems, `${where}.prompt.label`, prompt['label'])
      if (prompt['input'] !== 'number' && prompt['input'] !== 'text') {
        problems.push(`${where}.prompt.input must be number or text`)
      }
      checkOptionalString(problems, `${where}.prompt.initialKey`, prompt['initialKey'])
    }
  }
}

/** The field list shared by `form` and `checkForm`. */
function checkFields(problems: string[], where: string, fields: unknown, manifest: ModuleManifest): void {
  if (!Array.isArray(fields) || fields.length === 0) {
    problems.push(`${where} is empty`)
    return
  }
  const seen = new Set<string>()
  for (const [i, field] of fields.entries()) {
    const at = `${where}[${i}]`
    if (!isRecord(field)) {
      problems.push(`${at} is not an object`)
      continue
    }
    const f = field
    const key = f['key']
    if (typeof key !== 'string' || !key) problems.push(`${at}.key is missing`)
    // Values are collected into one object per form, so a repeated key would
    // silently drop a field the user filled in.
    else if (seen.has(key)) problems.push(`${at}.key "${key}" is used twice`)
    else seen.add(key)
    const input = f['input']
    if (!FORM_INPUTS.has(input as FormInput)) {
      problems.push(`${at}.input "${String(input)}" is not a form input`)
    }
    if (f['optionsFrom'] != null) {
      if (input !== 'select') problems.push(`${at}.optionsFrom only applies to a select`)
      checkSource(problems, `${at}.optionsFrom`, f['optionsFrom'], manifest)
    }
    if (f['accept'] != null) {
      if (input !== 'file') problems.push(`${at}.accept only applies to a file input`)
      checkOptionalString(problems, `${at}.accept`, f['accept'])
    }
    if (f['maxKb'] != null) {
      if (input !== 'file') problems.push(`${at}.maxKb only applies to a file input`)
      checkOptionalFiniteNumber(problems, `${at}.maxKb`, f['maxKb'], { min: 1 })
    }
    checkOptionalBoolean(problems, `${at}.omitOnApply`, f['omitOnApply'])
    checkRequiredString(problems, `${at}.label`, f['label'])
    checkOptionalString(problems, `${at}.placeholder`, f['placeholder'])
    checkOptionalString(problems, `${at}.help`, f['help'])
    checkOptionalString(problems, `${at}.initialFromScope`, f['initialFromScope'])
    if (f['initialFrom'] != null) checkSource(problems, `${at}.initialFrom`, f['initialFrom'], manifest)
    const initial = f['initial']
    if (
      initial != null &&
      typeof initial !== 'string' &&
      typeof initial !== 'number' &&
      typeof initial !== 'boolean'
    ) {
      problems.push(`${at}.initial has an unsupported type`)
    }
    const options = f['options']
    if (options != null) {
      if (input !== 'select') problems.push(`${at}.options only applies to a select`)
      if (checkObjectArray(problems, `${at}.options`, options, { nonEmpty: true })) {
        for (const [optionIndex, option] of options.entries()) {
          const optionAt = `${at}.options[${optionIndex}]`
          if (!isRecord(option)) {
            problems.push(`${optionAt} is not an object`)
            continue
          }
          checkRequiredString(problems, `${optionAt}.value`, option['value'])
          checkRequiredString(problems, `${optionAt}.label`, option['label'])
        }
      }
    }
    if (options != null && f['optionsFrom'] != null) {
      problems.push(`${at} cannot declare both options and optionsFrom`)
    }
  }
}

/** Checks one block's own fields (not its nested block arrays, done by the caller). */
function checkBlock(problems: string[], where: string, block: unknown, manifest: ModuleManifest): void {
  if (!isRecord(block)) {
    problems.push(`${where} is not an object`)
    return
  }
  const b = block
  const type = b['type']
  if (typeof type !== 'string' || !BLOCK_TYPES.has(type as Block['type'])) {
    problems.push(`${where}.type "${String(type)}" is not a known block type`)
    return
  }

  switch (type as Block['type']) {
    case 'section':
      checkObjectArray(problems, `${where}.blocks`, b['blocks'], { required: true })
      checkOptionalString(problems, `${where}.title`, b['title'])
      checkOptionalString(problems, `${where}.slowTarget`, b['slowTarget'])
      if (b['slowAt'] != null) checkSource(problems, `${where}.slowAt`, b['slowAt'], manifest)
      checkOptionalFiniteNumber(problems, `${where}.columns`, b['columns'], {
        min: 1,
        max: 4,
        integer: true
      })
      break
    case 'subnav': {
      const items = b['items']
      const ids = new Set<string>()
      if (!Array.isArray(items) || items.length < 1 || items.length > 32) {
        problems.push(`${where}.items must be an array of 1 to 32 items`)
      }
      for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
        const at = `${where}.items[${index}]`
        if (!isRecord(item)) {
          problems.push(`${at} is not an object`)
          continue
        }
        const id = item['id']
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
          problems.push(`${at}.id is not a valid subnav id`)
        } else if (ids.has(id)) {
          problems.push(`${at}.id "${id}" is used twice`)
        } else {
          ids.add(id)
        }
        checkRequiredString(problems, `${at}.label`, item['label'])
        if (
          item['icon'] != null &&
          (typeof item['icon'] !== 'string' || !MODULE_ICON_NAMES.has(item['icon']))
        ) {
          problems.push(`${at}.icon "${String(item['icon'])}" is not a module icon`)
        }
        checkObjectArray(problems, `${at}.blocks`, item['blocks'], { required: true })
      }
      if (b['initial'] != null) {
        if (typeof b['initial'] !== 'string' || !ids.has(b['initial'])) {
          problems.push(`${where}.initial must name a subnav item`)
        }
      }
      break
    }
    case 'note': {
      checkOptionalString(problems, `${where}.title`, b['title'])
      const lines = b['lines']
      if (
        !Array.isArray(lines) ||
        lines.length < 1 ||
        lines.length > 32 ||
        lines.some((line) => typeof line !== 'string' || !line.trim())
      ) {
        problems.push(`${where}.lines must be an array of 1 to 32 non-empty strings`)
      }
      if (b['tone'] != null && b['tone'] !== 'info' && b['tone'] !== 'warning') {
        problems.push(`${where}.tone must be info or warning`)
      }
      break
    }
    case 'stat':
    case 'meter':
      pushIf(problems, typeof b['label'] !== 'string' || !b['label'], `${where}.label is missing`)
      checkSource(problems, `${where}.source`, b['source'], manifest)
      checkFormat(problems, where, b['format'])
      if (type === 'stat') {
        const spark = b['spark']
        if (spark != null) {
          if (!isRecord(spark)) problems.push(`${where}.spark is not an object`)
          else {
            checkSource(problems, `${where}.spark.source`, spark['source'], manifest)
            checkRequiredString(problems, `${where}.spark.key`, spark['key'])
          }
        }
      } else {
        checkOptionalFiniteNumber(problems, `${where}.max`, b['max'])
      }
      break
    case 'chart': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      pushIf(
        problems,
        b['kind'] !== 'line' && b['kind'] !== 'area' && b['kind'] !== 'bar',
        `${where}.kind must be line, area or bar`
      )
      const series = b['series']
      // Omit series to infer keys from the last point; an empty array is still
      // a mistake (the author listed series and then left them blank).
      if (series !== undefined) {
        pushIf(problems, !Array.isArray(series) || series.length === 0, `${where}.series is empty`)
      }
      let hasRightAxis = false
      if (Array.isArray(series)) {
        for (const [i, item] of series.entries()) {
          const at = `${where}.series[${i}]`
          if (!isRecord(item)) {
            problems.push(`${at} is not an object`)
            continue
          }
          const s = item
          checkRequiredString(problems, `${at}.key`, s['key'])
          checkRequiredString(problems, `${at}.label`, s['label'])
          checkOptionalString(problems, `${at}.unit`, s['unit'])
          if (s['axis'] != null && s['axis'] !== 'left' && s['axis'] !== 'right') {
            problems.push(`${at}.axis must be left or right`)
          }
          if (s['axis'] === 'right') hasRightAxis = true
          checkFormat(problems, at, s['format'])
          if (s['color'] != null && !CHART_SERIES_COLOR_SET.has(s['color'] as string)) {
            problems.push(`${at}.color "${String(s['color'])}" is not a chart colour`)
          }
        }
      }
      checkOptionalString(problems, `${where}.title`, b['title'])
      checkOptionalString(problems, `${where}.unit`, b['unit'])
      checkOptionalBoolean(problems, `${where}.stacked`, b['stacked'])
      checkOptionalFiniteNumber(problems, `${where}.window`, b['window'], { min: 1 })
      pushIf(
        problems,
        b['stacked'] === true && hasRightAxis,
        `${where}: stacked cannot be used with a right axis`
      )
      if (b['maxSeries'] != null) {
        const n = b['maxSeries']
        pushIf(
          problems,
          typeof n !== 'number' || !Number.isFinite(n) || n < 1,
          `${where}.maxSeries must be a positive number`
        )
      }
      if (b['decimals'] != null) {
        const n = b['decimals']
        pushIf(
          problems,
          typeof n !== 'number' || !Number.isFinite(n) || n < 0,
          `${where}.decimals must be a non-negative number`
        )
      }
      checkFormat(problems, where, b['format'])
      break
    }
    case 'pie': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      const slices = b['slices']
      pushIf(problems, !Array.isArray(slices) || slices.length === 0, `${where}.slices is empty`)
      for (const [i, slice] of (Array.isArray(slices) ? slices : []).entries()) {
        const at = `${where}.slices[${i}]`
        if (!isRecord(slice)) {
          problems.push(`${at} is not an object`)
          continue
        }
        const s = slice
        pushIf(problems, typeof s['key'] !== 'string' || !s['key'], `${at}.key is missing`)
        pushIf(problems, typeof s['label'] !== 'string' || !s['label'], `${at}.label is missing`)
        pushIf(
          problems,
          s['status'] !== 'ok' && s['status'] !== 'warn' && s['status'] !== 'bad' && s['status'] !== 'unknown',
          `${at}.status must be ok, warn, bad or unknown`
        )
      }
      const center = b['center']
      if (center != null) {
        if (!isRecord(center)) problems.push(`${where}.center is not an object`)
        else {
          pushIf(
            problems,
            typeof center['key'] !== 'string' || !center['key'],
            `${where}.center.key is missing`
          )
          checkOptionalString(problems, `${where}.center.label`, center['label'])
        }
      }
      checkOptionalString(problems, `${where}.emptyText`, b['emptyText'])
      checkFormat(problems, where, b['format'])
      break
    }
    case 'keyValue': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      const rows = b['rows']
      if (checkObjectArray(problems, `${where}.rows`, rows, { required: true, nonEmpty: true })) {
        for (const [index, row] of rows.entries()) {
          const at = `${where}.rows[${index}]`
          if (!isRecord(row)) {
            problems.push(`${at} is not an object`)
            continue
          }
          checkRequiredString(problems, `${at}.key`, row['key'])
          checkRequiredString(problems, `${at}.label`, row['label'])
          checkFormat(problems, at, row['format'])
        }
      }
      break
    }
    case 'list': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      const columns = b['columns']
      if (
        checkObjectArray(problems, `${where}.columns`, columns, {
          required: true,
          nonEmpty: true
        })
      ) {
        for (const [index, column] of columns.entries()) {
          const at = `${where}.columns[${index}]`
          if (!isRecord(column)) {
            problems.push(`${at} is not an object`)
            continue
          }
          checkRequiredString(problems, `${at}.key`, column['key'])
          checkOptionalString(problems, `${at}.label`, column['label'])
          checkFormat(problems, at, column['format'])
          if (column['align'] != null && column['align'] !== 'left' && column['align'] !== 'right') {
            problems.push(`${at}.align must be left or right`)
          }
        }
      }
      checkOptionalFiniteNumber(problems, `${where}.limit`, b['limit'], {
        min: 1,
        integer: true
      })
      checkOptionalString(problems, `${where}.emptyText`, b['emptyText'])
      break
    }
    case 'table': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      const columns = b['columns']
      const columnKeys = new Set<string>()
      if (
        checkObjectArray(problems, `${where}.columns`, columns, {
          required: true,
          nonEmpty: true
        })
      ) {
        for (const [index, column] of columns.entries()) {
          const at = `${where}.columns[${index}]`
          if (!isRecord(column)) {
            problems.push(`${at} is not an object`)
            continue
          }
          checkRequiredString(problems, `${at}.key`, column['key'])
          if (typeof column['key'] === 'string' && column['key']) columnKeys.add(column['key'])
          checkRequiredString(problems, `${at}.label`, column['label'])
          checkFormat(problems, at, column['format'])
          if (column['align'] != null && column['align'] !== 'left' && column['align'] !== 'right') {
            problems.push(`${at}.align must be left or right`)
          }
          checkOptionalBoolean(problems, `${at}.sortable`, column['sortable'])
          checkOptionalBoolean(problems, `${at}.aggregate`, column['aggregate'])
        }
      }
      checkOptionalString(problems, `${where}.rowKey`, b['rowKey'])
      checkStringArray(problems, `${where}.filterKeys`, b['filterKeys'])
      checkOptionalBoolean(problems, `${where}.selectable`, b['selectable'])
      checkOptionalString(problems, `${where}.emptyText`, b['emptyText'])
      const sortDefault = b['sortDefault']
      if (sortDefault != null) {
        if (!isRecord(sortDefault)) {
          problems.push(`${where}.sortDefault is not an object`)
        } else {
          checkRequiredString(problems, `${where}.sortDefault.key`, sortDefault['key'])
          if (sortDefault['dir'] !== 'asc' && sortDefault['dir'] !== 'desc') {
            problems.push(`${where}.sortDefault.dir must be asc or desc`)
          }
        }
      }
      const groupModes = b['groupModes']
      if (checkObjectArray(problems, `${where}.groupModes`, groupModes)) {
        for (const [index, mode] of groupModes.entries()) {
          const at = `${where}.groupModes[${index}]`
          if (!isRecord(mode)) {
            problems.push(`${at} is not an object`)
            continue
          }
          checkRequiredString(problems, `${at}.id`, mode['id'])
          checkRequiredString(problems, `${at}.label`, mode['label'])
          checkRequiredString(problems, `${at}.key`, mode['key'])
          checkOptionalString(problems, `${at}.parentIdKey`, mode['parentIdKey'])
        }
      }
      // Skip this cross-check entirely when the columns array itself was
      // invalid/empty - that is already its own problem, and flagging every
      // reference below on top of it would just be noise.
      if (columnKeys.size > 0) {
        const filterKeys = b['filterKeys']
        if (Array.isArray(filterKeys)) {
          for (const key of filterKeys) {
            if (typeof key === 'string' && !columnKeys.has(key)) {
              problems.push(`${where}.filterKeys: "${key}" is not one of columns[].key`)
            }
          }
        }
        if (isRecord(sortDefault) && typeof sortDefault['key'] === 'string' && !columnKeys.has(sortDefault['key'])) {
          problems.push(`${where}.sortDefault.key: "${sortDefault['key']}" is not one of columns[].key`)
        }
        if (Array.isArray(groupModes)) {
          for (const [index, mode] of groupModes.entries()) {
            // A mode with parentIdKey builds a tree (table-logic.ts's buildTree):
            // `key` there names each row's own parent-reference field, matched
            // against another row's parentIdKey - the same "id, not necessarily
            // displayed" role as parentIdKey itself, not "group by this column".
            if (
              isRecord(mode) &&
              !mode['parentIdKey'] &&
              typeof mode['key'] === 'string' &&
              !columnKeys.has(mode['key'])
            ) {
              problems.push(`${where}.groupModes[${index}].key: "${mode['key']}" is not one of columns[].key`)
            }
          }
        }
      }
      const rowActions = b['rowActions']
      if (checkObjectArray(problems, `${where}.rowActions`, rowActions)) {
        for (const [i, action] of rowActions.entries()) {
          checkAction(problems, `${where}.rowActions[${i}]`, action, manifest)
        }
      }
      const bulkActions = b['bulkActions']
      if (checkObjectArray(problems, `${where}.bulkActions`, bulkActions)) {
        for (const [i, action] of bulkActions.entries()) {
          const at = `${where}.bulkActions[${i}]`
          checkAction(problems, at, action, manifest)
          // A bulk action runs on the whole selection, so there is no row to
          // read from. Silently dropping the key would leave the module
          // reading its arguments off by one, so say so instead.
          pushIf(
            problems,
            isRecord(action) && action['argsFromRow'] != null,
            `${at}.argsFromRow is not allowed on a bulk action: it acts on the selection, not on one row`
          )
        }
      }
      checkObjectArray(problems, `${where}.rowDetail`, b['rowDetail'])
      // A selection is a list of rowKey values, and the default rowKey is
      // whatever the first column happens to be - fine for a React key, not
      // for deciding which containers to remove.
      pushIf(
        problems,
        b['selectable'] === true && (typeof b['rowKey'] !== 'string' || !b['rowKey']),
        `${where}.rowKey is required when selectable is true`
      )
      pushIf(
        problems,
        Array.isArray(bulkActions) && bulkActions.length > 0 && b['selectable'] !== true,
        `${where}.bulkActions needs selectable: true, or nothing can reach them`
      )
      break
    }
    case 'statusCards': {
      checkSource(problems, `${where}.source`, b['source'], manifest)
      // A card has no columns to fall back on the way a table does: the three
      // fields below are the only thing that decides what it draws.
      for (const field of ['rowKey', 'titleKey', 'statusKey'] as const) {
        pushIf(problems, typeof b[field] !== 'string' || !b[field], `${where}.${field} is missing`)
      }
      const items = b['items']
      if (items == null) problems.push(`${where}.items is missing`)
      else if (!isRecord(items)) problems.push(`${where}.items is not an object`)
      else {
        pushIf(
          problems,
          typeof items['key'] !== 'string' || !items['key'],
          `${where}.items.key is missing`
        )
        checkOptionalFiniteNumber(problems, `${where}.items.visibleRows`, items['visibleRows'], {
          min: 1,
          integer: true
        })
        for (const field of [
          'labelKey',
          'statusKey',
          'pinnedKey',
          'formatKey',
          'valueKey',
          'pinnedFilterLabel',
          'emptyText'
        ] as const) {
          checkOptionalString(problems, `${where}.items.${field}`, items[field])
        }
      }
      checkOptionalString(problems, `${where}.subtitleKey`, b['subtitleKey'])
      checkOptionalString(problems, `${where}.emptyText`, b['emptyText'])
      const note = b['note']
      if (note != null) {
        if (!isRecord(note)) problems.push(`${where}.note is not an object`)
        else {
          checkRequiredString(problems, `${where}.note.key`, note['key'])
          checkOptionalString(problems, `${where}.note.label`, note['label'])
          checkOptionalBoolean(problems, `${where}.note.startOpen`, note['startOpen'])
        }
      }
      const cardColumns = b['columns']
      if (cardColumns != null) {
        if (!isRecord(cardColumns)) problems.push(`${where}.columns is not an object`)
        else {
          checkOptionalFiniteNumber(problems, `${where}.columns.default`, cardColumns['default'], {
            min: 1,
            integer: true
          })
          checkOptionalFiniteNumber(problems, `${where}.columns.min`, cardColumns['min'], {
            min: 1,
            integer: true
          })
          checkOptionalFiniteNumber(problems, `${where}.columns.max`, cardColumns['max'], {
            min: 1,
            integer: true
          })
        }
      }
      const cardActions = b['rowActions']
      if (checkObjectArray(problems, `${where}.rowActions`, cardActions)) {
        for (const [i, action] of cardActions.entries()) {
          checkAction(problems, `${where}.rowActions[${i}]`, action, manifest)
        }
      }
      checkObjectArray(problems, `${where}.rowDetail`, b['rowDetail'])
      break
    }
    case 'log': {
      pushIf(problems, typeof b['event'] !== 'string' || !b['event'], `${where}.event is missing`)
      if (b['startMethod'] != null) checkMethod(problems, `${where}.startMethod`, b['startMethod'], manifest)
      if (b['stopMethod'] != null) checkMethod(problems, `${where}.stopMethod`, b['stopMethod'], manifest)
      checkStringArray(problems, `${where}.argsFromScope`, b['argsFromScope'])
      break
    }
    case 'terminal':
      pushIf(problems, typeof b['label'] !== 'string' || !b['label'], `${where}.label is missing`)
      pushIf(
        problems,
        typeof b['commandTemplate'] !== 'string' || !b['commandTemplate'],
        `${where}.commandTemplate is missing`
      )
      break
    case 'actions': {
      const actions = b['actions']
      if (
        checkObjectArray(problems, `${where}.actions`, actions, {
          required: true,
          nonEmpty: true
        })
      ) {
        for (const [i, action] of actions.entries()) {
          checkAction(problems, `${where}.actions[${i}]`, action, manifest)
        }
      }
      break
    }
    case 'form': {
      checkOptionalString(problems, `${where}.title`, b['title'])
      checkFields(problems, `${where}.fields`, b['fields'], manifest)
      checkAction(problems, `${where}.submit`, b['submit'], manifest)
      break
    }
    case 'checkForm': {
      checkOptionalString(problems, `${where}.title`, b['title'])
      checkFields(problems, `${where}.fields`, b['fields'], manifest)
      checkMethod(problems, `${where}.checkMethod`, b['checkMethod'], manifest)
      checkMethod(problems, `${where}.applyMethod`, b['applyMethod'], manifest)
      checkStringArray(problems, `${where}.argsFromScope`, b['argsFromScope'])
      checkOptionalString(problems, `${where}.checkLabel`, b['checkLabel'])
      checkOptionalString(problems, `${where}.applyLabel`, b['applyLabel'])
      if (b['kind'] != null && b['kind'] !== 'default' && b['kind'] !== 'danger') {
        problems.push(`${where}.kind must be default or danger`)
      }
      break
    }
    case 'conditional': {
      const when = b['when']
      if (when == null) problems.push(`${where}.when is missing`)
      else if (!isRecord(when)) problems.push(`${where}.when is not an object`)
      else {
        checkSource(problems, `${where}.when.source`, when['source'], manifest)
        checkOptionalString(problems, `${where}.when.path`, when['path'])
        pushIf(
          problems,
          when['op'] !== 'exists' && when['op'] !== 'eq' && when['op'] !== 'gt',
          `${where}.when.op must be exists, eq or gt`
        )
      }
      checkObjectArray(problems, `${where}.blocks`, b['blocks'], { required: true })
      checkObjectArray(problems, `${where}.else`, b['else'])
      break
    }
  }
}

/**
 * Which of a module's streams one page or widget actually reads.
 *
 * A surface being open is not the same as every one of a module's collectors
 * being wanted: the Disk module's Overview card and its File systems page read
 * only the slow `storage` stream, while the per-process I/O sweep that feeds
 * `snapshot` costs a walk of `/proc` on the target every couple of seconds.
 * The host answers `ctx.streamActive` from this, so a module can gate that
 * collector on somebody actually looking at what it produces.
 *
 * A `log` block's `event` is deliberately not counted. Those streams are not
 * poller-fed: the block starts and stops them itself through
 * `module:logs:start` / `module:logs:stop`, which is ref-counted per client,
 * so a module has no reason to ask about them here.
 */
export function specStreamEvents(spec: unknown): Set<string> {
  const events = new Set<string>()
  const pending: unknown[] = [spec]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next !== 'object' || next === null) continue
    if (seen.has(next)) continue
    seen.add(next)
    if (!Array.isArray(next)) {
      const record = next as Record<string, unknown>
      if (record['kind'] === 'stream' && typeof record['event'] === 'string') {
        events.add(record['event'])
      }
      // A history source reads the archive, but its tail between refetches is
      // a live stream like any other.
      if (record['kind'] === 'history' && typeof record['liveEvent'] === 'string') {
        events.add(record['liveEvent'])
      }
    }
    for (const value of Array.isArray(next) ? next : Object.values(next)) pending.push(value)
  }
  return events
}

/** True when any string value anywhere in `value` contains a URL - the no-CDN rule (T7.1). */
function containsUrl(value: unknown, seen = new Set<object>()): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next === 'string' && /https?:\/\//i.test(next)) return true
    if (typeof next === 'object' && next !== null) {
      if (seen.has(next)) continue
      seen.add(next)
      const values = Array.isArray(next) ? next : Object.values(next)
      for (const item of values) pending.push(item)
    }
  }
  return false
}

/**
 * Check one `ui/pages/<id>.json` or `ui/widgets/<id>.json` against the block
 * schema and the manifest that declares it: every block type is known, every
 * `source`/method points at something the manifest actually declares, and no
 * value anywhere is a URL (modules ship data, not remote scripts or images).
 * Returns the reasons it is unusable - empty means the spec is fine.
 */
export function specProblems(spec: unknown, manifest: ModuleManifest): string[] {
  const problems: string[] = []
  if (!isRecord(spec)) return ['spec is not an object']
  const s = spec
  const topBlocks = s['blocks']
  if (!Array.isArray(topBlocks)) return ['spec.blocks is missing']
  checkOptionalFiniteNumber(problems, 'spec.window', s['window'], { min: 1 })

  let blockCount = 0
  const visited = new Set<object>()
  const walk = (blocks: unknown[], path: string, depth: number): void => {
    if (depth > MAX_SPEC_DEPTH) {
      problems.push(`${path} exceeds the maximum nesting depth`)
      return
    }
    blocks.forEach((block, i) => {
      blockCount += 1
      if (blockCount > MAX_SPEC_BLOCKS) return
      const where = `${path}[${i}]`
      checkBlock(problems, where, block, manifest)
      if (isRecord(block)) {
        if (visited.has(block)) return
        visited.add(block)
        for (const nested of nestedBlockArrays(block)) {
          walk(nested.blocks, `${where}.${nested.path}`, depth + 1)
        }
      }
    })
  }
  walk(topBlocks, 'blocks', 0)
  if (blockCount > MAX_SPEC_BLOCKS) problems.push('spec contains too many blocks')

  if (containsUrl(spec)) {
    problems.push('spec contains a URL (http:// or https://) - modules may not reference remote content')
  }

  return problems
}
