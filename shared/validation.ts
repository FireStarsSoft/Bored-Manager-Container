/**
 * Small runtime guards shared by the browser and server. Keep this module
 * platform-neutral: protocol and settings validation run in both environments.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function finiteInteger(
  value: unknown,
  fallback: number,
  range: { min: number; max: number }
): number {
  if (!isFiniteNumber(value)) return fallback
  const integer = Math.trunc(value)
  return integer >= range.min && integer <= range.max ? integer : fallback
}

export function stringValue(
  value: unknown,
  fallback: string,
  options: { trim?: boolean; allowEmpty?: boolean; maxLength?: number } = {}
): string {
  if (typeof value !== 'string') return fallback
  const text = options.trim ? value.trim() : value
  if (options.allowEmpty === false && text.length === 0) return fallback
  if (options.maxLength != null && text.length > options.maxLength) return fallback
  return text
}
