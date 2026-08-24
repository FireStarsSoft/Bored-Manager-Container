import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModuleManifest } from '@shared/modules'
import { moduleHarness } from '../helpers/module-harness'
import activate from '../../container/main/index'

/**
 * The contract between the module's two halves.
 *
 * A module is a manifest, a `main/` that registers methods and emits streams,
 * and JSON specs the renderer draws from - three files that nothing forces to
 * agree. `npm run specs` already checks a spec against the *manifest*; what
 * nothing checked is whether the main half actually did what the manifest
 * said. A button whose method was renamed in `main/` still validates, still
 * renders, and answers `METHOD_NOT_FOUND` the first time somebody presses it.
 * That is the shape of every "the page is there but nothing works" report.
 *
 * So the module is activated here for real - no fixtures needed, since
 * `ctx.handle` runs while the module is being set up - and every method its
 * pages and widgets call is checked against what it registered.
 *
 * This is a one-module copy of the app repository's
 * tests/unit/modules/spec-contract.test.ts, which sweeps everything the app
 * ships. A module released on its own is in nobody else's sweep.
 */

const ID = 'container'

/** The module folder is the repository root's `container/`, not `modules/container/`. */
function moduleDir(): string {
  return join(process.cwd(), ID)
}

const manifest = JSON.parse(readFileSync(join(moduleDir(), 'module.json'), 'utf8')) as ModuleManifest

/** Every `ui/pages/*.json` and `ui/widgets/*.json` the manifest declares, by a readable name. */
function specsOf(): Array<{ where: string; spec: unknown }> {
  const out: Array<{ where: string; spec: unknown }> = []
  for (const page of manifest.pages ?? []) {
    out.push({
      where: `pages/${page.id}.json`,
      spec: JSON.parse(readFileSync(join(moduleDir(), 'ui', 'pages', `${page.id}.json`), 'utf8'))
    })
  }
  for (const widget of manifest.widgets ?? []) {
    out.push({
      where: `widgets/${widget.id}.json`,
      spec: JSON.parse(readFileSync(join(moduleDir(), 'ui', 'widgets', `${widget.id}.json`), 'utf8'))
    })
  }
  return out
}

/** Every object anywhere in a spec, however it is nested. */
function everyObject(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next !== 'object' || next === null) continue
    if (seen.has(next)) continue
    seen.add(next)
    if (!Array.isArray(next)) out.push(next as Record<string, unknown>)
    for (const item of Array.isArray(next) ? next : Object.values(next)) pending.push(item)
  }
  return out
}

/**
 * Walked rather than enumerated per block type: a method can be named by an
 * `invoke` source, a button, a row action, a bulk action, a form's submit, a
 * check/apply pair or a log block's start/stop, and new places keep appearing.
 * Anything that has to be a method name is one of these keys.
 */
const METHOD_KEYS = ['method', 'checkMethod', 'applyMethod', 'startMethod', 'stopMethod']

function methodsCalledBy(spec: unknown): Set<string> {
  const out = new Set<string>()
  for (const object of everyObject(spec)) {
    for (const key of METHOD_KEYS) {
      const value = object[key]
      if (typeof value === 'string' && value.length > 0) out.add(value)
    }
  }
  return out
}

/**
 * Only `{kind: 'stream'}` sources and a history source's `liveEvent`. A `log`
 * block's bare `event` is deliberately excluded: it may tail something the
 * manifest does not declare (see the note in modules-host's `emit`).
 */
function streamsReadBy(spec: unknown): Set<string> {
  const out = new Set<string>()
  for (const object of everyObject(spec)) {
    if (object['kind'] === 'stream' && typeof object['event'] === 'string') {
      out.add(object['event'])
    }
    if (object['kind'] === 'history' && typeof object['liveEvent'] === 'string') {
      out.add(object['liveEvent'] as string)
    }
  }
  return out
}

/** Activate for real and collect what the main half registered. */
function registeredMethods(): Set<string> {
  const harness = moduleHarness(ID, () => ({ stdout: '', stderr: '', code: 0 }))
  const instance = activate(harness.ctx)
  const registered = new Set(harness.handlers.keys())
  instance.dispose?.()
  harness.revoke()
  return registered
}

describe(`${ID}: what its two halves promise each other`, () => {
  const declared = new Set(manifest.methods ?? [])
  const streams = new Set((manifest.streams ?? []).map((stream) => stream.event))
  const specs = specsOf()

  /**
   * The manifest is what the renderer builds its dispatcher from, so a method
   * declared and never registered is a call that reaches the host and stops
   * there. `ctx.handle` already refuses the other direction.
   */
  it('registers exactly the methods its manifest declares', () => {
    expect([...registeredMethods()].sort()).toEqual([...declared].sort())
  })

  it('calls only methods it registered, from every page and widget', () => {
    const registered = registeredMethods()
    const missing: string[] = []
    for (const { where, spec } of specs) {
      for (const method of methodsCalledBy(spec)) {
        if (!registered.has(method)) missing.push(`${where} calls ${method}`)
      }
    }

    expect(missing).toEqual([])
  })

  it('reads only streams its manifest declares, from every page and widget', () => {
    const missing: string[] = []
    for (const { where, spec } of specs) {
      for (const event of streamsReadBy(spec)) {
        if (!streams.has(event)) missing.push(`${where} reads ${event}`)
      }
    }

    expect(missing).toEqual([])
  })

  /**
   * A page in the manifest with no spec file renders as a sidebar entry that
   * leads nowhere; `specsOf` would have thrown above, so this states the
   * expectation rather than repeating the read.
   */
  it('ships a spec for every page and widget it declares', () => {
    expect(specs.map((entry) => entry.where)).toHaveLength(
      (manifest.pages ?? []).length + (manifest.widgets ?? []).length
    )
  })

  /**
   * The folder name is not cosmetic: the installer rejects an archive whose
   * manifest id disagrees with the folder it unpacks into, so this is the same
   * check `npm run pack` makes, stated where a rename would be noticed first.
   */
  it('is packaged under a folder named after its id', () => {
    expect(manifest.id).toBe(ID)
  })
})
