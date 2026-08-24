#!/usr/bin/env node
// Zip the module folder into an archive the in-app installer accepts.
//
// Usage:
//   node scripts/package-module.mjs container [output-dir]
//   node scripts/package-module.mjs <path/to/module> [output-dir]
//
// A copy of the app's scripts/package-module.mjs (see sdk.lock.json) with two
// changes: a module id is resolved against this repo's root rather than against
// a modules/ folder, and the archive is byte-reproducible - every entry carries
// a fixed timestamp instead of the clock, so the same source always packs to the
// same bytes. That is what lets registry/modules.json in the app repo carry a
// sha256 a rebuild can be held against.
//
// The archive contains a single top-level folder named after the module id,
// with module.json at its root - the shape findArchiveRoot() looks for. The
// module is checked against the same rules the installer applies, so a zip
// produced here cannot fail those checks for a reason this script could have
// caught first.
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { deflateRawSync } from 'zlib'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

const [target, outArg] = process.argv.slice(2)
if (!target) {
  console.error('usage: node scripts/package-module.mjs <module-id|path> [output-dir]')
  process.exit(1)
}

const dir = existsSync(target) ? resolve(target) : join(repoRoot, target)
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`ERROR: ${dir} is not a folder.`)
  process.exit(1)
}

const manifestPath = join(dir, 'module.json')
if (!existsSync(manifestPath)) {
  console.error(`ERROR: ${manifestPath} does not exist - this is not a module folder.`)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`ERROR: module.json is not valid JSON: ${err.message}`)
  process.exit(1)
}

/** Mirrors RESERVED_MODULE_IDS in shared/modules.ts, which this script cannot import. */
const RESERVED_IDS = [
  'overview',
  'packages',
  'terminals',
  'settings',
  'core',
  'app',
  'module',
  'modules',
  'system',
  'top',
  'services',
  'metrics'
]

// The rules that can be checked here are the ones about the folder itself; the
// installer repeats all of them plus the ones that need the app's own version.
const problems = []
if (manifest.apiVersion !== 2) problems.push(`apiVersion must be 2 (found ${manifest.apiVersion})`)
if (!/^[a-z][a-z0-9-]{1,31}$/.test(manifest.id ?? '')) {
  problems.push(`"${manifest.id}" is not a valid module id`)
} else if (RESERVED_IDS.includes(manifest.id)) {
  problems.push(`"${manifest.id}" is a name the app uses itself`)
}
if (manifest.id !== basename(dir)) {
  problems.push(`id "${manifest.id}" does not match the folder name "${basename(dir)}"`)
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) {
  problems.push(`version "${manifest.version}" is not in x.y.z form`)
}
if (!manifest.entries?.main) {
  problems.push('entries.main is required')
} else if (!existsSync(join(dir, manifest.entries.main))) {
  problems.push(`entries.main points at a missing file: ${manifest.entries.main}`)
}
if (manifest.entries?.renderer) {
  problems.push(
    'entries.renderer is no longer supported (API v2) - move the UI to ui/pages/*.json and ui/widgets/*.json'
  )
}
for (const page of manifest.pages ?? []) {
  const specPath = join(dir, 'ui', 'pages', `${page.id}.json`)
  if (!existsSync(specPath)) problems.push(`missing ui/pages/${page.id}.json for page "${page.id}"`)
}
for (const widget of manifest.widgets ?? []) {
  const specPath = join(dir, 'ui', 'widgets', `${widget.id}.json`)
  if (!existsSync(specPath)) problems.push(`missing ui/widgets/${widget.id}.json for widget "${widget.id}"`)
}
if (problems.length) {
  console.error('ERROR: this module would be rejected by the installer:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
for (const doc of ['README.md', 'CHANGELOG.md']) {
  if (!existsSync(join(dir, doc))) {
    console.warn(`    WARNING: no ${doc} - the installer will flag this as a warning.`)
  }
}

// `.dist/` is compiled at runtime and skipped by the integrity hash, so it does
// not belong in the archive either. Shipping it is worse than pointless: the
// host decides whether to recompile by comparing its mtime against `main/`, and
// an unpacked archive can hand it one that looks newer than the source it came
// from - leaving the module running code from whoever built the zip.
function listFiles(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.dist') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) listFiles(path, base, out)
    else if (entry.isFile()) out.push(relative(base, path).split(sep).join('/'))
  }
  return out
}

// ---------- Minimal zip writer (deflate, no zip64) ----------
// Writing the archive by hand keeps this script dependency-free and, more
// importantly, guarantees forward slashes in entry names on every platform -
// which is what the app's own extractor and every unzip tool expect.

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * DOS date/time, as the zip format stores it - fixed rather than read from the
 * clock. Two packs of the same source have to produce the same bytes, or the
 * sha256 the catalog vouches for could only ever come from one particular run.
 * 2020-01-01 00:00:00 is an arbitrary constant inside the range the format can
 * express (which starts at 1980), and being a constant it does not move with
 * the timezone of the machine that packs the archive either.
 */
const FIXED_DOS = {
  time: 0,
  day: (((2020 - 1980) & 127) << 9) | ((1 & 15) << 5) | (1 & 31)
}

const files = listFiles(dir).sort()
// The app's copy of this script writes next to itself, into a folder that is
// always there; here the default output is dist/, which is gitignored and so
// does not exist on a fresh clone or a CI runner.
const outputDir = resolve(outArg ?? scriptDir)
mkdirSync(outputDir, { recursive: true })
const zipName = `${manifest.id}-${manifest.version}.zip`
const zipPath = join(outputDir, zipName)

const local = []
const central = []
let offset = 0
const now = FIXED_DOS

for (const rel of files) {
  const name = Buffer.from(`${manifest.id}/${rel}`, 'utf8')
  const raw = readFileSync(join(dir, rel))
  const deflated = deflateRawSync(raw, { level: 9 })
  // A file that grows when compressed is stored as-is (method 0).
  const stored = deflated.length >= raw.length
  const body = stored ? raw : deflated
  const crc = crc32(raw)

  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4) // version needed
  header.writeUInt16LE(0x0800, 6) // UTF-8 names
  header.writeUInt16LE(stored ? 0 : 8, 8)
  header.writeUInt16LE(now.time, 10)
  header.writeUInt16LE(now.day, 12)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(body.length, 18)
  header.writeUInt32LE(raw.length, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  local.push(header, name, body)

  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50, 0)
  entry.writeUInt16LE(20, 4) // version made by
  entry.writeUInt16LE(20, 6) // version needed
  entry.writeUInt16LE(0x0800, 8)
  entry.writeUInt16LE(stored ? 0 : 8, 10)
  entry.writeUInt16LE(now.time, 12)
  entry.writeUInt16LE(now.day, 14)
  entry.writeUInt32LE(crc, 16)
  entry.writeUInt32LE(body.length, 20)
  entry.writeUInt32LE(raw.length, 24)
  entry.writeUInt16LE(name.length, 28)
  entry.writeUInt32LE(offset, 42)
  central.push(entry, name)

  offset += header.length + name.length + body.length
}

const centralBuf = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralBuf.length, 12)
end.writeUInt32LE(offset, 16)

const out = createWriteStream(zipPath)
out.write(Buffer.concat([...local, centralBuf, end]))
out.end(() => {
  const size = statSync(zipPath).size
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}
`, 'utf8')
  console.log(`==> ${zipPath}`)
  console.log(`    ${manifest.name} ${manifest.version} - ${files.length} files, ${(size / 1024).toFixed(1)} KB`)
  console.log(`    sha256 ${sha256}`)
  console.log('    Install it with Settings -> Modules -> From file, or attach it to a')
  console.log("    release and put that sha256 in the app repo's registry/modules.json.")
})
