/**
 * Creating a Docker network, with the check that matters most for the L2
 * drivers: an ipvlan or macvlan network puts every container straight onto the
 * LAN, which is exactly what people reach for it for and also the thing that
 * quietly breaks host-to-container traffic and fills the neighbour table.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { shQuote } from '@shared/shell'
import {
  cidrsOverlap,
  cidrContains,
  intToIp,
  ipToInt,
  parseCidr,
  parseIpRange,
  usableAddresses,
  type Cidr
} from './parse'
import { hostRoutes, inspectNetwork, probeHost } from './probe'

const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
/** Above this many addresses the default neighbour table starts to matter. */
const LARGE_SUBNET = 512

interface NetworkPlan {
  name: string
  driver: string
  mode: string
  parent: string
  subnet: string
  gateway: string
  ipRange: string
}

function text(values: unknown, key: string): string {
  const v = (values as Record<string, unknown>)?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

export class NetworkCreator {
  private session = createCheckSession<NetworkPlan>()

  constructor(private ctx: ModuleContext) {}

  async check(input: unknown): Promise<ModuleCheckReport> {
    const findings: ModuleCheckFinding[] = []
    const name = text(input, 'name')
    const driver = text(input, 'driver') || 'bridge'
    const mode = text(input, 'mode') || 'l2'
    const parent = text(input, 'parent')
    const subnetText = text(input, 'subnet')
    const gatewayText = text(input, 'gateway')
    const rangeText = text(input, 'ipRange')
    const layer2 = driver === 'ipvlan' || driver === 'macvlan'

    const probe = await probeHost(this.ctx)
    if (!probe.dockerOk) {
      return {
        ok: false,
        findings: [{ level: 'error', label: 'Docker is not reachable', detail: probe.dockerError }]
      }
    }

    if (!NETWORK_NAME_RE.test(name)) {
      findings.push({
        level: 'error',
        label: 'Name is not usable',
        detail: 'Start with a letter or digit, then letters, digits, underscore, dot or dash.'
      })
    } else if (probe.networks.has(name)) {
      findings.push({ level: 'error', label: `A network called "${name}" already exists` })
    } else {
      findings.push({ level: 'pass', label: `Network "${name}" (${driver}${layer2 ? `, ${mode}` : ''})` })
    }

    if (layer2) {
      if (!parent) {
        findings.push({ level: 'error', label: `A ${driver} network needs a parent interface` })
      } else if (!probe.interfaces.includes(parent)) {
        findings.push({
          level: 'error',
          label: `Interface "${parent}" is not up on this machine`,
          detail: probe.interfaces.length ? `Up now: ${probe.interfaces.join(', ')}` : undefined
        })
      } else {
        findings.push({ level: 'pass', label: `Parent interface ${parent} is up` })
      }
    }

    const subnet = parseCidr(subnetText)
    if (!subnet) {
      findings.push({ level: 'error', label: `"${subnetText}" is not a CIDR subnet (for example 10.20.0.0/24)` })
    } else {
      findings.push(...(await this.checkSubnet(subnet, subnetText)))
      const usable = usableAddresses(subnet)
      findings.push({
        level: 'info',
        label: `The subnet provides ${usable} usable address(es)`
      })
      if (usable > LARGE_SUBNET) {
        findings.push({
          level: 'warning',
          label: `A subnet this size can outgrow the default neighbour table`,
          detail: `The kernel starts evicting entries above net.ipv4.neigh.default.gc_thresh3 (currently ${
            probe.gcThresh3 || 'unknown'
          }). Raise it under Network - Host tuning.`
        })
      }
      const gateway = ipToInt(gatewayText)
      if (!gatewayText) {
        findings.push({ level: 'error', label: 'A gateway address is required' })
      } else if (gateway == null) {
        findings.push({ level: 'error', label: `"${gatewayText}" is not an IPv4 address` })
      } else if (!cidrContains(subnet, gateway)) {
        findings.push({ level: 'error', label: `Gateway ${gatewayText} is outside ${subnetText}` })
      }
      if (rangeText) {
        const range = parseIpRange(rangeText)
        if (!range) {
          findings.push({ level: 'error', label: `"${rangeText}" is not a CIDR or first-last pair` })
        } else if (range.first < subnet.network || range.last > subnet.broadcast) {
          findings.push({
            level: 'error',
            label: `The allocation range ${intToIp(range.first)}-${intToIp(range.last)} is outside ${subnetText}`
          })
        } else {
          findings.push({
            level: 'pass',
            label: `Addresses will be handed out from ${intToIp(range.first)} to ${intToIp(range.last)}`
          })
        }
      }
    }

    if (layer2) {
      findings.push({
        level: 'warning',
        label: `The host will not be able to reach containers on a ${driver} network directly`,
        detail:
          'The kernel drops traffic between a parent interface and its own macvlan/ipvlan children. Reach them from another machine on the LAN, or add a second macvlan interface on the host.'
      })
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return {
      ok,
      token: this.session.issue(input, {
        name,
        driver,
        mode,
        parent,
        subnet: subnetText,
        gateway: gatewayText,
        ipRange: rangeText
      }),
      findings
    }
  }

  /** An overlap with another Docker network breaks routing; one with a host route only might. */
  private async checkSubnet(subnet: Cidr, label: string): Promise<ModuleCheckFinding[]> {
    const out: ModuleCheckFinding[] = []
    const probe = await probeHost(this.ctx)
    for (const existing of probe.networks.keys()) {
      const detail = await inspectNetwork(this.ctx, existing)
      if (!detail) continue
      for (const other of detail.subnets) {
        if (cidrsOverlap(subnet, other)) {
          out.push({
            level: 'error',
            label: `${label} overlaps the "${existing}" network (${intToIp(other.network)}/${other.prefix})`
          })
        }
      }
    }
    for (const route of await hostRoutes(this.ctx)) {
      if (!cidrsOverlap(subnet, route)) continue
      out.push({
        level: 'warning',
        label: `${label} overlaps a route the host already has (${intToIp(route.network)}/${route.prefix})`,
        detail: 'Traffic for those addresses may not go where you expect.'
      })
    }
    return out
  }

  async apply(payload: unknown): Promise<OkResult> {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload

    const args = ['docker', 'network', 'create', '-d', shQuote(plan.driver)]
    if (plan.parent) args.push('-o', shQuote(`parent=${plan.parent}`))
    if (plan.driver === 'ipvlan') args.push('-o', shQuote(`ipvlan_mode=${plan.mode}`))
    args.push('--subnet', shQuote(plan.subnet), '--gateway', shQuote(plan.gateway))
    if (plan.ipRange) args.push('--ip-range', shQuote(plan.ipRange))
    args.push(shQuote(plan.name))

    const res = await this.ctx.exec(args.join(' '), { timeoutMs: 60000 })
    if (res.code !== 0) {
      return { ok: false, error: (res.stderr || res.stdout).trim() || `exit code ${res.code}` }
    }
    this.ctx.log(`created ${plan.driver} network "${plan.name}" on ${plan.subnet}`)
    return { ok: true, data: res.stdout.trim() }
  }
}
