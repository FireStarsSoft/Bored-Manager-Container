#!/usr/bin/env node
// Keep the copies of Bored Manager's own files that this repo needs in step
// with the app they came from.
//
// A module is compiled by the app, not by this repo: its main half may import
// its own files and "@shared/*", and "@shared" resolves to the *app's* shared/
// folder. To typecheck and unit-test the module here, that folder has to exist
// here too - so it is vendored, pinned to one app ref, and its contents are
// recorded in sdk.lock.json. vendor/module-compiler.ts is vendored for the same
// reason: `npm run compile` then runs the real scope guard rather than a
// re-implementation of it that could disagree.
//
// Usage:
//   node scripts/sync-sdk.mjs                  re-fetch every file at the pinned ref
//   node scripts/sync-sdk.mjs --ref v0.5.0     move the pin, then re-fetch
//   node scripts/sync-sdk.mjs --from ../Bored-Manager
//                                              copy from a local checkout instead
//   node scripts/sync-sdk.mjs --check          offline: do the local copies still
//                                              hash to what the lock recorded?
//   node scripts/sync-sdk.mjs --against main   report which vendored files the app
//                                              has changed since the pin
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(repoRoot, 'sdk.lock.json')

const argv = process.argv.slice(2)
function option(name) {
  const at = argv.indexOf(name)
  if (at === -1) return null
  const value = argv[at + 1]
  if (!value || value.startsWith('--')) {
    console.error(`ERROR: ${name} needs a value.`)
    process.exit(1)
  }
  return value
}
const checkOnly = argv.includes('--check')
const against = option('--against')
const fromDir = option('--from')
const newRef = option('--ref')

const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
if (lock.version !== 1) {
  console.error(`ERROR: sdk.lock.json speaks version ${lock.version}, this script speaks 1.`)
  process.exit(1)
}
if (newRef) lock.ref = newRef

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Raw bytes of one file in the app repo at `ref`. */
async function fetchUpstream(path, ref) {
  const url = `https://raw.githubusercontent.com/${lock.repo}/${encodeURIComponent(ref)}/${path}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} replied ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * The bytes to write, always the app repository's own: LF, whatever the machine
 * running this is. raw.githubusercontent serves the blob, so that path already
 * is. A local checkout is not - the app's .gitattributes pins its modules/ and
 * its shell scripts to LF but not shared/, so a Windows working copy holds CRLF
 * where git holds LF - and copying that would record a hash no Linux checkout,
 * release zip or CI run could ever reproduce. Every file this script carries is
 * text, so undoing that is just the CRLF pairs.
 */
const CR = 0x0d
const LF = 0x0a

/** Every CRLF pair dropped to LF, byte for byte - no decoding round trip. */
function toLf(buffer) {
  const out = Buffer.alloc(buffer.length)
  let length = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === CR && buffer[i + 1] === LF) continue
    out[length++] = buffer[i]
  }
  return out.subarray(0, length)
}

async function source(entry, ref) {
  if (fromDir) {
    const path = resolve(fromDir, entry.from)
    if (!existsSync(path)) throw new Error(`${path} does not exist`)
    return toLf(readFileSync(path))
  }
  return fetchUpstream(entry.from, ref)
}

// --- offline: have the local copies been edited? ------------------------------
if (checkOnly) {
  let bad = 0
  for (const entry of lock.files) {
    const path = join(repoRoot, entry.to)
    if (!existsSync(path)) {
      console.error(`missing  ${entry.to}`)
      bad++
      continue
    }
    const actual = sha256(readFileSync(path))
    if (actual !== entry.sha256) {
      console.error(`changed  ${entry.to}`)
      console.error(`         lock ${entry.sha256}`)
      console.error(`         disk ${actual}`)
      bad++
    }
  }
  if (bad) {
    console.error(
      `\n${bad} vendored file(s) do not match sdk.lock.json. These are copies of ` +
        `${lock.repo}@${lock.ref} and are not edited here: run "npm run sdk:sync" to ` +
        `restore them, or fix the app and move the pin.`
    )
    process.exit(1)
  }
  console.log(`sdk.lock.json is intact (${lock.files.length} files from ${lock.repo}@${lock.ref}).`)
  process.exit(0)
}

// --- online: what has the app changed since the pin? --------------------------
if (against) {
  let drifted = 0
  for (const entry of lock.files) {
    let upstream
    try {
      upstream = await fetchUpstream(entry.from, against)
    } catch (err) {
      console.error(`error    ${entry.from}: ${err.message}`)
      drifted++
      continue
    }
    if (sha256(upstream) === entry.sha256) console.log(`same     ${entry.from}`)
    else {
      console.log(`DRIFTED  ${entry.from}`)
      drifted++
    }
  }
  if (drifted) {
    console.log(
      `\n${drifted} file(s) differ between ${lock.repo}@${lock.ref} (pinned) and ` +
        `${lock.repo}@${against}. Re-pin with "node scripts/sync-sdk.mjs --ref ${against}" ` +
        `and run the checks - a module compiled against an older SDK still installs, but ` +
        `types it relies on may have moved.`
    )
    process.exit(1)
  }
  console.log(`\nNothing has drifted: ${against} matches the pinned ${lock.ref}.`)
  process.exit(0)
}

// --- write ---------------------------------------------------------------------
for (const entry of lock.files) {
  let bytes
  try {
    bytes = await source(entry, lock.ref)
  } catch (err) {
    console.error(`ERROR: ${entry.from}: ${err.message}`)
    process.exit(1)
  }
  const path = join(repoRoot, entry.to)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  entry.sha256 = sha256(bytes)
  console.log(`${entry.to.padEnd(34)} ${entry.sha256.slice(0, 12)}…`)
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8')
console.log(
  `\nWrote ${lock.files.length} file(s) from ${fromDir ?? `${lock.repo}@${lock.ref}`} and updated sdk.lock.json.`
)
