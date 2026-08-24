/**
 * What the select fields in the Fleet forms offer. One method rather than one
 * per list, because a form field names a `{method, args}` pair and a single
 * `selectOptions('docker-networks')` keeps the manifest's method list short
 * and the page specs readable.
 */
import type { ModuleContext } from '@shared/modules'
import type { FormFieldOption } from '@shared/module-ui'
import type { OkResult } from '@shared/types'
import type { IncusCli } from './incus'
import { probeHost } from './probe'
import type { HostStore, TemplateRecord } from './store'

export type OptionKind =
  | 'docker-networks'
  | 'host-interfaces'
  | 'incus-profiles'
  | 'incus-networks'
  | 'incus-pools'
  | 'templates-create-docker'
  | 'templates-create-incus'

/** An empty first choice, so "no template" and "the default network" stay reachable. */
const NONE: FormFieldOption = { value: '', label: '—' }

export class OptionSource {
  constructor(
    private ctx: ModuleContext,
    private cli: IncusCli,
    private store: HostStore
  ) {}

  async list(kind: unknown): Promise<FormFieldOption[]> {
    switch (kind as OptionKind) {
      case 'docker-networks': {
        const probe = await probeHost(this.ctx)
        return [
          NONE,
          ...[...probe.networks.values()].map((n) => ({
            value: n.name,
            label: n.driver ? `${n.name} (${n.driver})` : n.name
          }))
        ]
      }
      case 'host-interfaces': {
        const probe = await probeHost(this.ctx)
        return [NONE, ...probe.interfaces.map((name) => ({ value: name, label: name }))]
      }
      case 'incus-profiles':
        return [NONE, ...(await this.cli.profiles()).map((p) => ({ value: p.name, label: p.name }))]
      case 'incus-networks':
        return [
          NONE,
          ...(await this.cli.networks()).map((n) => ({
            value: n.name,
            label: n.description ? `${n.name} (${n.description})` : n.name
          }))
        ]
      case 'incus-pools':
        return [
          NONE,
          ...(await this.cli.pools()).map((p) => ({
            value: p.name,
            label: p.description ? `${p.name} (${p.description})` : p.name
          }))
        ]
      case 'templates-create-docker':
        return this.templates('create-docker')
      case 'templates-create-incus':
        return this.templates('create-incus')
      default:
        return []
    }
  }

  private templates(kind: TemplateRecord['kind']): FormFieldOption[] {
    return [
      NONE,
      ...this.store
        .read()
        .templates.filter((t) => t.kind === kind)
        .map((t) => ({ value: t.id, label: t.name }))
    ]
  }
}

/** The saved forms, as the small table on the module settings page shows them. */
export function listTemplates(store: HostStore): Array<{
  id: string
  name: string
  kind: string
  fields: number
  createdAt: number
}> {
  return store.read().templates.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind === 'create-docker' ? 'Docker' : 'Incus',
    fields: Object.keys(t.values).length,
    createdAt: t.createdAt
  }))
}

export function deleteTemplate(store: HostStore, id: string): OkResult {
  return store.update((data) => {
    const before = data.templates.length
    data.templates = data.templates.filter((t) => t.id !== id)
    return before === data.templates.length ? { ok: false, error: 'no such template' } : { ok: true }
  })
}
