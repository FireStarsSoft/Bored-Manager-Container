import { join } from 'path'
import { appRoot } from './store'

/**
 * Stands in for the app's server/services/modules-host.ts, so
 * `module-compiler.ts` next to this file can be a byte-for-byte copy of the
 * app's - see sdk.lock.json and scripts/sync-sdk.mjs.
 *
 * In the app a module lives at `modules/<id>/`; in this repo the one module it
 * holds is a top-level folder named after its id, so `moduleDir('container')` is
 * `container/`.
 */
export function moduleDir(id: string): string {
  return join(appRoot(), id)
}
