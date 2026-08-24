/**
 * What this module remembers about one target machine. It lives on the app's
 * disk (ctx.hostDataGet/Set), not on the target: tags and job history are the
 * app's own bookkeeping, and writing them on the machine would need somewhere
 * writable there plus sudo on half the hosts people connect to.
 *
 * Everything is in one document because a tag, the containers wearing it and
 * the job that created them are only meaningful together - splitting them
 * across files would make a half-written pair possible.
 */
import type { ModuleContext } from '@shared/modules'

export interface TagRecord {
  id: string
  name: string
  /** Hex, always set - "pick one for me" is resolved when the tag is created, not when it is drawn. */
  color: string
  description: string
  createdAt: number
}

/** A create form the user saved, minus the fields that make no sense to reuse. */
export interface TemplateRecord {
  id: string
  name: string
  kind: 'create-docker' | 'create-incus'
  values: Record<string, string | number | boolean>
  createdAt: number
}

export type FleetItemStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'cancelled'

export interface FleetJobItem {
  idx: number
  name: string
  status: FleetItemStatus
  message?: string
  ms?: number
}

export type FleetJobState = 'running' | 'done' | 'failed' | 'partial' | 'cancelled'

export interface FleetJob {
  id: string
  kind: string
  label: string
  engine: 'docker' | 'incus'
  state: FleetJobState
  startedAt: number
  finishedAt?: number
  total: number
  done: number
  failed: number
  /** Precomputed, because a `table` column cannot divide two other columns. */
  progressPct: number
  concurrency: 'sequential' | 'parallel'
  items: FleetJobItem[]
}

export interface ContainerHostData {
  version: 1
  tags: TagRecord[]
  /** Which tags a container wears, keyed `docker:<id>` / `incus:<name>`. */
  members: Record<string, string[]>
  templates: TemplateRecord[]
  jobs: FleetJob[]
}

/** Job history is capped so one busy afternoon cannot grow the file without bound. */
export const MAX_JOBS = 50
export const MAX_JOB_ITEMS = 200

function emptyData(): ContainerHostData {
  return { version: 1, tags: [], members: {}, templates: [], jobs: [] }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * The file was written by this module, but it is still a file on disk that a
 * user can edit or an older version can have written, so every field is read
 * defensively rather than cast.
 */
function normalize(raw: unknown): ContainerHostData {
  if (typeof raw !== 'object' || raw === null) return emptyData()
  const r = raw as Partial<ContainerHostData>
  const tags: TagRecord[] = []
  const seenIds = new Set<string>()
  for (const entry of Array.isArray(r.tags) ? r.tags : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<TagRecord>
    const id = asString(t.id)
    const name = asString(t.name)
    if (!id || !name || seenIds.has(id)) continue
    seenIds.add(id)
    tags.push({
      id,
      name,
      color: asString(t.color),
      description: asString(t.description),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0
    })
  }
  const members: Record<string, string[]> = {}
  for (const [ref, ids] of Object.entries(r.members ?? {})) {
    if (!Array.isArray(ids)) continue
    const kept = ids.filter((id): id is string => typeof id === 'string' && seenIds.has(id))
    if (kept.length) members[ref] = [...new Set(kept)]
  }
  const templates: TemplateRecord[] = []
  for (const entry of Array.isArray(r.templates) ? r.templates : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const t = entry as Partial<TemplateRecord>
    if (!asString(t.id) || !asString(t.name)) continue
    if (t.kind !== 'create-docker' && t.kind !== 'create-incus') continue
    templates.push({
      id: t.id as string,
      name: t.name as string,
      kind: t.kind,
      values: typeof t.values === 'object' && t.values !== null ? (t.values as TemplateRecord['values']) : {},
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0
    })
  }
  const jobs = (Array.isArray(r.jobs) ? r.jobs : []).filter(
    (j): j is FleetJob => typeof j === 'object' && j !== null && typeof (j as FleetJob).id === 'string'
  )
  return { version: 1, tags, members, templates, jobs: jobs.slice(0, MAX_JOBS) }
}

/**
 * Reads through a cache and writes through it, so the fast tick can ask which
 * tags a row wears without touching the disk. The cache is tied to the host it
 * was read for: reconnecting somewhere else has to see that machine's data,
 * not the previous one's.
 */
export class HostStore {
  private cache: ContainerHostData | null = null
  private cachedFor: string | null = null
  /** Bumped on every write; the tag badge cache uses it to know it is stale. */
  private revision = 0

  constructor(private ctx: ModuleContext) {}

  get version(): number {
    return this.revision
  }

  read(): ContainerHostData {
    const host = this.ctx.hostKey
    if (this.cache && this.cachedFor === host) return this.cache
    this.cache = normalize(this.ctx.hostDataGet())
    this.cachedFor = host
    this.revision++
    return this.cache
  }

  /**
   * Mutate the document and persist it. Returns whatever the mutator returned.
   *
   * A failed write (over the size cap, a read-only app folder) leaves the
   * change in memory. That is deliberate: the alternative is throwing away the
   * tag the user just made, and the next successful write puts the two back in
   * step. Callers that can recover - the job history - catch and shrink.
   */
  update<T>(mutate: (data: ContainerHostData) => T): T {
    const data = this.read()
    const result = mutate(data)
    this.revision++
    this.ctx.hostDataSet(data)
    return result
  }

  /** Forget what was read, so the next read comes off disk. Called on disconnect. */
  reset(): void {
    this.cache = null
    this.cachedFor = null
    this.revision++
  }
}

/** A short id that reads as what it is in a JSON file someone opens by hand. */
export function makeId(prefix: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `${prefix}_${Math.random().toString(16).slice(2, 6)}`
    if (!taken.has(id)) return id
  }
  return `${prefix}_${Date.now().toString(16)}`
}
