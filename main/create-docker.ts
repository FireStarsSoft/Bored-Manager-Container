/**
 * "Create N Docker containers", with the check that has to pass first. Every
 * rule below is one finding, so the report reads as a list of things that were
 * looked at rather than one verdict - and the pass findings spell out what will
 * actually be created, because the resolved plan is the thing worth confirming.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { shQuote } from '@shared/shell'
import { effectiveRules } from './rules'
import {
  DOCKER_NAME_RE,
  formatBytes,
  generatedNames,
  intToIp,
  parseEnvLines,
  parseIpRange,
  parseMemory,
  parsePorts,
  portsForIndex,
  type PortMapping
} from './parse'
import { imagePresent, inspectNetwork, probeHost, type NetworkDetail } from './probe'
import { whenFinished, type FleetJobs, type JobItemSpec } from './jobs'
import { dockerRef } from './service'
import type { TagStore } from './tags'
import type { HostStore, TemplateRecord } from './store'
import { makeId } from './store'

/** Docker refuses a startup script longer than this fits comfortably in an argv. */
const MAX_SCRIPT_BYTES = 8 * 1024

const L2_DRIVERS = new Set(['ipvlan', 'macvlan'])

export interface DockerCreateValues {
  template: string
  count: number
  namePrefix: string
  image: string
  env: string
  startupScript: string
  restartPolicy: string
  cpus: string
  memory: string
  network: string
  ipRange: string
  ports: string
  tag: string
  pull: boolean
  saveAsTemplate: boolean
  templateName: string
  concurrency: string
  onError: string
}

/** What the check worked out and the apply runs verbatim. */
interface DockerPlan {
  names: string[]
  image: string
  env: string[]
  script: string
  restartPolicy: string
  cpus: string
  memory: string
  network: string
  ips: string[]
  ports: PortMapping[]
  tag: string
  pull: boolean
  concurrency: 'sequential' | 'parallel'
  onError: 'continue' | 'abort'
  saveAsTemplate: boolean
  templateName: string
  values: Record<string, string | number | boolean>
}

function text(values: unknown, key: string): string {
  const v = (values as Record<string, unknown>)?.[key]
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

function flag(values: unknown, key: string): boolean {
  return (values as Record<string, unknown>)?.[key] === true
}

function num(values: unknown, key: string): number {
  return Number((values as Record<string, unknown>)?.[key])
}

/**
 * A field the user typed wins over the template, and the template wins over
 * nothing - so loading a template and then changing one box does what it looks
 * like it does.
 */
function mergeTemplate(
  raw: unknown,
  templates: readonly TemplateRecord[]
): Record<string, string | number | boolean> {
  const values = { ...((raw as Record<string, string | number | boolean>) ?? {}) }
  const templateId = text(raw, 'template')
  if (!templateId) return values
  const template = templates.find((t) => t.id === templateId)
  if (!template) return values
  const merged = { ...template.values }
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === undefined || value === null) continue
    merged[key] = value
  }
  merged['template'] = templateId
  return merged
}

export class DockerCreator {
  private session = createCheckSession<DockerPlan>()

  constructor(
    private ctx: ModuleContext,
    private store: HostStore,
    private jobs: FleetJobs,
    private tags: TagStore
  ) {}

  async check(raw: unknown): Promise<ModuleCheckReport> {
    const rules = effectiveRules(this.ctx)
    const values = mergeTemplate(raw, this.store.read().templates)
    const findings: ModuleCheckFinding[] = []

    const count = Math.trunc(num(values, 'count'))
    const prefix = text(values, 'namePrefix')
    const image = text(values, 'image')
    const network = text(values, 'network')
    const pull = flag(values, 'pull')

    const probe = await probeHost(this.ctx)

    // R-CD-01
    if (probe.dockerOk) {
      findings.push({ level: 'pass', label: 'Docker is reachable' })
    } else {
      findings.push({
        level: 'error',
        label: 'Docker is not reachable on this machine',
        // These commands are never elevated, so a sudo password does not help:
        // it is the connected user that has to be able to reach the daemon.
        detail: `${probe.dockerError}. Module settings can install Docker; if it is installed, add the connected user to the docker group or connect as root.`
      })
    }

    // R-CD-02
    if (!Number.isFinite(count) || count < 1 || count > rules.maxCreateCount) {
      findings.push({
        level: 'error',
        label: `Count must be between 1 and ${rules.maxCreateCount}`,
        detail: `You asked for ${Number.isFinite(count) ? count : 'nothing'}. The limit is a module rule you can change.`
      })
    }

    // R-CD-03 - the "use Incus for this" advisory.
    if (Number.isFinite(count) && count >= rules.preferIncusThreshold) {
      findings.push({
        level: 'warning',
        label: `Creating ${count} containers - Incus is recommended for bulk system containers (see the Incus page)`,
        detail:
          'Docker containers are meant to be one process each. For many long-lived machine-like containers, Incus manages them with less overhead per instance.'
      })
      if (!probe.incusPresent) {
        findings.push({
          level: 'info',
          label: 'Incus is not installed here',
          detail: 'Install the incus package and run `incus admin init` if you want to try that route.'
        })
      }
    }

    // R-CD-04
    const names = Number.isFinite(count) && count > 0 ? generatedNames(prefix, Math.min(count, rules.maxCreateCount)) : []
    if (!DOCKER_NAME_RE.test(prefix)) {
      findings.push({
        level: 'error',
        label: 'Name prefix is not usable',
        detail: 'Start with a letter or digit, then letters, digits, underscore, dot or dash.'
      })
    } else {
      const clashes = names.filter((n) => probe.dockerNames.has(n))
      if (clashes.length) {
        findings.push({
          level: 'error',
          label: `${clashes.length} of those names are taken`,
          detail: clashes.slice(0, 20).join(', ') + (clashes.length > 20 ? ', …' : '')
        })
      }
    }

    // R-CD-05
    if (!image) {
      findings.push({ level: 'error', label: 'An image is required' })
    } else if (await imagePresent(this.ctx, image)) {
      findings.push({ level: 'pass', label: `Image ${image} is already on this machine` })
    } else if (pull) {
      findings.push({
        level: 'info',
        label: `Image ${image} is not here yet and will be pulled`,
        detail: 'The first item of the job will take as long as the download does.'
      })
    } else {
      findings.push({
        level: 'error',
        label: `Image ${image} is not on this machine`,
        detail: 'Tick "Pull the image if missing", or pull it yourself first.'
      })
    }

    // R-CD-06
    const env = parseEnvLines(text(values, 'env'))
    if (env.badLines.length) {
      findings.push({
        level: 'error',
        label: `${env.badLines.length} environment line(s) are not KEY=VALUE`,
        detail: `Line(s) ${env.badLines.join(', ')}.`
      })
    }

    // R-CD-07
    const ports = parsePorts(text(values, 'ports'))
    for (const error of ports.errors) findings.push({ level: 'error', label: `Ports: ${error}` })
    if (ports.mappings.length && Number.isFinite(count) && count > 0) {
      findings.push(...this.checkPorts(ports.mappings, count, probe.usedHostPorts))
    }

    // R-CD-08
    let detail: NetworkDetail | null = null
    const ips: string[] = []
    if (network) {
      detail = await inspectNetwork(this.ctx, network)
      if (!detail) {
        findings.push({ level: 'error', label: `Network "${network}" does not exist` })
      } else {
        if (L2_DRIVERS.has(detail.driver)) {
          findings.push({
            level: 'warning',
            label: `"${network}" is a ${detail.driver} network - the host cannot reach these containers directly (L2 isolation)`,
            detail: 'Traffic between the host and its own macvlan/ipvlan children is dropped by the kernel; reach them from another machine on the LAN.'
          })
        }
        findings.push(...this.checkIpRange(text(values, 'ipRange'), count, detail, ips))
      }
    }

    // R-CD-09
    const memory = text(values, 'memory')
    if (memory) {
      const perContainer = parseMemory(memory)
      if (perContainer == null) {
        findings.push({ level: 'error', label: `"${memory}" is not a memory size (try 512m or 2g)` })
      } else if (Number.isFinite(count) && count > 0) {
        const wanted = perContainer * count
        const share = probe.memAvailableBytes ? (wanted / probe.memAvailableBytes) * 100 : 0
        if (probe.memTotalBytes && wanted > probe.memTotalBytes) {
          findings.push({
            level: 'error',
            label: `${formatBytes(wanted)} of memory is more than this machine has`,
            detail: `MemTotal is ${formatBytes(probe.memTotalBytes)}.`
          })
        } else if (share > rules.memHeadroomPct) {
          findings.push({
            level: 'warning',
            label: `${formatBytes(wanted)} is ${Math.round(share)}% of the memory currently available`,
            detail: `MemAvailable is ${formatBytes(probe.memAvailableBytes)}; the module warns above ${rules.memHeadroomPct}%.`
          })
        } else {
          findings.push({
            level: 'pass',
            label: `${formatBytes(wanted)} of ${formatBytes(probe.memAvailableBytes)} available memory`
          })
        }
      }
    }

    // R-CD-10 - the neighbour table only matters on an L2 network, where every
    // container is its own address on the LAN rather than behind the host.
    if (rules.enableArpAdvisory && detail && L2_DRIVERS.has(detail.driver) && probe.gcThresh3 > 0) {
      const projected = probe.neighCount + (Number.isFinite(count) ? count : 0)
      if (projected > 0.8 * probe.gcThresh3) {
        findings.push({
          level: 'warning',
          label: 'The neighbour table will be close to full',
          detail:
            `${projected} entries projected against a gc_thresh3 of ${probe.gcThresh3}. ` +
            'Raise it under Network - Host tuning before the kernel starts evicting entries.'
        })
      }
    }

    // R-CD-11
    const script = text(values, 'startupScript')
    if (script.length > MAX_SCRIPT_BYTES) {
      findings.push({
        level: 'error',
        label: `The startup script is ${script.length} characters`,
        detail: `The limit is ${MAX_SCRIPT_BYTES}. Bake anything longer into the image or mount it.`
      })
    } else if (/(^|\s)docker\s/.test(script)) {
      findings.push({
        level: 'info',
        label: 'The startup script calls docker',
        detail: 'That only works if the container has the socket mounted, which this form does not do.'
      })
    }

    const concurrency = text(values, 'concurrency') === 'parallel' ? 'parallel' : 'sequential'
    const onError = text(values, 'onError') === 'abort' ? 'abort' : 'continue'

    // The summary the user is really confirming.
    if (names.length) {
      findings.push({
        level: 'pass',
        label: `Will create ${names.length} container(s): ${names[0]}…${names[names.length - 1]}`,
        detail: [
          `image ${image || '?'}`,
          network ? `network ${network}` : 'default network',
          ips.length ? `addresses ${ips[0]}…${ips[ips.length - 1]}` : '',
          ports.mappings.length ? `ports ${text(values, 'ports')}` : '',
          `${concurrency}, ${onError} on error`
        ]
          .filter(Boolean)
          .join(', ')
      })
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    const plan: DockerPlan = {
      names,
      image,
      env: env.entries,
      script,
      restartPolicy: text(values, 'restartPolicy') || 'no',
      cpus: text(values, 'cpus'),
      memory,
      network,
      ips,
      ports: ports.mappings,
      tag: text(values, 'tag'),
      pull,
      concurrency,
      onError,
      saveAsTemplate: flag(values, 'saveAsTemplate'),
      templateName: text(values, 'templateName'),
      values
    }
    return { ok, token: this.session.issue(raw, plan), findings }
  }

  private checkPorts(
    mappings: readonly PortMapping[],
    count: number,
    used: ReadonlySet<string>
  ): ModuleCheckFinding[] {
    const out: ModuleCheckFinding[] = []
    for (const m of mappings) {
      const width = m.hostEnd - m.hostStart + 1
      if (m.single && count > 1) {
        out.push({
          level: 'error',
          label: `Port ${m.hostStart}:${m.containerPort} publishes one fixed host port`,
          detail: `Write it as a range (${m.hostStart}-${m.hostStart + count - 1}:${m.containerPort}) for ${count} containers.`
        })
        continue
      }
      if (width < count) {
        out.push({
          level: 'error',
          label: `Port range ${m.hostStart}-${m.hostEnd} only covers ${width} of ${count} containers`
        })
        continue
      }
    }
    const clashes: string[] = []
    for (let i = 0; i < count; i++) {
      for (const port of portsForIndex(mappings, i)) {
        if (used.has(`${port.proto}:${port.host}`)) clashes.push(`${port.host}/${port.proto}`)
      }
    }
    if (clashes.length) {
      out.push({
        level: 'error',
        label: `${clashes.length} host port(s) are already in use`,
        detail: clashes.slice(0, 20).join(', ') + (clashes.length > 20 ? ', …' : '')
      })
    } else if (mappings.length) {
      out.push({ level: 'pass', label: 'Every host port the job needs is free' })
    }
    return out
  }

  /** Fills `ips` with the addresses each container will be given, in order. */
  private checkIpRange(
    spec: string,
    count: number,
    detail: NetworkDetail,
    ips: string[]
  ): ModuleCheckFinding[] {
    if (!spec) return []
    const range = parseIpRange(spec)
    if (!range) {
      return [{ level: 'error', label: `"${spec}" is not a CIDR or a first-last address pair` }]
    }
    const out: ModuleCheckFinding[] = []
    if (detail.subnets.length) {
      const inside = detail.subnets.some((s) => range.first >= s.network && range.last <= s.broadcast)
      if (!inside) {
        out.push({
          level: 'error',
          label: `${intToIp(range.first)}-${intToIp(range.last)} is outside the network's subnet`,
          detail: detail.subnets.map((s) => `${intToIp(s.network)}/${s.prefix}`).join(', ')
        })
        return out
      }
    }
    const free: number[] = []
    for (let ip = range.first; ip <= range.last && free.length < count; ip++) {
      if (!detail.usedIps.has(ip)) free.push(ip)
    }
    if (free.length < count) {
      out.push({
        level: 'error',
        label: `Only ${free.length} of the ${count} addresses in that range are free`,
        detail: `${detail.usedIps.size} address(es) on "${detail.name}" are already handed out.`
      })
      return out
    }
    ips.push(...free.map(intToIp))
    out.push({
      level: 'pass',
      label: `Addresses ${ips[0]} to ${ips[ips.length - 1]}`
    })
    return out
  }

  async apply(payload: unknown): Promise<OkResult> {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const rules = effectiveRules(this.ctx)

    // The machine has had a whole confirm dialog's worth of time to change.
    // Ports are the one thing another process can take from under the job, and
    // a half-created batch is worse than a refusal.
    const probe = await probeHost(this.ctx)
    const stolen: string[] = []
    for (let i = 0; i < plan.names.length; i++) {
      for (const port of portsForIndex(plan.ports, i)) {
        if (probe.usedHostPorts.has(`${port.proto}:${port.host}`)) stolen.push(`${port.host}/${port.proto}`)
      }
    }
    if (stolen.length) {
      return { ok: false, error: `host port(s) ${stolen.slice(0, 10).join(', ')} were taken since the check - check again` }
    }
    const retaken = plan.names.filter((n) => probe.dockerNames.has(n))
    if (retaken.length) {
      return { ok: false, error: `container name(s) ${retaken.slice(0, 10).join(', ')} were taken since the check - check again` }
    }

    if (plan.saveAsTemplate && plan.templateName) this.saveTemplate(plan)

    const created: string[] = []
    const items: JobItemSpec[] = plan.names.map((name, index) => ({
      name,
      run: async () => {
        if (plan.pull && index === 0) {
          const pulled = await this.ctx.exec(`docker pull ${shQuote(plan.image)}`, { timeoutMs: 600000 })
          if (pulled.code !== 0) throw new Error((pulled.stderr || pulled.stdout).trim() || 'pull failed')
        }
        const create = await this.ctx.exec(this.createCommand(plan, name, index), { timeoutMs: 120000 })
        if (create.code !== 0) throw new Error((create.stderr || create.stdout).trim() || 'create failed')
        const id = create.stdout.trim().split('\n').pop() ?? ''
        const start = await this.ctx.exec(`docker start ${shQuote(name)}`, { timeoutMs: 120000 })
        if (start.code !== 0) throw new Error((start.stderr || start.stdout).trim() || 'start failed')
        // Tag by the short id, because that is what `docker ps` reports and
        // therefore what the table's rows are keyed by.
        if (id) created.push(id.slice(0, 12))
      }
    }))

    const job = this.jobs.start({
      kind: 'create-docker',
      label: `Create ${plan.names.length} Docker container(s) from ${plan.image}`,
      engine: 'docker',
      concurrency: plan.concurrency,
      onError: plan.onError,
      maxParallel: rules.maxParallel,
      itemTimeoutMs: Math.max(rules.itemTimeoutSec, 120) * 1000,
      items
    })

    if (plan.tag) {
      // Attaching as they finish would mean a write per container; the job is
      // short enough that one write at the end is both cheaper and atomic.
      void whenFinished(this.jobs, job.id).then(() => {
        if (created.length) this.tags.ensureAndAttach(plan.tag, created.map(dockerRef))
      })
    }

    return { ok: true, data: job.id }
  }

  private createCommand(plan: DockerPlan, name: string, index: number): string {
    const args: string[] = ['docker', 'create', '--name', shQuote(name)]
    args.push('--restart', shQuote(plan.restartPolicy))
    for (const entry of plan.env) args.push('--env', shQuote(entry))
    if (plan.cpus) args.push('--cpus', shQuote(plan.cpus))
    if (plan.memory) args.push('--memory', shQuote(plan.memory))
    if (plan.network) args.push('--network', shQuote(plan.network))
    if (plan.ips[index]) args.push('--ip', shQuote(plan.ips[index]))
    for (const port of portsForIndex(plan.ports, index)) {
      args.push('-p', shQuote(`${port.host}:${port.container}/${port.proto}`))
    }
    // Written on the container as well as in the app's own store, so somebody
    // reading `docker inspect` outside this app can see the same grouping.
    if (plan.tag) args.push('--label', shQuote(`bored-manager.tags=${plan.tag}`))
    args.push(shQuote(plan.image))
    if (plan.script) args.push('sh', '-c', shQuote(plan.script))
    return args.join(' ')
  }

  private saveTemplate(plan: DockerPlan): void {
    const values = { ...plan.values }
    // Neither the size of one batch nor "save this" belongs in what gets reused.
    delete values['count']
    delete values['template']
    delete values['saveAsTemplate']
    delete values['templateName']
    this.store.update((data) => {
      data.templates = data.templates.filter(
        (t) => !(t.kind === 'create-docker' && t.name === plan.templateName)
      )
      data.templates.push({
        id: makeId('tpl', new Set(data.templates.map((t) => t.id))),
        name: plan.templateName,
        kind: 'create-docker',
        values,
        createdAt: Date.now()
      })
    })
  }
}
