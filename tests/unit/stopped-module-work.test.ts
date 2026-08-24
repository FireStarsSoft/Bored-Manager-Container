import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FleetJobs } from '../../container/main/jobs'
import { HostStore } from '../../container/main/store'
import { moduleHarness } from '../helpers/module-harness'

/**
 * A module's fire-and-forget work - a fleet job, a manual slow refresh - can
 * still be waiting on the target when the user disables the module, reloads
 * it, or the machine disconnects. The host revokes the context at that point,
 * and until this was guarded the late `emit`/`log`/host-data write threw from
 * a promise nobody was holding, which the server treated as fatal: one browser
 * tab disabling a module took every machine, terminal and user down with it.
 *
 * The scaffolding below is copied rather than shared: this started as one
 * suite in the app repository covering several modules at once, and each
 * module that moved to its own repository took its own cases with it. Copying
 * ~40 lines is what lets the *reason* travel with the test.
 */

/** Any rejection or throw that escapes to the process is what we are testing for. */
function trapProcessFailures(): { failures: unknown[]; stop(): void } {
  const failures: unknown[] = []
  const onRejection = (reason: unknown): void => {
    failures.push(reason)
  }
  const onException = (error: unknown): void => {
    failures.push(error)
  }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    failures,
    stop: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    }
  }
}

/** Give timers and microtasks a chance to run, so a late throw would surface. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}

let trap: ReturnType<typeof trapProcessFailures>

beforeEach(() => {
  trap = trapProcessFailures()
})

afterEach(() => {
  trap.stop()
})

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('work that outlives the module it belongs to', () => {
  it('a create job finishing after the module stops does not attach tags or persist', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const jobs = new FleetJobs(harness.ctx, new HostStore(harness.ctx))
    const gate = deferred()

    jobs.start({
      kind: 'create',
      label: 'create 2 containers',
      engine: 'docker',
      concurrency: 'sequential',
      onError: 'continue',
      maxParallel: 1,
      itemTimeoutMs: 0,
      items: [
        { name: 'web-001', run: async () => gate.promise },
        { name: 'web-002', run: async () => undefined }
      ]
    })

    jobs.dispose()
    harness.revoke()
    gate.release()
    await drain()

    expect(trap.failures).toEqual([])
    expect(jobs.disposed).toBe(true)
    expect(harness.afterStopCalls).toEqual([])
  })

  it('whenFinished stops polling instead of reading a revoked store', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const jobs = new FleetJobs(harness.ctx, new HostStore(harness.ctx))
    const { whenFinished } = await import('../../container/main/jobs')
    const gate = deferred()

    const job = jobs.start({
      kind: 'create',
      label: 'create 1 container',
      engine: 'docker',
      concurrency: 'sequential',
      onError: 'continue',
      maxParallel: 1,
      itemTimeoutMs: 0,
      items: [{ name: 'web-001', run: async () => gate.promise }]
    })
    let settled = false
    void whenFinished(jobs, job.id).then(() => {
      settled = true
    })

    jobs.dispose()
    harness.revoke()
    gate.release()
    // whenFinished polls every 500 ms, so this has to outlast one tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 700))

    // It resolves rather than throwing inside its own setTimeout, which would
    // have been an uncaught exception rather than a rejection.
    expect(settled).toBe(true)
    expect(trap.failures).toEqual([])
    expect(harness.afterStopCalls).toEqual([])
  })
})
