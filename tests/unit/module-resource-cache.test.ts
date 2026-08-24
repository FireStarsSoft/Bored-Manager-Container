import { describe, expect, it } from 'vitest'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import activateContainer from '../../container/main/index'

/**
 * What one open page costs. A page binds many blocks to the same underlying
 * reading, and a naive module runs one command per binding: the cost of having
 * the page open scales with how much is on it rather than with how often it
 * refreshes. These cases pin the two answers to that - coalesce concurrent
 * reads into one command, and push a stream when something changes instead of
 * polling to notice.
 *
 * Split out of the app repository's tests/unit/shared/module-resource-cache.test.ts,
 * which covered several modules in one file, when this module moved to its own
 * repository.
 */

describe('module read coalescing', () => {
  it('pushes the container rules-in-force stream the moment rulesReset changes them, instead of polling for it', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }), {
      config: sharedModuleConfig({ rules: { maxCreateCount: 200 } })
    })
    activateContainer(harness.ctx)
    const rulesReset = harness.handlers.get('rulesReset')!

    harness.emit.mockClear()
    const result = await rulesReset()
    expect(result).toEqual({ ok: true })
    expect(harness.emit).toHaveBeenCalledWith(
      'rules',
      expect.objectContaining({ maxCreateCount: '50 (default)' })
    )
  })

  it('turns four concurrent Docker drawer bindings into one inspect command', async () => {
    const harness = moduleHarness('container', () => ({ stdout: '', stderr: '', code: 0 }))
    activateContainer(harness.ctx)
    const inspect = harness.handlers.get('inspect')
    expect(inspect).toBeDefined()

    await Promise.all(Array.from({ length: 4 }, () => Promise.resolve(inspect!('abc123'))))
    expect(harness.exec).toHaveBeenCalledTimes(1)
    expect(harness.exec.mock.calls[0]?.[0]).toContain('docker inspect')
  })
})

describe('module visibility gating', () => {
  it('stops hidden fast metrics but leaves the slow poller independent', () => {
    const answer = () => ({ stdout: '', stderr: '', code: 0 })

    const container = moduleHarness('container', answer, {
      mode: 'tab',
      tabActive: false
    })
    activateContainer(container.ctx).applyPollers?.()
    expect(container.pollers[0].start).not.toHaveBeenCalled()
    expect(container.pollers[1].start).toHaveBeenCalledWith(60_000)
  })
})
