/**
 * The incus CLI, as far as this module uses it. Incus manages system
 * containers and virtual machines through one command and one JSON shape, so
 * everything here is `incus <verb> --format json` parsed into the flat rows a
 * table block can read.
 */
import type { IncusInstance, OkResult } from '@shared/types'
import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'

/**
 * What Incus accepts as an instance name: a letter, then letters, digits and
 * hyphens. Names reach here from a table row, so they are checked against this
 * before being quoted rather than only quoted - a name that cannot be right is
 * a bug worth refusing, not something to pass to the daemon.
 */
export const INCUS_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/

/** Profile, network, pool and image names are looser than instance names but still not free-form. */
export const INCUS_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

export type IncusAction = 'start' | 'stop' | 'restart' | 'delete'

/** The subset of `incus list --format json` this module reads. */
interface RawInstance {
  name?: string
  type?: string
  status?: string
  profiles?: string[]
  snapshots?: unknown[] | null
  config?: Record<string, string>
  expanded_config?: Record<string, string>
  state?: {
    memory?: { usage?: number }
    network?: Record<string, { addresses?: Array<{ family?: string; scope?: string; address?: string }> }> | null
  } | null
}

function parseJson<T>(out: string): T | null {
  const trimmed = out.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

/**
 * The image an instance came from. Incus records it in the config as
 * `image.description` (a human name) or the os/release pair; nothing in the
 * API reports "the image you typed at launch", so this is the closest thing.
 */
function imageOf(raw: RawInstance): string {
  const config = { ...(raw.config ?? {}), ...(raw.expanded_config ?? {}) }
  const description = config['image.description']
  if (description) return description
  const os = config['image.os']
  const release = config['image.release'] ?? config['image.version']
  if (os) return release ? `${os} ${release}` : os
  return ''
}

/** Global-scope IPv4 only: the loopback and link-local addresses every instance has say nothing. */
function ipv4Of(raw: RawInstance): string[] {
  const out: string[] = []
  for (const [iface, entry] of Object.entries(raw.state?.network ?? {})) {
    if (iface === 'lo') continue
    for (const addr of entry?.addresses ?? []) {
      if (addr.family !== 'inet' || addr.scope !== 'global') continue
      if (addr.address) out.push(addr.address)
    }
  }
  return out
}

/** Turn `incus list --format json` into the table rows. Tags are filled in by the caller. */
export function parseInstances(stdout: string): IncusInstance[] {
  const raw = parseJson<RawInstance[]>(stdout)
  if (!Array.isArray(raw)) return []
  const out: IncusInstance[] = []
  for (const entry of raw) {
    const name = String(entry.name ?? '')
    if (!name) continue
    const status = String(entry.status ?? '')
    const ipv4 = ipv4Of(entry)
    const profiles = Array.isArray(entry.profiles) ? entry.profiles.map(String) : []
    out.push({
      name,
      type: entry.type === 'virtual-machine' ? 'vm' : 'container',
      status,
      running: status.toLowerCase() === 'running',
      ipv4,
      ipv4Text: ipv4.join(', '),
      image: imageOf(entry),
      memUsageBytes: Number(entry.state?.memory?.usage ?? 0) || 0,
      snapshots: Array.isArray(entry.snapshots) ? entry.snapshots.length : 0,
      profiles,
      profilesText: profiles.join(', '),
      tagBadges: [],
      tagsText: ''
    })
  }
  return out
}

export interface IncusListRow {
  name: string
  description: string
  detail: string
  /** Second detail column - what it means depends on the listing (driver, usage, size). */
  extra: string
}

export class IncusCli {
  constructor(private ctx: ModuleContext) {}

  private async run(cmd: string, timeoutMs = 60000): Promise<OkResult> {
    const res = await this.ctx.exec(cmd, { timeoutMs })
    return res.code === 0
      ? { ok: true, data: res.stdout.trim() }
      : { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
  }

  action(name: string, action: IncusAction): Promise<OkResult> {
    if (!INCUS_NAME_RE.test(name)) {
      return Promise.resolve({ ok: false, error: 'invalid instance name' })
    }
    // `incus delete` refuses a running instance without --force, and a user who
    // asked to delete one from a row action has already been through a confirm.
    const cmd = action === 'delete' ? `incus delete --force ${shQuote(name)}` : `incus ${action} ${shQuote(name)}`
    return this.run(cmd, 120000)
  }

  /**
   * Everything the list tick does not carry: the full config, the devices and
   * the expanded profile values. One call, made only when a row is opened.
   */
  async inspect(name: string): Promise<Record<string, unknown> | null> {
    if (!INCUS_NAME_RE.test(name)) return null
    const res = await this.ctx.exec(
      `incus list ${shQuote(`^${name}$`)} --format json 2>/dev/null`,
      { timeoutMs: 20000 }
    )
    const entry = parseJson<RawInstance[]>(res.stdout)?.[0]
    if (!entry) return null
    const config = { ...(entry.config ?? {}), ...(entry.expanded_config ?? {}) }
    const ipv4 = ipv4Of(entry)
    return {
      name: entry.name ?? name,
      type: entry.type === 'virtual-machine' ? 'vm' : 'container',
      status: entry.status ?? '',
      image: imageOf(entry),
      ipv4Text: ipv4.join(', '),
      profilesText: (entry.profiles ?? []).join(', '),
      snapshots: Array.isArray(entry.snapshots) ? entry.snapshots.length : 0,
      memUsageBytes: Number(entry.state?.memory?.usage ?? 0) || 0,
      cpuLimit: config['limits.cpu'] ?? '',
      memoryLimit: config['limits.memory'] ?? '',
      architecture: config['image.architecture'] ?? '',
      createdBy: config['user.bored-manager'] ?? '',
      tagsText: config['user.bored-manager.tags'] ?? ''
    }
  }

  /** `incus image list`: what can be launched without downloading anything. */
  async images(): Promise<IncusListRow[]> {
    const res = await this.ctx.exec(`incus image list --format json 2>/dev/null`, { timeoutMs: 30000 })
    interface Raw {
      fingerprint?: string
      aliases?: Array<{ name?: string }>
      properties?: Record<string, string>
      architecture?: string
      size?: number
    }
    const raw = parseJson<Raw[]>(res.stdout) ?? []
    return raw.map((i) => ({
      name: i.aliases?.[0]?.name || String(i.fingerprint ?? '').slice(0, 12),
      description: i.properties?.['description'] ?? '',
      detail: String(i.architecture ?? ''),
      extra: formatBytes(Number(i.size ?? 0) || 0)
    }))
  }

  async profiles(): Promise<IncusListRow[]> {
    const res = await this.ctx.exec(`incus profile list --format json 2>/dev/null`, { timeoutMs: 20000 })
    interface Raw {
      name?: string
      description?: string
      used_by?: unknown[]
      devices?: Record<string, unknown>
    }
    const raw = parseJson<Raw[]>(res.stdout) ?? []
    return raw.map((p) => ({
      name: String(p.name ?? ''),
      description: String(p.description ?? ''),
      detail: `${Object.keys(p.devices ?? {}).length} devices`,
      extra: `${(p.used_by ?? []).length} in use`
    }))
  }

  async networks(): Promise<IncusListRow[]> {
    const res = await this.ctx.exec(`incus network list --format json 2>/dev/null`, { timeoutMs: 20000 })
    interface Raw {
      name?: string
      type?: string
      managed?: boolean
      used_by?: unknown[]
      config?: Record<string, string>
    }
    const raw = parseJson<Raw[]>(res.stdout) ?? []
    return raw.map((n) => ({
      name: String(n.name ?? ''),
      description: String(n.type ?? ''),
      detail: n.config?.['ipv4.address'] ?? '',
      extra: `${(n.used_by ?? []).length} in use`
    }))
  }

  async pools(): Promise<IncusListRow[]> {
    const res = await this.ctx.exec(`incus storage list --format json 2>/dev/null`, { timeoutMs: 20000 })
    interface Raw {
      name?: string
      driver?: string
      used_by?: unknown[]
      config?: Record<string, string>
    }
    const raw = parseJson<Raw[]>(res.stdout) ?? []
    return raw.map((p) => ({
      name: String(p.name ?? ''),
      description: String(p.driver ?? ''),
      detail: p.config?.['source'] ?? '',
      extra: `${(p.used_by ?? []).length} in use`
    }))
  }

  /** Instance names that already exist, for a create check. */
  async existingNames(): Promise<Set<string>> {
    const res = await this.ctx.exec(`incus list --format json 2>/dev/null`, { timeoutMs: 30000 })
    return new Set(parseInstances(res.stdout).map((i) => i.name))
  }
}

/** Sizes come back in bytes here and end up in a plain string column, so they are formatted at the source. */
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}
