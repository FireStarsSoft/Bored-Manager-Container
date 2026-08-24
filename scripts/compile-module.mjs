#!/usr/bin/env node
// Compile the module's main half with the app's own compiler, so a disallowed
// import or a syntax error shows up here instead of at install time.
//
// vendor/module-compiler.ts is a copy of the app's
// server/services/module-compiler.ts, imports and all - the scope guard that
// decides what a module may import is the real one, not a re-implementation.
//
// Usage: npx tsx scripts/compile-module.mjs
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { compileModuleAt } from '../vendor/module-compiler.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(repoRoot, 'container')

try {
  await compileModuleAt(dir, join(dir, '.dist', 'main.mjs'))
  console.log('ok container')
} catch (err) {
  console.error(`container: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
