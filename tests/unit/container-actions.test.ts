import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import { BulkRunner, type LiveContainers } from '../../container/main/bulk'
import { IncusCli } from '../../container/main/incus'
import type { FleetJobs } from '../../container/main/jobs'
import { RuntimeInstaller } from '../../container/main/install'
import { ContainerService } from '../../container/main/service'
import type { DockerContainer } from '@shared/types'

describe('container refuse-unknown', () => {
  it('refuses a bad docker id and an unknown action without exec', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const service = new ContainerService(harness.ctx)
    await expect(service.containerAction('abc; rm -rf /', 'kill')).resolves.toEqual({
      ok: false,
      error: 'invalid container id'
    })
    await expect(service.containerAction('ok', 'rm -rf' as 'kill')).resolves.toEqual({
      ok: false,
      error: 'invalid container action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses a bad Incus name and an unknown instance action', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const incus = new IncusCli(harness.ctx)
    await expect(incus.action('bad_name', 'start')).resolves.toEqual({
      ok: false,
      error: 'invalid instance name'
    })
    await expect(incus.action('ok', 'freeze' as 'start')).resolves.toEqual({
      ok: false,
      error: 'invalid instance action'
    })
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses a custom install command that contains a newline', async () => {
    const harness = moduleHarness(
      'container',
      () => ({
        stdout: '===MANAGER===\napt-get\n===DOCKER===\nno\n===INCUS===\nno\n===SYSTEMD===\nyes\n',
        stderr: '',
        code: 0
      }),
      { hasSudo: true }
    )
    const installer = new RuntimeInstaller(harness.ctx)
    const report = await installer.check('docker', { mode: 'custom', command: 'apt\nreboot' })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.label.includes('single line'))).toBe(true)
  })

  it('does not start an install stream when apply has no token', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }), {
      hasSudo: true
    })
    const installer = new RuntimeInstaller(harness.ctx)
    const result = await installer.apply({})
    expect(result.ok).toBe(false)
    expect(harness.stream.start).not.toHaveBeenCalled()
  })
})

describe('container inspect: timestamps', () => {
  it('leaves Created/StartedAt/FinishedAt as raw epoch ms rather than a pre-formatted string', async () => {
    const created = '2026-01-15T13:45:30.000000000Z'
    const raw = {
      Id: 'abc123',
      Name: '/web',
      Created: created,
      State: { Status: 'running', StartedAt: created, FinishedAt: '0001-01-01T00:00:00Z' }
    }
    const harness = moduleHarness('container', () => ({
      stdout: `${JSON.stringify(raw)}\n`,
      stderr: '',
      code: 0
    }))
    const service = new ContainerService(harness.ctx)

    const info = await service.inspect('abc123')

    // A number the docker.json spec's `format: "datetime"` renders in the
    // viewer's own locale - not a string baked in this server's locale
    // (see the ValueFormat doc comment in shared/module-ui.ts).
    expect(info?.createdAt).toBe(Date.parse(created))
    expect(typeof info?.createdAt).toBe('number')
    expect(info?.startedAt).toBe(Date.parse(created))
    // Docker's zero value ("never happened") stays null, not a formatted
    // "Invalid Date" or an arbitrary epoch.
    expect(info?.finishedAt).toBeNull()
  })
})

describe('runtime install: what goes on the stream', () => {
  const FACTS = '===MANAGER===\napt-get\n===DOCKER===\nno\n===INCUS===\nno\n===SYSTEMD===\nyes\n'

  /**
   * modules-gpu-container#7: `install` is a `latest` stream, and every chunk
   * of output re-sent the whole state - up to 500 buffered lines - to every
   * connected browser, for a five-minute `apt-get` that produces hundreds of
   * chunks. The output has its own stream (`installlog`); this one carries
   * only the three fields the settings page reads, and only when one of them
   * actually changes.
   */
  it('emits install on start and finish only, with the log left to installlog', async () => {
    const harness = moduleHarness('container', () => ({ stdout: FACTS, stderr: '', code: 0 }), {
      hasSudo: true
    })
    const installer = new RuntimeInstaller(harness.ctx)
    const states = (): unknown[] =>
      harness.emit.mock.calls.filter(([event]) => event === 'install').map(([, payload]) => payload)
    const logs = (): unknown[][] => harness.emit.mock.calls.filter(([event]) => event === 'installlog')

    const report = await installer.check('docker', { mode: 'default' })
    expect(report.ok).toBe(true)
    await installer.apply({ token: report.token, values: { mode: 'default' } })

    expect(states()).toEqual([{ running: true, kind: 'docker', ok: null }])
    const logsAfterStart = logs().length

    harness.stream.pushData('Reading package lists...\n')
    harness.stream.pushData('Unpacking docker.io...\n')

    // Two more log chunks, and not one further copy of the state.
    expect(logs()).toHaveLength(logsAfterStart + 2)
    expect(states()).toHaveLength(1)

    harness.stream.exit(0)

    expect(states()).toHaveLength(2)
    expect(states()[1]).toEqual({ running: false, kind: 'docker', ok: true })
    // The buffer is still there for a page opened mid-install to ask for.
    installer.logTail()
    expect(String(logs().at(-1)?.[1])).toContain('Unpacking docker.io')
  })
})

describe('bulk criteria check and the listing it matches against', () => {
  function container(partial: Partial<DockerContainer>): DockerContainer {
    return {
      id: 'abc123',
      name: 'web',
      image: 'nginx',
      state: 'running',
      status: 'Up 2 hours',
      ports: '',
      runningFor: '2 hours',
      health: '',
      cpuPct: 0,
      memPct: 0,
      memUsage: '',
      netIO: '',
      blockIO: '',
      pids: 1,
      tagBadges: [],
      tagsText: '',
      ...partial
    }
  }

  /** A stand-in for the module's poller output, with the same handle on it the module gives BulkRunner. */
  function liveList(): { live: LiveContainers; refreshes: number[]; setAge(ms: number | null): void } {
    let sampledAt: number | null = null
    const refreshes: number[] = []
    return {
      refreshes,
      setAge: (ms) => {
        sampledAt = ms == null ? null : Date.now() - ms
      },
      live: {
        docker: () => (sampledAt == null ? [] : [container({})]),
        incus: () => [],
        sampledAt: () => sampledAt,
        refresh: async () => {
          refreshes.push(Date.now())
          sampledAt = Date.now()
        }
      }
    }
  }

  function runner(live: LiveContainers, harness: ReturnType<typeof moduleHarness>): BulkRunner {
    return new BulkRunner(harness.ctx, new IncusCli(harness.ctx), {} as FleetJobs, live, () => [])
  }

  /**
   * modules-gpu-container#13: targets are resolved from the last poll tick, so
   * with the container interval paused - or the page simply never opened -
   * there is no listing at all and every tag or pattern reported "Nothing
   * matches that" for containers that were plainly running.
   */
  it('takes a listing of its own when there is none, instead of matching nothing', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const list = liveList()
    list.setAge(null)

    const report = await runner(list.live, harness).check({
      engine: 'docker',
      action: 'stop',
      targetBy: 'name-pattern',
      value: 'we*'
    })

    expect(list.refreshes).toHaveLength(1)
    expect(report.ok).toBe(true)
    expect(report.findings.some((f) => f.label.includes('1 container(s) will be stopped'))).toBe(true)
    // What was matched, and how old it was, is part of what the user agrees to.
    expect(report.findings.some((f) => f.level === 'info' && /listing \d+s old/.test(f.label))).toBe(true)
  })

  it('re-reads a listing older than two intervals', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const list = liveList()
    list.setAge(10_000) // the harness reports a 2 s fast interval

    await runner(list.live, harness).check({
      engine: 'docker',
      action: 'stop',
      targetBy: 'name-pattern',
      value: 'we*'
    })

    expect(list.refreshes).toHaveLength(1)
  })

  it('leaves a listing from the current tick alone', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const list = liveList()
    list.setAge(200)

    const report = await runner(list.live, harness).check({
      engine: 'docker',
      action: 'stop',
      targetBy: 'name-pattern',
      value: 'we*'
    })

    expect(list.refreshes).toHaveLength(0)
    expect(report.ok).toBe(true)
  })

  it('does not go to the machine for a form that is not filled in', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    const list = liveList()
    list.setAge(null)

    const report = await runner(list.live, harness).check({ engine: 'docker', action: 'stop', targetBy: 'tag', value: '' })

    expect(report.ok).toBe(false)
    expect(list.refreshes).toHaveLength(0)
  })
})
