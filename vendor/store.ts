import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * Stands in for the app's server/services/store.ts, so `module-compiler.ts`
 * next to this file can be a byte-for-byte copy of the app's - see
 * sdk.lock.json and scripts/sync-sdk.mjs.
 *
 * The compiler asks the app root only to find `shared/`, and this repo keeps
 * its vendored copy in the same place the app keeps the real one, so pointing
 * it at the repo root resolves `@shared/*` exactly as the installer would.
 */
export function appRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}
