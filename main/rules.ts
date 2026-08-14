/**
 * The limits every check in this module measures against. They are defaults,
 * not constants: what counts as "too many containers at once" depends on the
 * machine, so each one can be overridden per install from the module's own
 * settings page, and an override always wins over the value here.
 */
import type { ModuleContext } from '@shared/modules'

export interface ContainerRules {
  /** Refuse a create job larger than this. */
  maxCreateCount: number
  /** At or above this many Docker containers, suggest Incus instead. */
  preferIncusThreshold: number
  /** How many items a parallel job runs at once. */
  maxParallel: number
  /** Warn once a bulk action would touch this many containers. */
  bulkActionWarn: number
  /** Warn once the requested memory would take this share of what is available. */
  memHeadroomPct: number
  minPasswordLen: number
  /** How long one item of a job may take before it is given up on. */
  itemTimeoutSec: number
  /** Whether a create check looks at the neighbour table before an L2 network. */
  enableArpAdvisory: boolean
}

export const DEFAULT_RULES: ContainerRules = {
  maxCreateCount: 50,
  preferIncusThreshold: 10,
  maxParallel: 4,
  bulkActionWarn: 25,
  memHeadroomPct: 90,
  minPasswordLen: 8,
  itemTimeoutSec: 120,
  enableArpAdvisory: true
}

/** What each rule may be set to. A check reports anything outside as an error. */
export const RULE_BOUNDS: Record<string, { min: number; max: number; label: string }> = {
  maxCreateCount: { min: 1, max: 500, label: 'Largest create job' },
  preferIncusThreshold: { min: 1, max: 500, label: 'Suggest Incus at' },
  maxParallel: { min: 1, max: 16, label: 'Parallel items at once' },
  bulkActionWarn: { min: 1, max: 1000, label: 'Warn on bulk action size' },
  memHeadroomPct: { min: 50, max: 100, label: 'Memory headroom %' },
  minPasswordLen: { min: 4, max: 128, label: 'Minimum password length' },
  itemTimeoutSec: { min: 10, max: 3600, label: 'Per-item timeout (s)' }
}

/** Extreme but legal values, worth a warning rather than a refusal. */
export const RULE_UNUSUAL: Record<string, (value: number) => string | null> = {
  maxCreateCount: (v) => (v > 200 ? 'A job that size will hold the connection for a long while.' : null),
  maxParallel: (v) => (v > 8 ? 'More parallel work than most machines can pull images for.' : null),
  minPasswordLen: (v) => (v < 8 ? 'Below 8 characters is short for a login that is reachable over the network.' : null),
  itemTimeoutSec: (v) => (v < 30 ? 'Pulling an image usually takes longer than this.' : null)
}

/**
 * The rules in force: the defaults with whatever the user overrode on top.
 * A stored value of the wrong type is ignored rather than trusted, since this
 * is read from a file the app does not otherwise validate.
 */
export function effectiveRules(ctx: ModuleContext): ContainerRules {
  const out = { ...DEFAULT_RULES }
  const raw = ctx.configGet()
  const overrides = (raw as { rules?: unknown } | null)?.rules
  if (typeof overrides !== 'object' || overrides === null) return out
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(key in DEFAULT_RULES)) continue
    const expected = typeof DEFAULT_RULES[key as keyof ContainerRules]
    if (typeof value !== expected) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    ;(out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

/** Which rules the user has actually overridden, for the "50 (default)" column. */
export function overriddenRuleKeys(ctx: ModuleContext): Set<string> {
  const raw = ctx.configGet()
  const overrides = (raw as { rules?: unknown } | null)?.rules
  if (typeof overrides !== 'object' || overrides === null) return new Set()
  const effective = effectiveRules(ctx)
  const out = new Set<string>()
  for (const key of Object.keys(DEFAULT_RULES)) {
    const value = (overrides as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (effective[key as keyof ContainerRules] !== DEFAULT_RULES[key as keyof ContainerRules]) out.add(key)
    else if (value === DEFAULT_RULES[key as keyof ContainerRules]) out.add(key)
  }
  return out
}
