/**
 * Turning what the user typed into a create form into something that can be
 * checked. Everything here is pure and returns its complaints rather than
 * throwing, because a check reports every problem at once instead of stopping
 * at the first.
 */

// ---------- Environment ----------

export interface EnvParse {
  entries: string[]
  /** 1-based line numbers that are neither blank, a comment, nor `KEY=VALUE`. */
  badLines: number[]
}

/** `KEY=VALUE` per line. `#` starts a comment; a blank line is nothing. */
export function parseEnvLines(text: string): EnvParse {
  const entries: string[] = []
  const badLines: number[] = []
  const lines = String(text ?? '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) {
      badLines.push(i + 1)
      continue
    }
    entries.push(line)
  }
  return { entries, badLines }
}

// ---------- Ports ----------

export interface PortMapping {
  hostStart: number
  hostEnd: number
  containerPort: number
  proto: 'tcp' | 'udp'
  /**
   * True for the plain `host:container` form. It publishes one fixed host
   * port, so it can only ever describe a single container.
   */
  single: boolean
}

export interface PortParse {
  mappings: PortMapping[]
  errors: string[]
}

const PORT_RE = /^(\d{1,5})(?:-(\d{1,5}))?:(\d{1,5})(?:\/(tcp|udp))?$/

/** `8080-8082:80/tcp, 9000:9000` - a range per container, or one fixed pair. */
export function parsePorts(text: string): PortParse {
  const mappings: PortMapping[] = []
  const errors: string[] = []
  for (const raw of String(text ?? '').split(',')) {
    const spec = raw.trim()
    if (!spec) continue
    const m = PORT_RE.exec(spec)
    if (!m) {
      errors.push(`"${spec}" is not hostStart-hostEnd:containerPort[/proto]`)
      continue
    }
    const hostStart = Number(m[1])
    const hostEnd = m[2] === undefined ? hostStart : Number(m[2])
    const containerPort = Number(m[3])
    const proto = (m[4] as 'tcp' | 'udp') ?? 'tcp'
    if (!inPortRange(hostStart) || !inPortRange(hostEnd) || !inPortRange(containerPort)) {
      errors.push(`"${spec}" has a port outside 1-65535`)
      continue
    }
    if (hostEnd < hostStart) {
      errors.push(`"${spec}" ends before it starts`)
      continue
    }
    mappings.push({ hostStart, hostEnd, containerPort, proto, single: m[2] === undefined })
  }
  for (let i = 0; i < mappings.length; i++) {
    for (let j = i + 1; j < mappings.length; j++) {
      if (rangesOverlap(mappings[i], mappings[j])) {
        errors.push(
          `host ports ${mappings[i].hostStart}-${mappings[i].hostEnd} and ` +
            `${mappings[j].hostStart}-${mappings[j].hostEnd} overlap`
        )
      }
    }
  }
  return { mappings, errors }
}

function inPortRange(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

function rangesOverlap(a: PortMapping, b: PortMapping): boolean {
  if (a.proto !== b.proto) return false
  return a.hostStart <= b.hostEnd && b.hostStart <= a.hostEnd
}

/** The host ports the i-th container of a job would take (0-based). */
export function portsForIndex(mappings: readonly PortMapping[], index: number): Array<{ host: number; container: number; proto: string }> {
  return mappings.map((m) => ({
    host: m.hostStart + index,
    container: m.containerPort,
    proto: m.proto
  }))
}

// ---------- IPv4 ----------

export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out
}

export function intToIp(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

export interface Cidr {
  /** First address of the block, including the network address itself. */
  network: number
  prefix: number
  /** Total addresses in the block, network and broadcast included. */
  size: number
  broadcast: number
}

export function parseCidr(text: string): Cidr | null {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const base = ipToInt(m[1])
  const prefix = Number(m[2])
  if (base == null || prefix < 0 || prefix > 32) return null
  const size = prefix === 0 ? 2 ** 32 : 2 ** (32 - prefix)
  const network = Math.floor(base / size) * size
  return { network, prefix, size, broadcast: network + size - 1 }
}

export function cidrContains(cidr: Cidr, ip: number): boolean {
  return ip >= cidr.network && ip <= cidr.broadcast
}

export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  return a.network <= b.broadcast && b.network <= a.broadcast
}

/** Addresses that can be handed to a container: not the network or broadcast address. */
export function usableAddresses(cidr: Cidr): number {
  return cidr.size > 2 ? cidr.size - 2 : 0
}

export interface IpRange {
  first: number
  last: number
  count: number
}

/**
 * Either a CIDR (`10.0.0.0/24`) or an explicit `first-last` pair. Both end up
 * as the same inclusive range, which is what assigning addresses in order needs.
 */
export function parseIpRange(text: string): IpRange | null {
  const spec = String(text ?? '').trim()
  if (!spec) return null
  if (spec.includes('/')) {
    const cidr = parseCidr(spec)
    if (!cidr) return null
    // Skip the network and broadcast addresses: neither can be given out.
    const first = cidr.size > 2 ? cidr.network + 1 : cidr.network
    const last = cidr.size > 2 ? cidr.broadcast - 1 : cidr.broadcast
    return { first, last, count: last - first + 1 }
  }
  const dash = spec.indexOf('-')
  if (dash < 0) {
    const single = ipToInt(spec)
    return single == null ? null : { first: single, last: single, count: 1 }
  }
  const first = ipToInt(spec.slice(0, dash))
  const last = ipToInt(spec.slice(dash + 1))
  if (first == null || last == null || last < first) return null
  return { first, last, count: last - first + 1 }
}

// ---------- Memory ----------

const MEM_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4
}

/**
 * `512m`, `1GiB`, `2048`. Both Docker and Incus mean binary multiples by every
 * one of those suffixes, so there is only one table.
 */
export function parseMemory(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(String(text ?? '').trim())
  if (!m) return null
  const value = Number(m[1])
  const unit = MEM_UNITS[m[2].toLowerCase()]
  if (!Number.isFinite(value) || unit === undefined) return null
  return Math.round(value * unit)
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

// ---------- Names ----------

export const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
export const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/** `web-001`, `web-002`, … - three digits so a sorted listing stays in order to 999. */
export function generatedNames(prefix: string, count: number): string[] {
  const out: string[] = []
  for (let i = 1; i <= count; i++) out.push(`${prefix}${String(i).padStart(3, '0')}`)
  return out
}

/** A glob with `*`, or a plain substring when there is no `*` in it. */
export function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes('*')) return value.toLowerCase().includes(pattern.toLowerCase())
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}
