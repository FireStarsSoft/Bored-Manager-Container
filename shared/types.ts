// Types shared between the server and the renderer.

// ---------- Connection ----------

export type ConnectionMode = 'local' | 'ssh'

export interface HostKeyConfirmation {
  /** Exact SHA-256 fingerprint shown by the preceding challenge. */
  fingerprint: string
  /** Single-use, short-lived token bound to host, port, and fingerprint. */
  token: string
}

export interface ConnectionConfig {
  mode: ConnectionMode
  label?: string
  host?: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  sudoPassword?: string
  rememberPassword?: boolean
  /** One-shot proof that the exact host key challenge was confirmed. */
  hostKeyConfirmation?: HostKeyConfirmation
}

export interface ConnectionStatus {
  connected: boolean
  mode?: ConnectionMode
  label?: string
  host?: string
  port?: number
  username?: string
  isRoot?: boolean
  hasSudo?: boolean
}

/** One target in the server-wide connection pool. */
export interface MachineStatus extends ConnectionStatus {
  machineId: string
  /** Increments whenever this id's executor is successfully replaced. */
  revision: number
}

/** Result of adding or reconnecting one target. */
export interface ConnectionResult extends OkResult {
  machineId?: string
  /** Reconnect could not proceed without asking the user for credentials. */
  needsCredentials?: boolean
}

/** A server push whose data belongs to one target machine. */
export interface MachinePayload<T> {
  machineId: string
  data: T
}

export interface SavedConnection {
  id: string
  label: string
  host: string
  port: number
  username: string
  hasSavedPassword: boolean
}

// ---------- System metrics ----------

export interface CpuSnapshot {
  total: number
  perCore: number[]
}

export interface MemSnapshot {
  total: number
  used: number
  available: number
  swapTotal: number
  swapUsed: number
}

export interface FsInfo {
  device: string
  /** empty when the target's df has no -T support */
  fstype: string
  mount: string
  sizeKb: number
  usedKb: number
  /** Same as `sizeKb`/`usedKb`, in bytes - a block spec's `format: 'bytes'` cannot scale a KB value itself. */
  sizeBytes: number
  usedBytes: number
  pct: number
}

export interface FsDetail extends FsInfo {
  inodesTotal: number
  inodesUsed: number
  inodesPct: number
}

/**
 * What a hardware sensor measures. The unit follows from the kind, so the UI
 * can group readings without parsing labels.
 */
export type SensorKind = 'temp' | 'fan' | 'voltage' | 'power' | 'current'

export interface SensorReading {
  /** chip that exposes the reading, e.g. coretemp-isa-0000 */
  chip: string
  label: string
  kind: SensorKind
  /** °C / RPM / V / W / A depending on kind */
  value: number
  unit: string
  /** limits reported by the chip, when it reports any */
  max?: number
  crit?: number
}

/**
 * Sensors change from second to second like any other live metric, so they
 * have their own fast poller instead of riding along with the slow one.
 */
export interface SensorsSnapshot {
  t: number
  sensors: SensorReading[]
}

/**
 * One entry of the block device tree (lsblk): a whole disk with its
 * partitions as children. Includes devices that carry no filesystem and
 * devices that are not mounted anywhere.
 */
export interface BlockDeviceInfo {
  name: string
  /** disk, part, lvm, crypt, rom, ... */
  type: string
  sizeBytes: number
  model: string
  serial: string
  /** sata, nvme, usb, ...; empty when the kernel reports none */
  transport: string
  rotational: boolean
  removable: boolean
  fstype: string
  mountpoint: string
  children: BlockDeviceInfo[]
}

/**
 * Storage layout and capacity: mount usage, inodes and the device tree.
 * Minutes-scale data, collected by the storage poller on its own interval.
 */
export interface StorageSnapshot {
  t: number
  filesystems: FsDetail[]
  devices: BlockDeviceInfo[]
}

export interface SystemSnapshot {
  t: number
  cpu: CpuSnapshot
  mem: MemSnapshot
  /** bytes per second */
  netRx: number
  netTx: number
  /** bytes per second */
  diskRead: number
  diskWrite: number
  load: [number, number, number]
  uptimeSec: number
  hostname: string
}

// ---------- GPU ----------

export interface GpuInfo {
  index: number
  name: string
  utilization: number
  memUtil: number
  memUsedMiB: number
  memTotalMiB: number
  temp: number
  powerDraw: number
  powerLimit: number
  powerMin: number
  powerMax: number
  /** What `nvidia-smi -pl` resets to. 0 when the driver does not report it. */
  powerDefault: number
  fan: number
  clockSm: number
  clockMem: number
  persistence: boolean
  driverVersion: string
}

export interface GpuProcess {
  gpuIndex: number
  pid: number
  name: string
  memMiB: number
}

export interface GpuSnapshot {
  t: number
  available: boolean
  gpus: GpuInfo[]
  processes: GpuProcess[]
}

// ---------- Docker ----------

/**
 * One row of the containers table. `docker ps` and `docker stats` are two
 * separate commands (see main/service.ts) joined here by id before this ever
 * reaches a block spec - a `table` block reads one flat array, it cannot join
 * a second one by id itself. The stat fields are 0/empty for a stopped
 * container (`docker stats` only reports running ones).
 */
export interface DockerContainer {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  runningFor: string
  /** healthy / unhealthy / starting, empty when the image defines no healthcheck */
  health: string
  cpuPct: number
  memPct: number
  memUsage: string
  netIO: string
  blockIO: string
  /** threads/processes inside the container */
  pids: number
  /** Labels the user gave this container, from the module's own per-host store. */
  tagBadges: ContainerTagBadge[]
  /** The same tags as plain text, so the table's filter can search them. */
  tagsText: string
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  created: string
  /** `id:tag` - unique even when the same image id carries more than one tag, unlike `id` alone. */
  key: string
}

export interface DockerVolume {
  name: string
  driver: string
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
}

/** One `Mounts` entry of `docker inspect`. */
export interface DockerMount {
  /** bind / volume / tmpfs */
  type: string
  source: string
  destination: string
  /** "rw" / "ro" - a block's `format` only scales numbers, so this is text rather than the daemon's boolean. */
  mode: string
}

/** A network the container is attached to, with the address it got on it. */
export interface DockerNetworkAttachment {
  name: string
  ipv4: string
  gateway: string
  macAddress: string
}

export interface DockerPortMapping {
  /** container side, e.g. "80/tcp" */
  container: string
  /** host side, e.g. "0.0.0.0:8080"; empty when the port is not published */
  host: string
}

export interface DockerHealth {
  /** healthy / unhealthy / starting */
  status: string
  failingStreak: number
  /** output of the last probe, trimmed */
  lastOutput: string
}

/**
 * The parts of `docker inspect` worth showing: why a container stopped, how
 * often it restarted, whether its healthcheck passes, which addresses and
 * volumes it has. Read on demand (one daemon call per container), never on the
 * fast tick.
 */
export interface DockerInspect {
  id: string
  name: string
  image: string
  imageId: string
  command: string
  /**
   * Epoch ms, or null when Docker reported no usable timestamp. Left raw
   * rather than pre-formatted: the `docker.json` keyValue rows for these
   * carry `format: 'datetime'`, so it renders in the viewer's own
   * locale/timezone instead of whatever this server happens to be set to.
   */
  createdAt: number | null
  startedAt: number | null
  finishedAt: number | null
  state: string
  exitCode: number | null
  restartCount: number
  /** no / always / unless-stopped / on-failure[:max] */
  restartPolicy: string
  health: DockerHealth | null
  networks: DockerNetworkAttachment[]
  ports: DockerPortMapping[]
  mounts: DockerMount[]
  /** docker compose labels, empty for containers started by hand */
  composeProject: string
  composeService: string
  /** Labels the user gave this container, from the module's own per-host store. */
  tagBadges: ContainerTagBadge[]
  tagsText: string
}

export interface DockerSnapshot {
  t: number
  available: boolean
  running: number
  stopped: number
  totalCpuPct: number
  totalMemPct: number
  containers: DockerContainer[]
}

// ---------- Incus ----------

/** A label the user invented, as a `badges`-formatted cell renders it. */
export interface ContainerTagBadge {
  label: string
  color?: string
}

/**
 * One row of `incus list --format json`, reduced to what a table shows. Incus
 * calls both system containers and virtual machines "instances" and manages
 * them the same way, so they share one table with a `type` column.
 */
export interface IncusInstance {
  name: string
  type: 'container' | 'vm'
  /** Incus's own word: Running, Stopped, Frozen, Error. */
  status: string
  running: boolean
  ipv4: string[]
  /** Comma-joined `ipv4`, because a table cell renders one value, not a list. */
  ipv4Text: string
  image: string
  memUsageBytes: number
  snapshots: number
  profiles: string[]
  profilesText: string
  tagBadges: ContainerTagBadge[]
  /** The same tags as plain text, so the table's filter can search them. */
  tagsText: string
}

export interface IncusSnapshot {
  t: number
  /** False when the incus CLI is not installed or refuses to talk to the daemon. */
  available: boolean
  running: number
  stopped: number
  instances: IncusInstance[]
}

/** One row of `docker system df`. */
export interface DockerDfRow {
  count: number
  /** how many of them are in use */
  active: number
  sizeBytes: number
  /** bytes a prune would free */
  reclaimableBytes: number
}

/**
 * How much disk Docker occupies. Enumerating images and volumes costs a
 * couple of daemon calls for numbers that move slowly, so this has its own
 * slow interval instead of riding on the container tick.
 */
export interface DockerSlowSnapshot {
  t: number
  available: boolean
  /** false when only counts could be read (no `docker system df`) */
  hasSizes: boolean
  images: DockerDfRow
  containers: DockerDfRow
  volumes: DockerDfRow
  buildCache: DockerDfRow
  /** Sum of the 4 rows above - a block spec cannot add nested fields together itself. */
  totalSizeBytes: number
  totalReclaimableBytes: number
}

// ---------- Processes ----------

export interface ProcessInfo {
  pid: number
  /** Parent pid - only used to back the table's "by parent process" group mode (T3.4/T3.6), not shown as its own column. */
  ppid: number
  user: string
  cpu: number
  mem: number
  rssKb: number
  /** Same as `rssKb`, in bytes - a block spec's `format: 'bytes'` cannot scale a KB value itself. */
  rssBytes: number
  stat: string
  etime: string
  /** The full command line. There is no `comm` beside it - see LIST_CMD in the Processes module's `main/service.ts`. */
  args: string
}

/**
 * One of the processes using the most of a given resource. `value` is what the
 * ranking is based on; the per-direction fields are what the card shows, so
 * "1.2 MB/s" can be read as "1.1 MB/s down, 100 KB/s up" instead of a single
 * number that hides which way the traffic went.
 */
export interface TopProcEntry {
  pid: number
  name: string
  /** % for cpu, bytes for memory, bytes per second for disk and network */
  value: number
  /** network only: bytes per second down / up (sum = value) */
  rx?: number
  tx?: number
  /** disk only: bytes per second read / written (sum = value) */
  read?: number
  write?: number
}

/**
 * The busiest processes per resource, for the Overview cards. One tick reads
 * ps, /proc/PID/io and ss in a single roundtrip.
 */
export interface TopConsumersSnapshot {
  t: number
  /** true when the per-process counters were read as root (all processes) */
  sudo: boolean
  cpu: TopProcEntry[]
  memory: TopProcEntry[]
  disk: TopProcEntry[]
  network: TopProcEntry[]
}

// ---------- GPU auto power cap ----------

/** What counts as "busy" for the watcher. */
export type AutoCapTrigger = 'docker' | 'gpu'

/** The two caps of one GPU. */
export interface AutoCapEntry {
  idleCap: number
  runningCap: number
}

/**
 * The watcher as it is saved, per machine (ctx.hostDataSet). GPUs are keyed by
 * index as a string, because that is what a JSON object can hold; a machine
 * with no entry here has nothing watching it.
 */
export interface AutoCapConfig {
  enabled: boolean
  intervalSec: number
  trigger: AutoCapTrigger
  gpus: Record<string, AutoCapEntry>
}

/** One configured GPU, as the page shows it. */
export interface AutoCapGpuStatus extends AutoCapEntry {
  index: number
  name: string
  /** The cap this watcher last applied; null until it has acted. */
  appliedCap: number | null
  /** Whether the trigger reads as busy; null before the first check. */
  busy: boolean | null
}

export interface AutoCapStatus {
  enabled: boolean
  intervalSec: number
  trigger: AutoCapTrigger
  /** An array rather than the saved map, so a table block can read it. */
  gpus: AutoCapGpuStatus[]
  log: string[]
}

// ---------- Settings ----------

export type RefreshSpeed = 'high' | 'normal' | 'low' | 'paused'
export type Density = 'low' | 'medium' | 'high'

/** `system` follows the browser's prefers-color-scheme. */
export type Theme = 'dark' | 'light' | 'system'

/** Chart time range, in seconds. */
export type HistoryWindow = number

export const HISTORY_WINDOW_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
  { value: 1800, label: '30m' },
  { value: 3600, label: '1h' },
  { value: 10800, label: '3h' },
  { value: 21600, label: '6h' },
  { value: 43200, label: '12h' },
  { value: 86400, label: '24h' }
]

// ---------- Metrics history on disk ----------

/**
 * Name of a metrics stream on disk (one file per stream per hour). `system` is
 * the app's own; every other name is claimed by a module, so this is a plain
 * string instead of a fixed union.
 */
export type HistoryStream = string

/** The stream the core system metrics are written to. */
export const SYSTEM_HISTORY_STREAM = 'system'

/** A downsampled history sample; keys depend on the stream. */
export interface HistoryPoint {
  t: number
  [key: string]: number
}

export interface HistorySettings {
  enabled: boolean
  /** how far back samples are kept on disk */
  retentionHours: number
  /** hard cap; the oldest hour buckets are dropped when exceeded */
  maxStorageMB: number
}

export interface HistoryStats {
  enabled: boolean
  /** absolute path of data/metrics */
  dir: string
  /** Scoped machine id, or null when stats aggregate the whole pool. */
  hostKey: string | null
  /** file the next flush will append to */
  currentFile: string | null
  fileCount: number
  totalBytes: number
  oldestMs: number | null
  newestMs: number | null
  lastFlushMs: number | null
  /** samples buffered in RAM, waiting for the next flush */
  pendingPoints: number
  flushIntervalSec: number
  hosts: Array<{ hostKey: string; files: number; bytes: number }>
}

export const HISTORY_RETENTION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: '1 hour' },
  { value: 3, label: '3 hours' },
  { value: 6, label: '6 hours' },
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' }
]

/** Saved position of one Overview card (height always follows its content). */
export interface OverviewLayoutItem {
  i: string
  x: number
  y: number
  w: number
}

/** Card positions per grid width: lg = 6 columns, md = 4. */
export type OverviewLayout = Partial<Record<'lg' | 'md', OverviewLayoutItem[]>>

/**
 * Which Overview widgets are on, keyed by card id: a bare id for a card the
 * app itself provides (`perCoreCpu`), `<moduleId>.<cardId>` for one that comes
 * from a module. A card with no entry here falls back to the default the card
 * declares, so installing a module does not require writing settings first.
 */
export type OverviewWidgetSettings = Record<string, boolean>

/**
 * Which of the app's own collectors run. Everything a module owns is switched
 * with the module itself (Settings -> Modules), so only what the core process
 * collects is listed here.
 */
export interface CollectorSettings {
  cpu: boolean
  memory: boolean
  /** Machine-wide network rates in the system stream (Overview, not the tab). */
  network: boolean
  /** Machine-wide disk rates in the system stream (Overview, not the tab). */
  disk: boolean
  packages: boolean
}

/**
 * When the heavy detail collectors (per-connection network, per-process
 * disk I/O, Overview top consumers) run: only while their tab is open,
 * always (background accounting keeps session totals accurate), or never.
 */
export type DetailPollingMode = 'tab' | 'always' | 'off'

export interface DetailPollingSettings {
  network: DetailPollingMode
  disk: DetailPollingMode
  gpu: DetailPollingMode
  sensors: DetailPollingMode
  container: DetailPollingMode
  /** per-process CPU/memory/disk/network for the Overview cards */
  overviewTop: DetailPollingMode
}

/**
 * Metrics collected every second or two. The listed keys are the ones the app
 * and its default modules use; an installed module may declare a key of its
 * own (see ModuleContributes.fastInterval), which is why this is open-ended.
 */
export interface FastRefreshSettings {
  system: RefreshSpeed
  sensors: RefreshSpeed
  gpu: RefreshSpeed
  container: RefreshSpeed
  processes: RefreshSpeed
  network: RefreshSpeed
  disk: RefreshSpeed
  [key: string]: RefreshSpeed
}

/**
 * Interval in seconds for the parts of each category that move on the scale
 * of minutes, not seconds. 0 = only refresh when asked to. Open-ended for the
 * same reason as FastRefreshSettings.
 */
export interface SlowRefreshSettings {
  /** mount usage, inodes, block device inventory */
  storage: number
  /** image/volume/build cache disk usage */
  container: number
  /** interface inventory, gateway, DNS */
  network: number
  [key: string]: number
}

export type SlowRefreshKey = string

/** A slow section the UI can ask for an immediate reading of. */
export type SlowRefreshTarget = string

/**
 * Schema version of the settings file. An update carries the file over, so the
 * app has to be able to read what an older version wrote: unknown fields are
 * dropped, missing ones filled from the defaults, and the file is rewritten in
 * the current format (see electron/services/store.ts). Bump this whenever a
 * field changes shape and needs converting.
 *
 * 3: features became modules - the per-feature collector switches and the
 *    fixed extended-card list turned into module state and keyed widget ids.
 * 4: the app became a web server - where it listens, whether a login is
 *    required, and the update source moved into the file.
 * 5: the UI gained a light theme, so which one to use became a setting. A file
 *    written before this only ever ran dark, and is carried over as such.
 * 6: the Docker module grew Incus alongside it and became the Container
 *    module, so its interval keys and Overview widget ids changed name.
 * 7: the server gained an explicit Host allowlist and local reverse-proxy
 *    trust setting.
 */
export const SETTINGS_VERSION = 7

/**
 * Sent once, right when a socket opens (before the client has asked for
 * anything). `now` is the server's own `Date.now()` at that instant, which
 * the client compares against its own clock to learn `serverOffset`
 * (src/lib/clock.ts) - the only way it can tell a `formatDuration`/`formatAge`
 * on a server-issued timestamp not to drift when the two clocks disagree.
 */
export interface HelloPayload {
  version: string
  buildTime: string
  settingsVersion: number
  now: number
}

/** Network boundary of the WebUI. Changing port/host/allowedHosts/trustProxy needs a restart. */
export interface ServerSettings {
  port: number
  host: string
  /** Extra DNS names accepted in Host/Origin, beyond local addresses. */
  allowedHosts: string[]
  /** Trust forwarding headers only from a reverse proxy on loopback. */
  trustProxy: boolean
  /**
   * Redial every machine that was connected when the server last stopped, as
   * soon as it starts again - local unconditionally, SSH only where a
   * password was saved. Off by default: an unattended reconnect to a remote
   * host is a choice, not a given. Takes effect on the next start, not this
   * one, so it is not part of serverSettingsChanged's restart prompt.
   */
  reconnectOnStart: boolean
}

export type SessionIdleUnit = 'minute' | 'hour' | 'day'

/**
 * How long a session may sit idle before it has to be logged in again.
 * `value: 0` means never - the common case for a machine on a home network.
 */
export interface SessionIdle {
  value: number
  unit: SessionIdleUnit
}

export interface AuthSettings {
  /** Off by default: everyone is `bored-admin` and no login is asked for. */
  enabled: boolean
  /** Wrong passwords, counted per username and per client address, before that account or address locks. */
  maxFailures: number
  sessionIdle: SessionIdle
}

/** True when the listen address answers on every interface, not just this machine. */
export function isOpenBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]'
}

export interface UpdateSettings {
  /** GitHub repo releases and the module registry are read from. */
  repo: string
  /** Last archive link used in Settings -> Software update, ready to reuse. */
  lastUrl: string
}

export interface AppSettings {
  /** Format of the file this was read from; always SETTINGS_VERSION in memory. */
  settingsVersion: number
  theme: Theme
  density: Density
  densityAutoDetected: boolean
  historyWindow: HistoryWindow
  refresh: FastRefreshSettings
  slowRefresh: SlowRefreshSettings
  /** Which Overview widgets are on; missing keys use the card's own default. */
  overviewWidgets: OverviewWidgetSettings
  /** Where the user dragged each Overview card; empty = default order. */
  overviewLayout: OverviewLayout
  collectors: CollectorSettings
  detailPolling: DetailPollingSettings
  history: HistorySettings
  server: ServerSettings
  auth: AuthSettings
  update: UpdateSettings
}

/** The account that always exists and cannot be deleted. */
export const DEFAULT_USERNAME = 'bored-admin'

/** Lower case, starts with a letter, 3-32 characters. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/

export const DEFAULT_UPDATE_REPO = 'FireStarsSoft/Bored-Manager'

export interface UserAccount {
  username: string
  createdAt: number
  lastLoginAt: number | null
  hasPassword: boolean
}

/** What /api/auth/status answers, and what the UI decides its boot flow on. */
export interface AuthStatus {
  authEnabled: boolean
  authenticated: boolean
  username: string | null
  /** Too many wrong passwords: only `./bored-manager unlock` clears this. */
  locked: boolean
}

export const SLOW_REFRESH_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 0, label: 'Manual only' }
]

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'dark',
  density: 'medium',
  densityAutoDetected: false,
  historyWindow: 60,
  refresh: {
    // `system` is the only one of these the app collects itself. The rest are
    // module keys, seeded although 0.4.3 ships no modules at all: the interface
    // requires them, and a fresh install has to have something to offer for the
    // key before the module that declares it is installed. BMC's two entries
    // went with the module because they only ever repeated the fallback - these
    // do not, and `processes` is read by the Overview's own top-consumers
    // collector whether the Processes module is there or not.
    system: 'normal',
    sensors: 'normal',
    gpu: 'normal',
    container: 'normal',
    processes: 'normal',
    network: 'normal',
    disk: 'normal',
    // A module-declared refresh key with no default here reads back as
    // `normal` (modules-host's fastIntervalMs), so this entry is not required
    // for service-fleet to poll - it is a deliberate override to `low`,
    // since this tick only re-reads the last sweep from memory; the sweep
    // itself is on slowRefresh below. Which is why it outlived the move to a
    // separate repository: dropping it makes every fresh install re-read 2.5x
    // as often as intended.
    'service-fleet': 'low'
  },
  slowRefresh: {
    // Every key here belongs to a module now, and the two overrides are the
    // reason the whole block stays: a missing key falls back to 60, so dropping
    // `container` and `service-fleet` would leave a fresh install asking Docker
    // for disk usage 5x as often and sweeping every monitored machine over SSH
    // 2x as often as intended, the moment the module was installed.
    storage: 60,
    container: 300,
    network: 60,
    'service-fleet': 120
  },
  overviewWidgets: {},
  overviewLayout: {},
  collectors: {
    cpu: true,
    memory: true,
    network: true,
    disk: true,
    packages: true
  },
  detailPolling: {
    network: 'tab',
    disk: 'tab',
    gpu: 'always',
    sensors: 'always',
    container: 'always',
    overviewTop: 'tab'
  },
  history: {
    enabled: true,
    retentionHours: 6,
    maxStorageMB: 200
  },
  server: {
    port: 8686,
    host: '0.0.0.0',
    allowedHosts: [],
    trustProxy: false,
    reconnectOnStart: false
  },
  auth: {
    enabled: false,
    maxFailures: 5,
    sessionIdle: { value: 0, unit: 'hour' }
  },
  update: {
    repo: DEFAULT_UPDATE_REPO,
    lastUrl: ''
  }
}

/**
 * Samples are buffered in RAM and appended to disk in one batch on this
 * interval (plus on quit/disconnect), so a long session does not turn into
 * constant small writes.
 */
export const HISTORY_FLUSH_MS = 5 * 60 * 1000

/** How much compact history the main process keeps in memory. */
export const HISTORY_RING_MS = 30 * 60 * 1000

export const REFRESH_INTERVAL_MS: Record<RefreshSpeed, number> = {
  high: 1000,
  normal: 2000,
  low: 5000,
  paused: 0
}

// ---------- Network detail ----------

export interface NetIfaceInfo {
  name: string
  /** operstate: up / down / unknown */
  state: string
  mac: string
  mtu: number
  /** link speed in Mbps, null when the driver does not report one (wifi, virtual) */
  speedMbps: number | null
  ipv4: string[]
  ipv6: string[]
  /** bytes per second */
  rxRate: number
  txRate: number
  /** packets per second */
  rxPktRate: number
  txPktRate: number
  /** bytes since boot */
  rxTotal: number
  txTotal: number
  rxErrors: number
  txErrors: number
  rxDrops: number
  txDrops: number
}

export interface NetConnection {
  /**
   * `proto|local|peer` - the same key the collector diffs byte counters on
   * (see `socketKey` in shared/ss.ts). Table rows need this because none of
   * the fields below is unique alone: many established connections share a
   * `localPort` (one listening socket, many peers), and `proto` repeats on
   * almost every row.
   */
  id: string
  /** tcp / tcp6 / udp / udp6 */
  proto: string
  /** ESTAB, LISTEN, TIME-WAIT, UNCONN, ... */
  state: string
  localAddr: string
  localPort: number
  remoteAddr: string
  remotePort: number
  pid: number | null
  process: string
  /** bytes per second, null when the kernel exposes no counters (UDP) */
  rxRate: number | null
  txRate: number | null
  /** bytes over the connection lifetime (TCP only) */
  rxTotal: number | null
  txTotal: number | null
}

export interface ProcNetUsage {
  /**
   * null on the one row that stands for every socket with no owning process
   * (another user's without sudo, or a kernel-side one). It is not a process
   * and must not be offered as one - a row action whose `argsFromRow` lands
   * on null is not rendered (src/modules/action-runner.tsx).
   */
  pid: number | null
  process: string
  connections: number
  /** bytes per second (TCP-derived) */
  rxRate: number
  txRate: number
  /** bytes accumulated while the app has been connected */
  rxSession: number
  txSession: number
}

export interface ListeningPort {
  /** `proto|addr:port` - unique even when several listeners share a protocol (see `NetConnection.id`). */
  id: string
  proto: string
  addr: string
  port: number
  pid: number | null
  process: string
}

export interface NetProtoStats {
  /** TCP segments retransmitted per second (connection quality indicator) */
  retransRate: number
  inSegRate: number
  outSegRate: number
  udpInRate: number
  udpOutRate: number
  retransTotal: number
  udpErrorsTotal: number
}

export interface NetGeneralInfo {
  gateway: string
  gatewayIface: string
  dnsServers: string[]
}

export interface NetworkSnapshot {
  t: number
  /** When the cached interface inventory (addresses, link speed, gateway, DNS) was last read. */
  inventoryAt: number
  /** true when ss ran with root (process info visible for every socket) */
  sudo: boolean
  totalRxRate: number
  totalTxRate: number
  /** bytes accumulated while the app has been connected (all interfaces except lo) */
  sessionRx: number
  sessionTx: number
  ifaces: NetIfaceInfo[]
  connections: NetConnection[]
  processes: ProcNetUsage[]
  listening: ListeningPort[]
  proto: NetProtoStats
  info: NetGeneralInfo
}

/** Lightweight point kept in history for charts. */
export interface NetworkHistoryPoint {
  t: number
  rx: number
  tx: number
  connCount: number
  ifaces: Record<string, { rx: number; tx: number }>
}

// ---------- Disk detail ----------

export interface DiskDeviceInfo {
  name: string
  model: string
  sizeBytes: number
  rotational: boolean
  /** bytes per second */
  readRate: number
  writeRate: number
  /** operations per second */
  readIops: number
  writeIops: number
  /** % of wall time the device had I/O in flight */
  utilPct: number
  /** average ms per completed operation in the last interval */
  avgLatencyMs: number
  /** bytes since boot */
  readTotal: number
  writeTotal: number
}

export interface ProcDiskUsage {
  pid: number
  process: string
  /** bytes per second */
  readRate: number
  writeRate: number
  /** bytes over the process lifetime */
  readTotal: number
  writeTotal: number
}

/**
 * Live disk activity. Mount usage and the device inventory are not repeated
 * here: they come from the storage poller (see StorageSnapshot).
 */
export interface DiskSnapshot {
  t: number
  /** true when /proc/PID/io was swept as root (all processes visible) */
  sudo: boolean
  totalReadRate: number
  totalWriteRate: number
  totalReadIops: number
  totalWriteIops: number
  /** `totalReadIops + totalWriteIops` - a block spec's `stat` source cannot sum two fields itself. */
  totalIops: number
  /** What the devices moved minus what `processes` accounts for (kernel writeback, cache, journal, swap, and - without sudo - other users' processes). */
  unattributedReadRate: number
  unattributedWriteRate: number
  devices: DiskDeviceInfo[]
  processes: ProcDiskUsage[]
}

/** Lightweight point kept in history for charts. */
export interface DiskHistoryPoint {
  t: number
  read: number
  write: number
  readIops: number
  writeIops: number
}

// ---------- Packages ----------

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'none'

export interface PackageInfo {
  name: string
  version: string
  arch: string
  sizeKb: number
  summary: string
}

export interface UpgradablePackage {
  name: string
  currentVersion: string
  newVersion: string
  repo: string
}

export interface PackageHistoryEntry {
  date: string
  action: string
  packages: string
}

export interface PackagesOverview {
  manager: PackageManager
  /**
   * The manager probe did not finish (timeout, dead channel), so `manager`
   * here reads 'none' but means *unknown*: nothing was cached and asking
   * again re-probes. The page offers a retry instead of the terminal "no
   * supported package manager" card.
   */
  probeFailed?: boolean
  installedCount: number
  upgradableCount: number
  /** unix ms of the last package list update, null when unknown */
  lastListUpdate: number | null
  /** sum of installed sizes in KB, null when the manager does not report it */
  totalInstalledSizeKb: number | null
  installed: PackageInfo[]
  upgradable: UpgradablePackage[]
  history: PackageHistoryEntry[]
}

export interface PackageSearchResult {
  name: string
  summary: string
}

export type PkgAction =
  | 'update'
  | 'upgradeAll'
  | 'upgrade'
  | 'install'
  | 'remove'
  | 'purge'
  | 'autoremove'

export interface PkgActionState {
  running: boolean
  action?: PkgAction
  target?: string
  /** set when the last action finished */
  exitCode?: number | null
}

// ---------- App update ----------

/** One thing the downloaded archive was checked for. */
export interface UpdateCheckItem {
  id: string
  label: string
  ok: boolean
  /** why it failed, or extra information when it passed */
  detail?: string
}

export interface UpdateValidation {
  status: 'pass' | 'error'
  currentVersion: string
  newVersion?: string
  checks: UpdateCheckItem[]
  /** non-blocking remarks, e.g. the new version is not newer */
  warnings: string[]
}

export type UpdatePhase =
  | 'idle'
  | 'downloading'
  | 'extracting'
  | 'validating'
  | 'ready'
  | 'error'
  | 'applying'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  /** the archive this state belongs to */
  url?: string
  progress?: { receivedBytes: number; totalBytes: number | null }
  validation?: UpdateValidation
  error?: string
}

/** What `update:checkRepo` found on GitHub. */
export interface UpdateRepoInfo {
  currentVersion: string
  /** null when the repo has no matching release zip */
  latestVersion: string | null
  /** Zip of a `bored-manager-*.zip` release asset, when one exists. */
  assetUrl?: string
  /** Source zip of the default branch, when there is no matching asset. */
  fallbackUrl?: string
  notes?: string
}

/**
 * Written by the update script. Read once at the next start and pushed to
 * every browser that connects until one of them acknowledges it.
 */
export interface UpdateResult {
  ok: boolean
  version?: string
  error?: string
  finishedAt?: number
  logPath?: string
  /** Custom modules that failed to build against the new version. */
  quarantined?: string[]
}

// ---------- Terminals ----------

export type TerminalPreset = 'shell' | 'nvidia-smi' | 'glances' | 'lazydocker' | 'custom'

export interface TerminalInfo {
  id: string
  machineId: string
  title: string
  preset: TerminalPreset
}

/**
 * What a view that has just mounted is handed to catch up on a shell that was
 * running without it, and how far through the output stream that text reaches.
 *
 * `seq` is what makes the replay safe to write. A view subscribes to
 * `term:data` and asks for the replay in the same breath, so whatever the
 * shell writes in between is in both - and the two do not even arrive in a
 * fixed order, since a reply goes straight out to the socket while an event
 * waits in a queue behind an authorization check. Every event carries the same
 * counter, so the view can tell which of them this text already contains.
 */
export interface TerminalReplay {
  text: string
  /** The `term:data` sequence number this text already includes. */
  seq: number
}

// ---------- Services tracker ----------

/**
 * One sub-process or job the app itself is responsible for, on top of
 * whatever it collects from the target machine: the server process itself, a
 * `Poller` tick, or a long-running command it spawned (a live log tail, an
 * interactive terminal). Surfaced so "what is Bored Manager itself costing"
 * is answerable without shelling into the host - see
 * server/services/services-tracker.ts.
 */
export interface ServiceEntry {
  /** Unique within the current server run; not stable across a restart. */
  id: string
  kind: 'self' | 'poller' | 'stream' | 'shell'
  /** 'core' (the app itself), a module id, or 'terminal'. */
  owner: string
  /** e.g. 'gpu:sample', 'docker logs -f abc', 'node server'. */
  label: string
  command?: string
  /**
   * Set only when this entry maps to a real OS process the app can `ps`: a
   * locally spawned child or a node-pty shell. Never set for an SSH-remote
   * stream/shell (there is nothing local to measure) or for a poller (its
   * command runs and exits within one tick).
   */
  pid?: number
  startedAt: number
  /** poller only */
  intervalMs?: number
  /** poller only: wall time its most recent tick took */
  lastTickMs?: number
  /**
   * poller only: `lastTickMs / intervalMs * 100`. Not a real CPU reading -
   * a command that runs for a few ms cannot be sampled by `ps` - just how
   * much of the poller's own budget its tick is using.
   */
  estCostPct?: number
  /**
   * % - always on `self`; on a stream/shell entry only when that tick's `ps`
   * sweep managed to sample its pid. An entry the server still holds open is
   * listed either way (services-tracker.ts checks the pid, not the sweep).
   */
  cpu?: number
  memBytes?: number
}

/** What the services tracker reports on its own poll tick (`core:services`). */
export interface ServicesSnapshot {
  t: number
  totalCpu: number
  totalMemBytes: number
  /**
   * `entries.length`, and `entries[0]`'s own cpu/mem (`self` is always first -
   * see services-tracker.ts). A block's `keyValue` reads a fixed dot-path: it
   * cannot call `.length` on an array or search `entries` for `kind==='self'`
   * itself, so the summary page (T5.3) needs these spelled out here.
   */
  count: number
  selfCpu: number
  selfMemBytes: number
  entries: ServiceEntry[]
}

// ---------- IPC payloads ----------

/**
 * What a freshly connected renderer is given so its charts do not start empty:
 * the core streams, plus one bag per enabled module holding whatever that
 * module buffered (see ModuleMainInstance.snapshots).
 */
export interface HistoryPayload {
  system: SystemSnapshot[]
  top: TopConsumersSnapshot | null
  services: ServicesSnapshot | null
  /** moduleId -> stream name -> buffered value(s). */
  modules: Record<string, Record<string, unknown>>
}

export interface HostKeyChallenge {
  kind: 'unknown' | 'changed'
  fingerprint: string
  host: string
  port: number
  token: string
  expiresAt: number
}

export interface OkResult {
  ok: boolean
  error?: string
  data?: string
  hostKey?: HostKeyChallenge
}
