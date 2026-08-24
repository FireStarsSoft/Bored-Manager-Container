/**
 * What a check needs to know about the machine before it says yes. Batched
 * into one shell round trip wherever possible: a check is a deliberate click,
 * but over SSH ten small commands still cost ten latencies.
 */
import type { ModuleContext } from '@shared/modules'
import { shQuote, splitSections } from '@shared/shell'
import { ipToInt, parseCidr, type Cidr } from './parse'

export interface HostProbe {
  /** True when `docker info` answered, i.e. the daemon is reachable as this user. */
  dockerOk: boolean
  dockerError: string
  incusPresent: boolean
  /** Container names already taken, so a generated one cannot collide. */
  dockerNames: Set<string>
  /** `tcp:8080` for every host port something is already listening on. */
  usedHostPorts: Set<string>
  memTotalBytes: number
  memAvailableBytes: number
  /** Entries in the IPv4 neighbour table right now. */
  neighCount: number
  /** Where the kernel starts throwing neighbour entries away. */
  gcThresh3: number
  networks: Map<string, { name: string; driver: string }>
  /** Interfaces that are up, for a macvlan/ipvlan parent. */
  interfaces: string[]
}

const PROBE_CMD = [
  `echo '===INFO==='; docker info --format ok 2>&1`,
  `echo '===NAMES==='; docker ps -a --format '{{.Names}}' 2>/dev/null`,
  `echo '===DOCKERPORTS==='; docker ps --format '{{.Ports}}' 2>/dev/null`,
  `echo '===LISTEN==='; (ss -Htuln 2>/dev/null || netstat -tuln 2>/dev/null || true)`,
  `echo '===MEM==='; head -n 3 /proc/meminfo 2>/dev/null`,
  `echo '===NEIGH==='; ip -4 neigh 2>/dev/null | wc -l`,
  `echo '===GC==='; cat /proc/sys/net/ipv4/neigh/default/gc_thresh3 2>/dev/null`,
  `echo '===NETWORKS==='; docker network ls --format '{{json .}}' 2>/dev/null`,
  `echo '===LINKS==='; ip -o link show up 2>/dev/null`,
  `echo '===INCUS==='; if command -v incus >/dev/null 2>&1; then echo yes; else echo no; fi`
].join('; ')

export async function probeHost(ctx: ModuleContext): Promise<HostProbe> {
  const res = await ctx.exec(PROBE_CMD, { timeoutMs: 45000 })
  const s = splitSections(res.stdout)
  const info = (s.get('INFO') ?? '').trim()
  const meminfo = s.get('MEM') ?? ''
  return {
    dockerOk: info === 'ok',
    dockerError: info === 'ok' ? '' : info.split('\n').filter(Boolean).slice(-1)[0] ?? 'docker did not answer',
    incusPresent: (s.get('INCUS') ?? '').trim() === 'yes',
    dockerNames: new Set(
      (s.get('NAMES') ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    ),
    usedHostPorts: collectUsedPorts(s.get('DOCKERPORTS') ?? '', s.get('LISTEN') ?? ''),
    memTotalBytes: meminfoValue(meminfo, 'MemTotal'),
    memAvailableBytes: meminfoValue(meminfo, 'MemAvailable') || meminfoValue(meminfo, 'MemFree'),
    neighCount: Number((s.get('NEIGH') ?? '').trim()) || 0,
    gcThresh3: Number((s.get('GC') ?? '').trim()) || 0,
    networks: parseNetworkList(s.get('NETWORKS') ?? ''),
    interfaces: parseLinks(s.get('LINKS') ?? '')
  }
}

/** /proc/meminfo is in kB, whatever the header says. */
function meminfoValue(text: string, key: string): number {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m ? Number(m[1]) * 1024 : 0
}

/**
 * Both sources at once: `docker ps` knows the ports its own containers
 * published, `ss` knows everything else listening on the host. A port that
 * shows up in either is taken.
 */
function collectUsedPorts(dockerPorts: string, listen: string): Set<string> {
  const out = new Set<string>()
  for (const m of dockerPorts.matchAll(/:(\d{1,5})->\d{1,5}\/(tcp|udp)/g)) {
    out.add(`${m[2]}:${m[1]}`)
  }
  for (const line of listen.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 2) continue
    const proto = fields[0].startsWith('udp') ? 'udp' : fields[0].startsWith('tcp') ? 'tcp' : ''
    if (!proto) continue
    for (const field of fields.slice(1)) {
      const m = /:(\d{1,5})$/.exec(field)
      // The peer column of a listening socket is `*:*` or `0.0.0.0:*`, so only
      // a field ending in a real number is a port this machine holds.
      if (m && field !== '*:*') {
        out.add(`${proto}:${m[1]}`)
        break
      }
    }
  }
  return out
}

function parseNetworkList(text: string): Map<string, { name: string; driver: string }> {
  const out = new Map<string, { name: string; driver: string }>()
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      const raw = JSON.parse(s) as { Name?: string; Driver?: string }
      if (raw.Name) out.set(raw.Name, { name: raw.Name, driver: String(raw.Driver ?? '') })
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

/** `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ...` */
function parseLinks(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\d+:\s+([^:@]+)[:@]/.exec(line.trim())
    if (!m) continue
    const name = m[1].trim()
    if (name && name !== 'lo') out.push(name)
  }
  return out
}

// ---------- Targeted lookups ----------

export interface NetworkDetail {
  name: string
  driver: string
  subnets: Cidr[]
  gateways: string[]
  /** Addresses already handed out on this network. */
  usedIps: Set<number>
}

const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export async function inspectNetwork(ctx: ModuleContext, name: string): Promise<NetworkDetail | null> {
  if (!NETWORK_NAME_RE.test(name)) return null
  const res = await ctx.exec(`docker network inspect ${shQuote(name)} --format '{{json .}}' 2>/dev/null`, {
    timeoutMs: 20000
  })
  const line = res.stdout.split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) return null
  interface Raw {
    Name?: string
    Driver?: string
    IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> }
    Containers?: Record<string, { IPv4Address?: string }>
  }
  let raw: Raw
  try {
    raw = JSON.parse(line) as Raw
  } catch {
    return null
  }
  const subnets: Cidr[] = []
  const gateways: string[] = []
  for (const entry of raw.IPAM?.Config ?? []) {
    const cidr = entry.Subnet ? parseCidr(entry.Subnet) : null
    if (cidr) subnets.push(cidr)
    if (entry.Gateway) gateways.push(entry.Gateway)
  }
  const usedIps = new Set<number>()
  for (const container of Object.values(raw.Containers ?? {})) {
    const value = ipToInt(String(container.IPv4Address ?? '').split('/')[0])
    if (value != null) usedIps.add(value)
  }
  return { name: String(raw.Name ?? name), driver: String(raw.Driver ?? ''), subnets, gateways, usedIps }
}

/** True when the image is already on the machine, so a create does not have to pull. */
export async function imagePresent(ctx: ModuleContext, image: string): Promise<boolean> {
  if (!image || /[\s'"]/.test(image)) return false
  const res = await ctx.exec(`docker image inspect ${shQuote(image)} >/dev/null 2>&1; echo $?`, {
    timeoutMs: 20000
  })
  return res.stdout.trim().endsWith('0')
}

/** Host routes, to warn about a new subnet that overlaps one the machine already uses. */
export async function hostRoutes(ctx: ModuleContext): Promise<Cidr[]> {
  const res = await ctx.exec(`ip -4 route show 2>/dev/null`, { timeoutMs: 15000 })
  const out: Cidr[] = []
  for (const line of res.stdout.split('\n')) {
    const first = line.trim().split(/\s+/)[0]
    if (!first || !first.includes('/')) continue
    const cidr = parseCidr(first)
    if (cidr) out.push(cidr)
  }
  return out
}

/** True when the machine can run a hardware-accelerated VM. */
export async function hasKvm(ctx: ModuleContext): Promise<boolean> {
  const res = await ctx.exec(`test -e /dev/kvm; echo $?`, { timeoutMs: 15000 })
  return res.stdout.trim().endsWith('0')
}
