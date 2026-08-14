/**
 * The module's own settings page: reading which rules are in force, and
 * changing them through the same check-then-apply step everything else here
 * uses. Leaving a field empty removes the override, so "back to the default"
 * needs no separate control per rule.
 */
import type { ModuleCheckFinding, ModuleCheckReport } from '@shared/check'
import { createCheckSession } from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  DEFAULT_RULES,
  RULE_BOUNDS,
  RULE_UNUSUAL,
  effectiveRules,
  type ContainerRules
} from './rules'

type RuleOverrides = Partial<Record<keyof ContainerRules, number | boolean>>

export class RulesEditor {
  private session = createCheckSession<RuleOverrides>()

  constructor(private ctx: ModuleContext) {}

  /**
   * One row per rule, with the value already labelled "(default)" or
   * "(custom)": a `keyValue` block prints what it is given, and working out
   * which is which needs the defaults, which only this half has.
   */
  effective(): Record<string, string> {
    const rules = effectiveRules(this.ctx)
    const out: Record<string, string> = {}
    for (const key of Object.keys(DEFAULT_RULES) as Array<keyof ContainerRules>) {
      const value = rules[key]
      const isDefault = value === DEFAULT_RULES[key]
      out[key] = `${String(value)} (${isDefault ? 'default' : 'custom'})`
    }
    return out
  }

  check(input: unknown): ModuleCheckReport {
    const findings: ModuleCheckFinding[] = []
    const overrides: RuleOverrides = {}
    const values = (input as Record<string, unknown>) ?? {}

    for (const [key, bounds] of Object.entries(RULE_BOUNDS)) {
      const raw = values[key]
      const asText = typeof raw === 'string' ? raw.trim() : raw
      if (asText === '' || asText === undefined || asText === null) continue
      const value = Number(asText)
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        findings.push({ level: 'error', label: `${bounds.label}: "${String(raw)}" is not a whole number` })
        continue
      }
      if (value < bounds.min || value > bounds.max) {
        findings.push({
          level: 'error',
          label: `${bounds.label} must be between ${bounds.min} and ${bounds.max}`,
          detail: `You entered ${value}.`
        })
        continue
      }
      const unusual = RULE_UNUSUAL[key]?.(value)
      if (unusual) findings.push({ level: 'warning', label: `${bounds.label} = ${value}`, detail: unusual })
      overrides[key as keyof ContainerRules] = value
    }

    // The one boolean: a checkbox is always sent, so it is always an override.
    const arp = values['enableArpAdvisory']
    if (typeof arp === 'boolean') {
      overrides.enableArpAdvisory = arp
      if (!arp) {
        findings.push({
          level: 'info',
          label: 'Neighbour table advisories will be switched off',
          detail: 'Create checks will stop warning when an L2 network would outgrow the ARP cache.'
        })
      }
    }

    const changed = Object.entries(overrides).filter(
      ([key, value]) => value !== DEFAULT_RULES[key as keyof ContainerRules]
    )
    const cleared = Object.keys(DEFAULT_RULES).filter((key) => !(key in overrides))
    findings.push({
      level: 'pass',
      label: changed.length
        ? `${changed.length} rule(s) will differ from the defaults`
        : 'Every rule will be back at its default',
      detail: changed.length
        ? changed.map(([key, value]) => `${key} = ${String(value)}`).join(', ')
        : undefined
    })
    if (cleared.length && changed.length) {
      findings.push({
        level: 'info',
        label: `${cleared.length} rule(s) left empty will use the default`,
        detail: cleared.join(', ')
      })
    }

    const ok = !findings.some((f) => f.level === 'error')
    if (!ok) return { ok, findings }
    return { ok, token: this.session.issue(input, overrides), findings }
  }

  apply(payload: unknown): OkResult {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    // Only the rules that actually differ are stored, so a later change to a
    // default is picked up instead of being masked by a copy of the old one.
    const kept: RuleOverrides = {}
    for (const [key, value] of Object.entries(taken.payload)) {
      if (value === DEFAULT_RULES[key as keyof ContainerRules]) continue
      kept[key as keyof ContainerRules] = value
    }
    this.write(kept)
    this.ctx.log(`rule overrides saved: ${Object.keys(kept).join(', ') || 'none'}`)
    return { ok: true }
  }

  reset(): OkResult {
    this.write({})
    this.ctx.log('rule overrides cleared')
    return { ok: true }
  }

  private write(rules: RuleOverrides): void {
    const existing = this.ctx.configGet()
    const base = typeof existing === 'object' && existing !== null ? { ...(existing as object) } : {}
    this.ctx.configSet({ ...base, rules })
  }
}
