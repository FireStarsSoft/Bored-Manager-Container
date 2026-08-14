/**
 * "Create N Incus instances", with the same check-then-apply shape as the
 * Docker side. The one thing worth calling out is how a login gets set up:
 * the password goes to `chpasswd` on stdin and never into an argv, so it does
 * not turn up in the target machine's process list or shell history.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { shQuote } from '@shared/shell'
import { effectiveRules } from './rules'
import { formatBytes, generatedNames, LINUX_USER_RE, parseMemory } from './parse'
import { hasKvm, probeHost } from './probe'
import { INCUS_NAME_RE, INCUS_REF_RE, IncusCli } from './incus'
import { whenFinished, type FleetJobs, type JobItemSpec } from './jobs'
import { incusRef } from './service'
import type { TagStore } from './tags'
import { makeId, type HostStore, type TemplateRecord } from './store'

const MAX_SCRIPT_BYTES = 8 * 1024
/** How long to wait for a freshly launched instance to report Running. */
const START_TIMEOUT_MS = 30000
const START_POLL_MS = 1000

interface IncusPlan {
  names: string[]
  image: string
  vm: boolean
  profile: string
  network: string
  storagePool: string
  cpuLimit: string
  memoryLimit: string
  username: string
  password: string
  sshKey: string
  script: string
  tag: string
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

function raw(values: unknown, key: string): string {
  const v = (values as Record<string, unknown>)?.[key]
  return typeof v === 'string' ? v : ''
}

function flag(values: unknown, key: string): boolean {
  return (values as Record<string, unknown>)?.[key] === true
}

function mergeTemplate(
  values: unknown,
  templates: readonly TemplateRecord[]
): Record<string, string | number | boolean> {
  const out = { ...((values as Record<string, string | number | boolean>) ?? {}) }
  const id = text(values, 'template')
  if (!id) return out
  const template = templates.find((t) => t.id === id)
  if (!template) return out
  const merged = { ...template.values }
  for (const [key, value] of Object.entries(out)) {
    if (value === '' || value === undefined || value === null) continue
    merged[key] = value
  }
  merged['template'] = id
  return merged
}

export class IncusCreator {
  private session = createCheckSession<IncusPlan>()

  constructor(
    private ctx: ModuleContext,
    private cli: IncusCli,
    private store: HostStore,
    private jobs: FleetJobs,
    private tags: TagStore
  ) {}

  async check(input: unknown): Promise<ModuleCheckReport> {
    const rules = effectiveRules(this.ctx)
    const values = mergeTemplate(input, this.store.read().templates)
    const findings: ModuleCheckFinding[] = []

    const count = Math.trunc(Number((values as Record<string, unknown>)['count']))
    const prefix = text(values, 'namePrefix')
    const image = text(values, 'image')
    const vm = text(values, 'instanceType') === 'vm'
    const probe = await probeHost(this.ctx)

    // R-CI-01
    if (probe.incusPresent) {
      findings.push({ level: 'pass', label: 'Incus is installed' })
    } else {
      findings.push({
        level: 'error',
        label: 'Incus is not installed on this machine',
        detail: 'Install the incus package and run `incus admin init` once.'
      })
      return { ok: false, findings }
    }

    // R-CI-02
    if (!Number.isFinite(count) || count < 1 || count > rules.maxCreateCount) {
      findings.push({
        level: 'error',
        label: `Count must be between 1 and ${rules.maxCreateCount}`
      })
    }

    // R-CI-03
    const names = Number.isFinite(count) && count > 0 ? generatedNames(prefix, Math.min(count, rules.maxCreateCount)) : []
    if (!INCUS_NAME_RE.test(prefix)) {
      findings.push({
        level: 'error',
        label: 'Name prefix is not usable',
        detail: 'Incus names start with a letter and hold only letters, digits and dashes.'
      })
    } else {
      const existing = await this.cli.existingNames()
      const clashes = names.filter((n) => existing.has(n))
      if (clashes.length) {
        findings.push({
          level: 'error',
          label: `${clashes.length} of those names are taken`,
          detail: clashes.slice(0, 20).join(', ') + (clashes.length > 20 ? ', …' : '')
        })
      }
    }

    // R-CI-04
    if (!image) {
      findings.push({ level: 'error', label: 'An image is required (for example images:ubuntu/24.04)' })
    } else if (!INCUS_REF_RE.test(image)) {
      findings.push({ level: 'error', label: `"${image}" is not a usable image reference` })
    } else {
      const local = await this.cli.images()
      if (local.some((i) => i.name === image || image.endsWith(`/${i.name}`))) {
        findings.push({ level: 'pass', label: `Image ${image} is already here` })
      } else {
        findings.push({
          level: 'info',
          label: `Image ${image} will be downloaded on first launch`,
          detail: 'The first item of the job takes as long as that download.'
        })
      }
    }

    // R-CI-05
    findings.push(...(await this.checkRefs(values)))

    // R-CI-06
    const username = text(values, 'username')
    const password = raw(values, 'password')
    if (username) {
      if (!LINUX_USER_RE.test(username)) {
        findings.push({
          level: 'error',
          label: `"${username}" is not a usable Linux user name`,
          detail: 'Lower-case letter or underscore first, then letters, digits, underscore or dash; 32 characters at most.'
        })
      }
      if (password.length < rules.minPasswordLen) {
        findings.push({
          level: 'error',
          label: `The password is shorter than ${rules.minPasswordLen} characters`
        })
      } else if (password.length < 12) {
        findings.push({
          level: 'warning',
          label: 'That password is short for an account reachable over the network'
        })
      } else {
        findings.push({ level: 'pass', label: `User "${username}" will be created in every instance` })
      }
    } else if (password) {
      findings.push({ level: 'error', label: 'A password without a user name has nothing to set' })
    }

    // R-CI-07
    const memoryLimit = text(values, 'memoryLimit')
    if (memoryLimit) {
      const per = parseMemory(memoryLimit)
      if (per == null) {
        findings.push({ level: 'error', label: `"${memoryLimit}" is not a memory size (try 1GiB)` })
      } else if (Number.isFinite(count) && count > 0) {
        const wanted = per * count
        const share = probe.memAvailableBytes ? (wanted / probe.memAvailableBytes) * 100 : 0
        if (probe.memTotalBytes && wanted > probe.memTotalBytes) {
          findings.push({
            level: 'error',
            label: `${formatBytes(wanted)} is more memory than this machine has`,
            detail: `MemTotal is ${formatBytes(probe.memTotalBytes)}.`
          })
        } else if (share > rules.memHeadroomPct) {
          findings.push({
            level: 'warning',
            label: `${formatBytes(wanted)} is ${Math.round(share)}% of the memory currently available`
          })
        }
      }
    }

    // R-CI-08
    if (vm && !(await hasKvm(this.ctx))) {
      findings.push({
        level: 'warning',
        label: '/dev/kvm is not present, so virtual machines will be slow or refuse to start',
        detail: 'Enable virtualisation in the firmware, or create containers instead of VMs.'
      })
    }

    // R-CI-09 - the same neighbour advisory as the Docker side, for a bridged
    // network where every instance takes an address on the LAN.
    if (rules.enableArpAdvisory && text(values, 'network') && probe.gcThresh3 > 0) {
      const projected = probe.neighCount + (Number.isFinite(count) ? count : 0)
      if (projected > 0.8 * probe.gcThresh3) {
        findings.push({
          level: 'warning',
          label: 'The neighbour table will be close to full',
          detail: `${projected} entries projected against a gc_thresh3 of ${probe.gcThresh3}. Raise it under Network - Host tuning.`
        })
      }
    }

    const script = text(values, 'startupScript')
    if (script.length > MAX_SCRIPT_BYTES) {
      findings.push({ level: 'error', label: `The startup script is over ${MAX_SCRIPT_BYTES} characters` })
    }

    const concurrency = text(values, 'concurrency') === 'parallel' ? 'parallel' : 'sequential'
    const onError = text(values, 'onError') === 'abort' ? 'abort' : 'continue'

    if (names.length) {
      findings.push({
        level: 'pass',
        label: `Will create ${names.length} ${vm ? 'virtual machine' : 'container'}(s): ${names[0]}…${names[names.length - 1]}`,
        detail: [
          `image ${image || '?'}`,
          text(values, 'profile') ? `profile ${text(values, 'profile')}` : '',
          text(values, 'storagePool') ? `pool ${text(values, 'storagePool')}` : '',
          `${concurrency}, ${onError} on error`
        ]
          .filter(Boolean)
          .join(', ')
      })
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    const plan: IncusPlan = {
      names,
      image,
      vm,
      profile: text(values, 'profile'),
      network: text(values, 'network'),
      storagePool: text(values, 'storagePool'),
      cpuLimit: text(values, 'cpuLimit'),
      memoryLimit,
      username,
      password,
      sshKey: raw(values, 'sshAuthorizedKey').trim(),
      script,
      tag: text(values, 'tag'),
      concurrency,
      onError,
      saveAsTemplate: flag(values, 'saveAsTemplate'),
      templateName: text(values, 'templateName'),
      values
    }
    return { ok, token: this.session.issue(input, plan), findings }
  }

  /** Profile, network and storage pool all have to exist before anything launches. */
  private async checkRefs(values: unknown): Promise<ModuleCheckFinding[]> {
    const out: ModuleCheckFinding[] = []
    const checks: Array<[string, string, () => Promise<Array<{ name: string }>>]> = [
      ['profile', 'Profile', () => this.cli.profiles()],
      ['network', 'Network', () => this.cli.networks()],
      ['storagePool', 'Storage pool', () => this.cli.pools()]
    ]
    for (const [key, label, load] of checks) {
      const wanted = text(values, key)
      if (!wanted) continue
      if (!INCUS_REF_RE.test(wanted)) {
        out.push({ level: 'error', label: `${label} "${wanted}" is not a usable name` })
        continue
      }
      const available = await load()
      if (!available.some((entry) => entry.name === wanted)) {
        out.push({
          level: 'error',
          label: `${label} "${wanted}" does not exist`,
          detail: available.length ? `Available: ${available.map((e) => e.name).join(', ')}` : undefined
        })
      }
    }
    return out
  }

  async apply(payload: unknown): Promise<OkResult> {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const rules = effectiveRules(this.ctx)

    const existing = await this.cli.existingNames()
    const clashes = plan.names.filter((n) => existing.has(n))
    if (clashes.length) {
      return { ok: false, error: `instance name(s) ${clashes.slice(0, 10).join(', ')} were taken since the check - check again` }
    }

    if (plan.saveAsTemplate && plan.templateName) this.saveTemplate(plan)

    const created: string[] = []
    const items: JobItemSpec[] = plan.names.map((name) => ({
      name,
      run: async (cancelled) => {
        const launch = await this.ctx.exec(this.launchCommand(plan, name), { timeoutMs: 600000 })
        if (launch.code !== 0) throw new Error((launch.stderr || launch.stdout).trim() || 'launch failed')
        await this.waitRunning(name, cancelled)
        await this.provision(plan, name)
        created.push(name)
      }
    }))

    const job = this.jobs.start({
      kind: 'create-incus',
      label: `Create ${plan.names.length} Incus ${plan.vm ? 'VM' : 'container'}(s) from ${plan.image}`,
      engine: 'incus',
      concurrency: plan.concurrency,
      onError: plan.onError,
      maxParallel: rules.maxParallel,
      itemTimeoutMs: Math.max(rules.itemTimeoutSec, 180) * 1000,
      items
    })

    if (plan.tag) {
      void whenFinished(this.jobs, job.id).then(() => {
        if (created.length) this.tags.ensureAndAttach(plan.tag, created.map(incusRef))
      })
    }

    return { ok: true, data: job.id }
  }

  private launchCommand(plan: IncusPlan, name: string): string {
    const args = ['incus', 'launch', shQuote(plan.image), shQuote(name)]
    if (plan.vm) args.push('--vm')
    if (plan.profile) args.push('-p', shQuote(plan.profile))
    if (plan.cpuLimit) args.push('-c', shQuote(`limits.cpu=${plan.cpuLimit}`))
    if (plan.memoryLimit) args.push('-c', shQuote(`limits.memory=${plan.memoryLimit}`))
    // Recorded on the instance as well as in the app's own store, so the
    // grouping is visible to anyone reading `incus config show`.
    if (plan.tag) args.push('-c', shQuote(`user.bored-manager.tags=${plan.tag}`))
    if (plan.network) args.push('-n', shQuote(plan.network))
    if (plan.storagePool) args.push('-s', shQuote(plan.storagePool))
    return args.join(' ')
  }

  /** A freshly launched instance is not ready for `incus exec` until it says Running. */
  private async waitRunning(name: string, cancelled: () => boolean): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    for (;;) {
      if (cancelled()) throw new Error('cancelled')
      const res = await this.ctx.exec(`incus info ${shQuote(name)} 2>/dev/null | grep -i '^Status:'`, {
        timeoutMs: 15000
      })
      if (/running/i.test(res.stdout)) return
      if (Date.now() >= deadline) {
        throw new Error(`did not reach Running within ${START_TIMEOUT_MS / 1000}s`)
      }
      await sleep(START_POLL_MS)
    }
  }

  /**
   * Set up the login through `incus exec` rather than cloud-init: it works
   * with every image, including the minimal ones that have no cloud-init at
   * all, and it does not need the instance to have been built for it.
   */
  private async provision(plan: IncusPlan, name: string): Promise<void> {
    const target = shQuote(name)
    if (plan.username) {
      // useradd on a glibc image, adduser on Alpine; whichever is missing fails
      // quietly, and the chpasswd below is what actually has to work.
      await this.ctx.exec(
        `incus exec ${target} -- sh -c ${shQuote(
          `useradd -m -s /bin/bash ${plan.username} 2>/dev/null || adduser -D ${plan.username} 2>/dev/null; true`
        )}`,
        { timeoutMs: 60000 }
      )
      const chpasswd = await this.ctx.exec(`incus exec ${target} -- chpasswd`, {
        stdin: `${plan.username}:${plan.password}\n`,
        timeoutMs: 60000
      })
      if (chpasswd.code !== 0) {
        throw new Error(`could not set the password: ${(chpasswd.stderr || chpasswd.stdout).trim()}`)
      }
      if (plan.sshKey) {
        const home = `/home/${plan.username}`
        const script =
          `mkdir -p ${home}/.ssh && cat >> ${home}/.ssh/authorized_keys && ` +
          `chmod 700 ${home}/.ssh && chmod 600 ${home}/.ssh/authorized_keys && ` +
          `chown -R ${plan.username} ${home}/.ssh`
        const keyed = await this.ctx.exec(`incus exec ${target} -- sh -c ${shQuote(script)}`, {
          stdin: `${plan.sshKey}\n`,
          timeoutMs: 60000
        })
        if (keyed.code !== 0) {
          throw new Error(`could not install the SSH key: ${(keyed.stderr || keyed.stdout).trim()}`)
        }
      }
    }
    if (plan.script) {
      const ran = await this.ctx.exec(`incus exec ${target} -- sh -c ${shQuote(plan.script)}`, {
        timeoutMs: 300000
      })
      if (ran.code !== 0) {
        throw new Error(`the startup script failed: ${(ran.stderr || ran.stdout).trim()}`)
      }
    }
  }

  private saveTemplate(plan: IncusPlan): void {
    const values = { ...plan.values }
    delete values['count']
    delete values['template']
    delete values['saveAsTemplate']
    delete values['templateName']
    // A saved template is a file on disk; a password does not go in it.
    delete values['password']
    this.store.update((data) => {
      data.templates = data.templates.filter(
        (t) => !(t.kind === 'create-incus' && t.name === plan.templateName)
      )
      data.templates.push({
        id: makeId('tpl', new Set(data.templates.map((t) => t.id))),
        name: plan.templateName,
        kind: 'create-incus',
        values,
        createdAt: Date.now()
      })
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
