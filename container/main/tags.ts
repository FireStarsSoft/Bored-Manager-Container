/**
 * Labels the user invents, and which containers wear them. A container may
 * wear any number of tags; a tag knows nothing about a container beyond the
 * ref it was attached to, so a container that goes away leaves a dangling
 * membership that `prune` clears rather than something that breaks a listing.
 */
import type { ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import { FORM_COLOR_SWATCHES } from '@shared/module-ui'
import type { ContainerTagBadge, OkResult } from '@shared/types'
import { makeId, type ContainerHostData, type HostStore, type TagRecord } from './store'

/** Word characters to start, then words, spaces, dots and dashes - a label, not a path. */
const TAG_NAME_RE = /^[\w][\w .-]{0,31}$/
const MAX_DESCRIPTION = 500

export type TagApplyTo = 'none' | 'all-running-docker' | 'all-docker' | 'all-incus' | 'all'

/** Where the live refs come from, so tags do not have to know about the poller. */
export interface RefSource {
  dockerAll(): string[]
  dockerRunning(): string[]
  incusAll(): string[]
  /** Display name for a ref, for the members table. Empty when it is gone. */
  describe(ref: string): { name: string; status: string } | null
}

interface TagValues {
  name: string
  color: string
  description: string
  applyTo: TagApplyTo
}

/** What the check resolved and the apply must not resolve again. */
interface TagPlan {
  values: TagValues
  refs: string[]
}

function str(values: unknown, key: string): string {
  const v = (values as Record<string, unknown>)?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A colour nobody picked becomes the least-used one in the palette, so a
 * machine with five tags gets five distinguishable colours instead of five
 * rolls of the same die.
 */
export function leastUsedColour(tags: readonly TagRecord[]): string {
  const counts = new Map<string, number>(FORM_COLOR_SWATCHES.map((hex) => [hex, 0]))
  for (const tag of tags) {
    const key = tag.color.toLowerCase()
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = FORM_COLOR_SWATCHES[0]
  let bestCount = Number.POSITIVE_INFINITY
  for (const [hex, count] of counts) {
    if (count < bestCount) {
      best = hex
      bestCount = count
    }
  }
  return best
}

function isHexColour(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value)
}

export class TagStore {
  private session = createCheckSession<TagPlan>()
  /** ref -> badges, rebuilt whenever the document changes. The fast tick asks per row. */
  private badgeCache = new Map<string, ContainerTagBadge[]>()
  private badgeCacheRevision = -1

  constructor(
    private store: HostStore,
    private refs: RefSource,
    private log: (message: string) => void
  ) {}

  // ---------- Reads ----------

  badgesFor(ref: string): ContainerTagBadge[] {
    const data = this.store.read()
    if (this.badgeCacheRevision !== this.store.version) {
      this.badgeCache = buildBadgeCache(data)
      this.badgeCacheRevision = this.store.version
    }
    return this.badgeCache.get(ref) ?? []
  }

  list(): Array<TagRecord & { memberCount: number; nameBadge: ContainerTagBadge[] }> {
    const data = this.store.read()
    const counts = new Map<string, number>()
    for (const ids of Object.values(data.members)) {
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return data.tags.map((tag) => ({
      ...tag,
      memberCount: counts.get(tag.id) ?? 0,
      nameBadge: [{ label: tag.name, color: tag.color }]
    }))
  }

  members(id: string): Array<{ ref: string; engine: string; name: string; status: string; present: boolean }> {
    const data = this.store.read()
    const out: Array<{ ref: string; engine: string; name: string; status: string; present: boolean }> = []
    for (const [ref, ids] of Object.entries(data.members)) {
      if (!ids.includes(id)) continue
      const [engine, ...rest] = ref.split(':')
      const live = this.refs.describe(ref)
      out.push({
        ref,
        engine,
        name: live?.name ?? rest.join(':'),
        status: live?.status ?? 'gone',
        present: live != null
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ---------- Create and edit ----------

  /** `id` is null when the form is creating a tag, set when a row's drawer is editing one. */
  check(id: string | null, raw: unknown): ModuleCheckReport {
    const data = this.store.read()
    const existing = id ? data.tags.find((t) => t.id === id) : undefined
    if (id && !existing) {
      return { ok: false, findings: [{ level: 'error', label: 'That tag no longer exists' }] }
    }

    const name = str(raw, 'name')
    const colour = str(raw, 'color')
    const description = str(raw, 'description')
    const applyToRaw = str(raw, 'applyTo') || 'none'
    const findings: ModuleCheckReport['findings'] = []

    if (!TAG_NAME_RE.test(name)) {
      findings.push({
        level: 'error',
        label: 'Name is not usable',
        detail: 'Up to 32 characters: letters, digits, underscore, space, dot or dash, starting with a letter or digit.'
      })
    } else if (data.tags.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) {
      findings.push({ level: 'error', label: `A tag called "${name}" already exists` })
    } else {
      findings.push({ level: 'pass', label: `Tag "${name}"` })
    }

    let resolvedColour = colour
    if (!colour) {
      resolvedColour = existing?.color || leastUsedColour(data.tags)
      findings.push({
        level: 'info',
        label: `Colour ${resolvedColour} chosen automatically`,
        detail: existing ? 'The current colour is kept.' : 'The least used colour in the palette.'
      })
    } else if (!isHexColour(colour)) {
      findings.push({ level: 'error', label: `"${colour}" is not a #rrggbb colour` })
    }

    if (description.length > MAX_DESCRIPTION) {
      findings.push({
        level: 'error',
        label: `Description is ${description.length} characters`,
        detail: `The limit is ${MAX_DESCRIPTION}.`
      })
    }

    const applyTo = applyToRaw as TagApplyTo
    const refs = this.resolveApplyTo(applyTo)
    if (applyTo !== 'none') {
      if (refs.length === 0) {
        findings.push({ level: 'warning', label: 'Nothing matches that selection right now' })
      } else {
        findings.push({
          level: 'pass',
          label: `Will be attached to ${refs.length} container${refs.length === 1 ? '' : 's'}`,
          detail: refs.slice(0, 20).join(', ') + (refs.length > 20 ? ', …' : '')
        })
      }
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    const values: TagValues = { name, color: resolvedColour, description, applyTo }
    return { ok, token: this.session.issue(raw, { values, refs }), findings }
  }

  apply(id: string | null, payload: unknown): OkResult {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const { values, refs } = taken.payload

    return this.store.update((data) => {
      let tag = id ? data.tags.find((t) => t.id === id) : undefined
      if (id && !tag) return { ok: false, error: 'that tag no longer exists' }
      if (tag) {
        tag.name = values.name
        tag.color = values.color
        tag.description = values.description
      } else {
        tag = {
          id: makeId('tg', new Set(data.tags.map((t) => t.id))),
          name: values.name,
          color: values.color,
          description: values.description,
          createdAt: Date.now()
        }
        data.tags.push(tag)
      }
      for (const ref of refs) attach(data, ref, tag.id)
      this.log(`tag "${tag.name}" ${id ? 'updated' : 'created'}, ${refs.length} member(s) added`)
      return { ok: true, data: tag.id }
    })
  }

  remove(id: string): OkResult {
    return this.store.update((data) => {
      const index = data.tags.findIndex((t) => t.id === id)
      if (index < 0) return { ok: false, error: 'no such tag' }
      const [removed] = data.tags.splice(index, 1)
      for (const [ref, ids] of Object.entries(data.members)) {
        const kept = ids.filter((tagId) => tagId !== id)
        if (kept.length) data.members[ref] = kept
        else delete data.members[ref]
      }
      this.log(`tag "${removed.name}" deleted`)
      return { ok: true }
    })
  }

  // ---------- Bulk ----------

  /**
   * Attach or detach one tag across a selection. A name that does not exist yet
   * is created on the spot with a colour from the palette: typing it into the
   * prompt is a clear enough statement of intent, and the alternative is
   * making the user leave the table to create it first.
   */
  bulk(keys: unknown, engine: unknown, mode: unknown, tagName: unknown): OkResult {
    const refs = Array.isArray(keys) ? keys.map((k) => `${String(engine)}:${String(k)}`) : []
    const name = typeof tagName === 'string' ? tagName.trim() : ''
    if (refs.length === 0) return { ok: false, error: 'nothing selected' }
    if (!TAG_NAME_RE.test(name)) return { ok: false, error: `"${name}" is not a usable tag name` }
    if (mode !== 'assign' && mode !== 'unassign') return { ok: false, error: 'unknown tag mode' }

    return this.store.update((data) => {
      let tag = data.tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
      if (!tag) {
        if (mode === 'unassign') return { ok: false, error: `no tag called "${name}"` }
        tag = {
          id: makeId('tg', new Set(data.tags.map((t) => t.id))),
          name,
          color: leastUsedColour(data.tags),
          description: '',
          createdAt: Date.now()
        }
        data.tags.push(tag)
        this.log(`tag "${name}" created by a bulk action, colour ${tag.color}`)
      }
      for (const ref of refs) {
        if (mode === 'assign') attach(data, ref, tag.id)
        else detach(data, ref, tag.id)
      }
      this.log(`tag "${tag.name}" ${mode === 'assign' ? 'added to' : 'removed from'} ${refs.length} container(s)`)
      return { ok: true, data: `${refs.length}` }
    })
  }

  /** Drop memberships whose container is gone, so the counts mean something. */
  prune(): OkResult {
    const live = new Set([...this.refs.dockerAll(), ...this.refs.incusAll()])
    return this.store.update((data) => {
      let removed = 0
      for (const ref of Object.keys(data.members)) {
        if (live.has(ref)) continue
        delete data.members[ref]
        removed++
      }
      this.log(`pruned ${removed} membership(s) whose container no longer exists`)
      return { ok: true, data: `${removed}` }
    })
  }

  /** Attach a tag by name during a create job, making it if it is new. Returns the tag id. */
  ensureAndAttach(name: string, refs: readonly string[]): void {
    if (!TAG_NAME_RE.test(name)) return
    this.store.update((data) => {
      let tag = data.tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
      if (!tag) {
        tag = {
          id: makeId('tg', new Set(data.tags.map((t) => t.id))),
          name,
          color: leastUsedColour(data.tags),
          description: '',
          createdAt: Date.now()
        }
        data.tags.push(tag)
      }
      for (const ref of refs) attach(data, ref, tag.id)
    })
  }

  private resolveApplyTo(applyTo: TagApplyTo): string[] {
    switch (applyTo) {
      case 'all-running-docker':
        return this.refs.dockerRunning()
      case 'all-docker':
        return this.refs.dockerAll()
      case 'all-incus':
        return this.refs.incusAll()
      case 'all':
        return [...this.refs.dockerAll(), ...this.refs.incusAll()]
      default:
        return []
    }
  }
}

function attach(data: ContainerHostData, ref: string, tagId: string): void {
  const ids = data.members[ref] ?? []
  if (!ids.includes(tagId)) data.members[ref] = [...ids, tagId]
  else data.members[ref] = ids
}

function detach(data: ContainerHostData, ref: string, tagId: string): void {
  const ids = data.members[ref]
  if (!ids) return
  const kept = ids.filter((id) => id !== tagId)
  if (kept.length) data.members[ref] = kept
  else delete data.members[ref]
}

function buildBadgeCache(data: ContainerHostData): Map<string, ContainerTagBadge[]> {
  const byId = new Map(data.tags.map((t) => [t.id, t]))
  const out = new Map<string, ContainerTagBadge[]>()
  for (const [ref, ids] of Object.entries(data.members)) {
    const badges: ContainerTagBadge[] = []
    for (const id of ids) {
      const tag = byId.get(id)
      if (tag) badges.push({ label: tag.name, color: tag.color })
    }
    if (badges.length) out.set(ref, badges)
  }
  return out
}
