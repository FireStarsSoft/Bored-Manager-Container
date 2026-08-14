/**
 * Acting on many containers at once - either the ones ticked in a table, or
 * everything matching a description ("every stopped container tagged web").
 *
 * The criteria form freezes its list at check time and the apply runs that
 * exact list. Re-resolving at apply would be worse, not better: the user read
 * a report naming twelve containers, and stopping a thirteenth that appeared
 * in the meantime is not what they agreed to.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'
import type { DockerContainer, IncusInstance, OkResult } from '@shared/types'
import { effectiveRules } from './rules'
import { matchesPattern } from './parse'
import { INCUS_NAME_RE, IncusCli, type IncusAction } from './incus'
import type { FleetJobs, JobItemSpec } from './jobs'
import { ID_RE } from './service'

export type BulkEngine = 'docker' | 'incus'
export type BulkAction = 'start' | 'stop' | 'restart' | 'remove' | 'pause' | 'unpause'

const DOCKER_ACTIONS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'restart',
  'remove',
  'pause',
  'unpause'
])
/** Incus has no freeze/unfreeze under these names, so pause/unpause is Docker-only. */
const INCUS_ACTIONS: ReadonlySet<string> = new Set(['start', 'stop', 'restart', 'remove'])

/** One thing a job will act on, resolved once and then frozen into the token. */
interface BulkTarget {
  /** Container id or instance name - whatever the CLI takes. */
  ref: string
  name: string
}

interface BulkPlan {
  engine: BulkEngine
  action: BulkAction
  targets: BulkTarget[]
  concurrency: 'sequential' | 'parallel'
  onError: 'continue' | 'abort'
}

export interface LiveContainers {
  docker(): DockerContainer[]
  incus(): IncusInstance[]
}

function text(values: unknown, key: string): string {
  const v = (values as Record<string, unknown>)?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

export class BulkRunner {
  private session = createCheckSession<BulkPlan>()

  constructor(
    private ctx: ModuleContext,
    private cli: IncusCli,
    private jobs: FleetJobs,
    private live: LiveContainers,
    private tagsOf: (ref: string) => string[]
  ) {}

  // ---------- From a table's ticked rows ----------

  /** `bulkContainerAction(ids[], action)` - the Docker table's toolbar. */
  dockerSelection(keys: unknown, action: unknown): OkResult {
    const ids = Array.isArray(keys) ? keys.map(String).filter((id) => ID_RE.test(id)) : []
    if (!ids.length) return { ok: false, error: 'nothing selected' }
    const verb = String(action)
    if (!DOCKER_ACTIONS.has(verb) && verb !== 'rm') {
      return { ok: false, error: `"${verb}" is not a container action` }
    }
    const byId = new Map(this.live.docker().map((c) => [c.id, c.name]))
    const targets = ids.map((id) => ({ ref: id, name: byId.get(id) ?? id }))
    const job = this.startDocker(verb === 'rm' ? 'remove' : (verb as BulkAction), targets, 'sequential', 'continue')
    return { ok: true, data: job }
  }

  /** `bulkIncusAction(names[], action)` - the Incus table's toolbar. */
  incusSelection(keys: unknown, action: unknown): OkResult {
    const names = Array.isArray(keys) ? keys.map(String).filter((n) => INCUS_NAME_RE.test(n)) : []
    if (!names.length) return { ok: false, error: 'nothing selected' }
    const verb = String(action)
    if (!INCUS_ACTIONS.has(verb) && verb !== 'delete') {
      return { ok: false, error: `"${verb}" is not an instance action` }
    }
    const targets = names.map((name) => ({ ref: name, name }))
    const job = this.startIncus(
      verb === 'delete' ? 'remove' : (verb as BulkAction),
      targets,
      'sequential',
      'continue'
    )
    return { ok: true, data: job }
  }

  // ---------- From a description ----------

  check(input: unknown): ModuleCheckReport {
    const rules = effectiveRules(this.ctx)
    const findings: ModuleCheckFinding[] = []
    const engine = (text(input, 'engine') || 'docker') as BulkEngine
    const action = (text(input, 'action') || 'stop') as BulkAction
    const targetBy = text(input, 'targetBy') || 'tag'
    const value = text(input, 'value')

    if (engine !== 'docker' && engine !== 'incus') {
      return { ok: false, findings: [{ level: 'error', label: `"${engine}" is not an engine` }] }
    }
    const allowed = engine === 'docker' ? DOCKER_ACTIONS : INCUS_ACTIONS
    if (!allowed.has(action)) {
      findings.push({
        level: 'error',
        label: `${engine} has no "${action}" action`,
        detail: engine === 'incus' ? 'Incus does not offer pause and unpause here.' : undefined
      })
    }
    if (!value) findings.push({ level: 'error', label: 'A value to match on is required' })

    const targets = this.resolve(engine, targetBy, value)
    if (targets.length === 0) {
      findings.push({
        level: 'error',
        label: 'Nothing matches that',
        detail: `No ${engine} container has ${targetBy} matching "${value}".`
      })
    } else {
      findings.push({
        level: 'pass',
        label: `${targets.length} container(s) will be ${pastTense(action)}`,
        detail: targets.slice(0, 20).map((t) => t.name).join(', ') + (targets.length > 20 ? ', …' : '')
      })
    }
    if (action === 'remove' && targets.length) {
      findings.push({
        level: 'warning',
        label: 'Removing a container is irreversible',
        detail: 'Anything not on a volume or a storage pool goes with it.'
      })
    }
    if (targets.length > rules.bulkActionWarn) {
      findings.push({
        level: 'warning',
        label: `That is more than the ${rules.bulkActionWarn} this module warns above`
      })
    }

    const concurrency = text(input, 'concurrency') === 'parallel' ? 'parallel' : 'sequential'
    const onError = text(input, 'onError') === 'abort' ? 'abort' : 'continue'

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return {
      ok,
      token: this.session.issue(input, { engine, action, targets, concurrency, onError }),
      findings
    }
  }

  apply(payload: unknown): OkResult {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    const plan = taken.payload
    const job =
      plan.engine === 'docker'
        ? this.startDocker(plan.action, plan.targets, plan.concurrency, plan.onError)
        : this.startIncus(plan.action, plan.targets, plan.concurrency, plan.onError)
    return { ok: true, data: job }
  }

  private resolve(engine: BulkEngine, targetBy: string, value: string): BulkTarget[] {
    if (!value) return []
    if (engine === 'docker') {
      return this.live
        .docker()
        .filter((c) => this.matches(targetBy, value, `docker:${c.id}`, c.name, c.state, c.image))
        .map((c) => ({ ref: c.id, name: c.name }))
    }
    return this.live
      .incus()
      .filter((i) =>
        this.matches(targetBy, value, `incus:${i.name}`, i.name, i.running ? 'running' : 'stopped', i.image)
      )
      .map((i) => ({ ref: i.name, name: i.name }))
  }

  private matches(
    targetBy: string,
    value: string,
    ref: string,
    name: string,
    state: string,
    image: string
  ): boolean {
    switch (targetBy) {
      case 'tag':
        return this.tagsOf(ref).some((tag) => tag.toLowerCase() === value.toLowerCase())
      case 'state':
        return state.toLowerCase() === value.toLowerCase()
      case 'name-pattern':
        return matchesPattern(name, value)
      case 'image':
        return matchesPattern(image, value)
      default:
        return false
    }
  }

  private startDocker(
    action: BulkAction,
    targets: readonly BulkTarget[],
    concurrency: 'sequential' | 'parallel',
    onError: 'continue' | 'abort'
  ): string {
    const rules = effectiveRules(this.ctx)
    const items: JobItemSpec[] = targets.map((target) => ({
      name: target.name,
      run: async () => {
        const command =
          action === 'remove'
            ? `docker rm -f ${shQuote(target.ref)}`
            : `docker ${action} ${shQuote(target.ref)}`
        const res = await this.ctx.exec(command, { timeoutMs: 120000 })
        if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || `exit code ${res.code}`)
      }
    }))
    return this.jobs.start({
      kind: `bulk-${action}`,
      label: `${titleCase(action)} ${targets.length} Docker container(s)`,
      engine: 'docker',
      concurrency,
      onError,
      maxParallel: rules.maxParallel,
      itemTimeoutMs: Math.max(rules.itemTimeoutSec, 60) * 1000,
      items
    }).id
  }

  private startIncus(
    action: BulkAction,
    targets: readonly BulkTarget[],
    concurrency: 'sequential' | 'parallel',
    onError: 'continue' | 'abort'
  ): string {
    const rules = effectiveRules(this.ctx)
    const verb: IncusAction = action === 'remove' ? 'delete' : (action as IncusAction)
    const items: JobItemSpec[] = targets.map((target) => ({
      name: target.name,
      run: async () => {
        const res = await this.cli.action(target.ref, verb)
        if (!res.ok) throw new Error(res.error ?? 'failed')
      }
    }))
    return this.jobs.start({
      kind: `bulk-${action}`,
      label: `${titleCase(action)} ${targets.length} Incus instance(s)`,
      engine: 'incus',
      concurrency,
      onError,
      maxParallel: rules.maxParallel,
      itemTimeoutMs: Math.max(rules.itemTimeoutSec, 60) * 1000,
      items
    }).id
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function pastTense(action: BulkAction): string {
  switch (action) {
    case 'stop':
      return 'stopped'
    case 'start':
      return 'started'
    case 'restart':
      return 'restarted'
    case 'remove':
      return 'removed'
    case 'pause':
      return 'paused'
    default:
      return 'unpaused'
  }
}
