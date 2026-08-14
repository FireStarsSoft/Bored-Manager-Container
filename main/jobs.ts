/**
 * Running many things against one machine and letting the user watch. A job is
 * a list of items with a runner each; the engine only decides how many go at
 * once, what happens when one fails, and how the progress gets back to the
 * page. What an item actually does belongs to whoever built the job.
 *
 * Apply methods start a job and return straight away: creating fifty
 * containers takes minutes, and an RPC call that waits that long is a call
 * that times out.
 */
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { MAX_JOBS, MAX_JOB_ITEMS, makeId, type FleetJob, type HostStore } from './store'

export interface JobItemSpec {
  name: string
  /** Rejects with the reason the item failed; `cancelled` says the user stopped the job. */
  run: (cancelled: () => boolean) => Promise<void>
}

export interface JobSpec {
  kind: string
  label: string
  engine: 'docker' | 'incus'
  concurrency: 'sequential' | 'parallel'
  onError: 'continue' | 'abort'
  maxParallel: number
  itemTimeoutMs: number
  items: JobItemSpec[]
}

/** How often progress is pushed while a job runs; every item would be a lot of traffic. */
const EMIT_THROTTLE_MS = 500

/**
 * A running job keeps every item so the user can watch it; the copy that goes
 * into the history does not. Fifty untrimmed jobs would not fit in the per-host
 * document, and a finished job's two hundred "ok" lines are not what anyone
 * comes back for - the failures are.
 */
const HISTORY_ITEMS_PER_JOB = 40

function forHistory(job: FleetJob): FleetJob {
  if (job.items.length <= HISTORY_ITEMS_PER_JOB) return job
  const bad = job.items.filter((i) => i.status === 'error' || i.status === 'cancelled')
  const rest = job.items.filter((i) => i.status !== 'error' && i.status !== 'cancelled')
  const kept = [...bad.slice(0, HISTORY_ITEMS_PER_JOB), ...rest].slice(0, HISTORY_ITEMS_PER_JOB)
  return { ...job, items: kept.sort((a, b) => a.idx - b.idx) }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

class CancelledError extends Error {
  constructor() {
    super('cancelled')
  }
}

export class FleetJobs {
  /** Jobs that have not finished, newest first; finished ones move to the host store. */
  private live: FleetJob[] = []
  private cancelling = new Set<string>()
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private ctx: ModuleContext,
    private store: HostStore
  ) {}

  /** Running jobs first, then what the host store remembers. */
  list(): FleetJob[] {
    return [...this.live, ...this.store.read().jobs]
  }

  snapshot(): { t: number; jobs: FleetJob[] } {
    return { t: Date.now(), jobs: this.list() }
  }

  /**
   * Switching the module off has to stop its work on the target machine, so
   * everything still running is cancelled - the runner checks between items,
   * so the item in flight finishes (a half-created container is worse than a
   * slightly late stop) and nothing after it starts.
   */
  dispose(): void {
    for (const job of this.live) this.cancelling.add(job.id)
    this.live = []
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
  }

  /** The connection these were running against has gone; they cannot be resumed. */
  reset(): void {
    this.dispose()
  }

  start(spec: JobSpec): FleetJob {
    const job: FleetJob = {
      id: makeId('job', new Set(this.list().map((j) => j.id))),
      kind: spec.kind,
      label: spec.label,
      engine: spec.engine,
      state: 'running',
      startedAt: Date.now(),
      total: spec.items.length,
      done: 0,
      failed: 0,
      progressPct: 0,
      concurrency: spec.concurrency,
      items: spec.items.slice(0, MAX_JOB_ITEMS).map((item, idx) => ({
        idx,
        name: item.name,
        status: 'pending' as const
      }))
    }
    this.live.unshift(job)
    this.emit(true)
    void this.run(job, spec)
    return job
  }

  cancel(id: string): OkResult {
    const job = this.live.find((j) => j.id === id)
    if (!job) return { ok: false, error: 'no such job, or it has already finished' }
    this.cancelling.add(id)
    this.ctx.log(`job ${id} (${job.label}) cancelled by the user`)
    return { ok: true }
  }

  /** Drop the finished jobs from the history; the running ones stay. */
  clearFinished(): OkResult {
    const removed = this.store.update((data) => {
      const count = data.jobs.length
      data.jobs = []
      return count
    })
    this.emit(true)
    return { ok: true, data: `${removed}` }
  }

  private async run(job: FleetJob, spec: JobSpec): Promise<void> {
    const cancelled = (): boolean => this.cancelling.has(job.id)
    let aborted = false

    const runOne = async (index: number): Promise<void> => {
      const item = job.items[index]
      const source = spec.items[index]
      if (!item || !source) return
      if (cancelled() || aborted) {
        item.status = cancelled() ? 'cancelled' : 'skipped'
        job.done++
        return
      }
      item.status = 'running'
      const startedAt = Date.now()
      this.emit()
      try {
        await withTimeout(source.run(cancelled), spec.itemTimeoutMs, item.name)
        item.status = 'ok'
      } catch (err) {
        if (err instanceof CancelledError || cancelled()) {
          item.status = 'cancelled'
        } else {
          item.status = 'error'
          item.message = message(err)
          job.failed++
          if (spec.onError === 'abort') aborted = true
        }
      }
      item.ms = Date.now() - startedAt
      job.done++
      job.progressPct = job.total ? Math.round((job.done / job.total) * 100) : 100
      this.emit()
    }

    try {
      if (spec.concurrency === 'sequential') {
        for (let i = 0; i < job.items.length; i++) await runOne(i)
      } else {
        // A fixed pool of workers pulling from a shared cursor: an item that
        // takes a minute must not hold up the three slots next to it.
        let next = 0
        const width = Math.max(1, Math.min(spec.maxParallel, job.items.length))
        const workers = Array.from({ length: width }, async () => {
          for (;;) {
            const index = next++
            if (index >= job.items.length) return
            await runOne(index)
          }
        })
        await Promise.all(workers)
      }
    } catch (err) {
      this.ctx.log(`job ${job.id} stopped unexpectedly: ${message(err)}`)
    }

    job.finishedAt = Date.now()
    job.progressPct = 100
    job.state = cancelled()
      ? 'cancelled'
      : job.failed === 0
        ? 'done'
        : job.failed === job.total
          ? 'failed'
          : 'partial'
    this.cancelling.delete(job.id)
    this.live = this.live.filter((j) => j.id !== job.id)
    this.persist(job)
    this.ctx.log(`job ${job.id} (${job.label}) ${job.state}: ${job.done - job.failed}/${job.total} ok`)
    this.emit(true)
  }

  /**
   * Move a finished job into the history. The document has a hard size ceiling,
   * so if fifty trimmed jobs still do not fit, the oldest go rather than the
   * one that just finished being the one that is lost.
   */
  private persist(job: FleetJob): void {
    const entry = forHistory(job)
    try {
      this.store.update((data) => {
        data.jobs.unshift(entry)
        data.jobs = data.jobs.slice(0, MAX_JOBS)
      })
      return
    } catch (err) {
      this.ctx.log(`job history did not fit, keeping only the most recent: ${message(err)}`)
    }
    try {
      // The failed update already put this job at the front of the in-memory
      // copy, so cutting the list short keeps it and drops the old ones.
      this.store.update((data) => {
        data.jobs = data.jobs.slice(0, 10)
      })
    } catch (err) {
      this.ctx.log(`job history could not be written at all: ${message(err)}`)
    }
  }

  /**
   * Push progress, at most every half second unless `now` says this is a
   * transition the page must not miss. A trailing emit is scheduled when a
   * push is skipped, so the last state of a burst is never the one dropped.
   */
  private emit(now = false): void {
    const since = Date.now() - this.lastEmit
    if (!now && since < EMIT_THROTTLE_MS) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, EMIT_THROTTLE_MS - since)
      }
      return
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.lastEmit = Date.now()
    this.ctx.emit('jobs', this.snapshot())
  }
}

/**
 * Resolve once a job is no longer running, for the bookkeeping that has to
 * follow it (attaching a tag to everything a create job made). Polled rather
 * than promised, because a job outlives the call that started it.
 */
export function whenFinished(jobs: FleetJobs, id: string): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const job = jobs.list().find((j) => j.id === id)
      if (!job || job.state !== 'running') {
        resolve()
        return
      }
      setTimeout(tick, 500)
    }
    setTimeout(tick, 500)
  })
}

/**
 * The exec call has its own timeout, but an item may be several calls or a
 * poll loop, so the item as a whole gets one too. The underlying work is not
 * killed - nothing here can reach into it - it is only stopped being waited on.
 */
function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} took longer than ${Math.round(ms / 1000)}s`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export { CancelledError }
