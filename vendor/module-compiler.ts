import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { build } from 'esbuild'
import type { Plugin, PluginBuild } from 'esbuild'
import type { ModuleManifest } from '@shared/modules'
import { appRoot } from './store'
import { moduleDir } from './modules-host'

/**
 * Bundling a module's main half into one runtime-loadable file with esbuild -
 * the piece that lets install/update/reload skip rebuilding the app.
 *
 * A module is only trusted with its own code and `shared/`: an import that
 * reaches anywhere else (another module, the server, an npm package, a Node
 * builtin) fails the build here instead of reaching the target machine's
 * shell with whatever that import happened to bring in.
 */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const FILE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.json']
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx']

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Node/esbuild-style resolution for the handful of shapes a module needs: exact file, or a folder's index. */
function resolveWithExtensions(base: string): string | null {
  for (const ext of FILE_EXTENSIONS) {
    if (isFile(base + ext)) return base + ext
  }
  for (const ext of INDEX_EXTENSIONS) {
    const candidate = join(base, `index${ext}`)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** True when `dir` is `root` or somewhere inside it. */
function isWithin(root: string, dir: string): boolean {
  if (dir === root) return true
  const rel = relative(root, dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Restricts every import in the module's build graph to its own folder or
 * `shared/`. Resolution is done by hand (not by delegating to esbuild's
 * defaults) so a bare specifier - an npm package, a Node builtin like `fs` -
 * is rejected outright rather than silently externalised.
 */
function scopeGuardPlugin(moduleRoot: string, sharedRoot: string): Plugin {
  return {
    name: 'bored-manager-module-scope-guard',
    setup(pluginBuild: PluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        const deny = (text: string): { errors: [{ text: string }] } => ({ errors: [{ text }] })

        if (args.kind === 'entry-point') {
          const resolved = resolveWithExtensions(args.path)
          return resolved ? { path: resolved } : deny(`cannot resolve entry point "${args.path}"`)
        }

        const p = args.path
        if (p === '@shared' || p.startsWith('@shared/')) {
          const rest = p.slice('@shared'.length).replace(/^[\\/]/, '')
          const target = rest ? join(sharedRoot, rest) : sharedRoot
          if (!isWithin(sharedRoot, target)) return deny(`import "${p}" resolves outside shared/`)
          const resolved = resolveWithExtensions(target)
          return resolved ? { path: resolved } : deny(`cannot resolve "${p}" (looked in shared/)`)
        }

        if (p.startsWith('./') || p.startsWith('../')) {
          // A file already inside shared/ importing a sibling relatively (shared/module-ui.ts
          // -> ./modules) stays inside shared/; a module file importing relatively stays inside
          // its own folder. Which one applies follows the file doing the importing, not the
          // entry point.
          const zoneRoot = isWithin(sharedRoot, args.resolveDir) ? sharedRoot : moduleRoot
          const target = resolve(args.resolveDir, p)
          if (!isWithin(zoneRoot, target)) {
            const zoneName = zoneRoot === sharedRoot ? 'shared/' : 'the module folder'
            return deny(`import "${p}" resolves outside ${zoneName}`)
          }
          const resolved = resolveWithExtensions(target)
          return resolved ? { path: resolved } : deny(`cannot resolve "${p}"`)
        }

        return deny(
          `import "${p}" is not allowed here - a module's main half may only import its own files and "@shared/*"`
        )
      })
    }
  }
}

/**
 * The bundle with every string literal, template literal and comment blanked
 * out, so a scan for syntax cannot be fooled by text that merely mentions it -
 * nor falsely tripped by a module that legitimately writes "import(" in a log
 * message. Replaced rather than removed so nothing shifts position.
 */
function codeOnly(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const current = source[i]
    const next = source[i + 1]
    if (current === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (current === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      const quote = current
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      // A template literal's ${...} can hold real code, but a dynamic import
      // written there would have to appear as `import(` inside the literal
      // too, so blanking the whole literal cannot hide one.
      out += '""'
      continue
    }
    out += current
    i++
  }
  return out
}

/**
 * `import(` surviving in a bundled module. After `bundle: true` every import
 * esbuild could resolve has been inlined, so what is left is a dynamic import
 * whose specifier is computed.
 *
 * That is the one hole the scope guard cannot see: `onResolve` is only
 * consulted for a specifier esbuild can read at build time, so
 * `await import(['node','child_process'].join(':'))` compiles clean, produces
 * no warning at all, and loads a Node builtin inside the server process when
 * the module activates. A module that needs something has to name it
 * statically, where the resolver can rule on it.
 */
const DYNAMIC_IMPORT = /\bimport\s*\(/

/**
 * Compile `root/<entries.main>` (read from `root/module.json`) into `outfile`,
 * bundled with the scope guard above. Rejects with a readable message on any
 * failure - a missing manifest, a missing entry, a disallowed import, a
 * computed dynamic import, or an esbuild error - and never writes a partial or
 * rejected file: the bundle is held in memory until it has passed every check.
 */
export async function compileModuleAt(root: string, outfile: string): Promise<void> {
  const manifestPath = join(root, 'module.json')
  let manifest: ModuleManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ModuleManifest
  } catch (err) {
    throw new Error(`could not read module.json: ${message(err)}`)
  }
  const entry = manifest.entries?.main
  if (!entry) throw new Error('entries.main is missing')
  const entryPath = join(root, entry)
  if (!existsSync(entryPath)) throw new Error(`entries.main does not exist: ${entry}`)

  const sharedRoot = join(appRoot(), 'shared')
  let bundled: string
  try {
    // write: false so a bundle that fails the check below never reaches the
    // disk at all - modules-host imports whatever `.dist/main.mjs` holds, so
    // a rejected build must not leave a loadable file behind.
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile,
      write: false,
      logLevel: 'silent',
      plugins: [scopeGuardPlugin(root, sharedRoot)]
    })
    const output = result.outputFiles?.[0]
    if (!output) throw new Error('the bundler produced no output')
    bundled = output.text
  } catch (err) {
    const withErrors = err as { errors?: Array<{ text: string }> }
    const text = Array.isArray(withErrors?.errors)
      ? withErrors.errors.map((e) => e.text).join('\n')
      : message(err)
    throw new Error(text)
  }

  if (DYNAMIC_IMPORT.test(codeOnly(bundled))) {
    throw new Error(
      'the compiled module still contains a dynamic import(). Every import a ' +
        'module makes has to be a literal the resolver can check, so that only ' +
        'its own files and "@shared/*" are reachable - a computed specifier ' +
        'skips that check entirely. Use a static import instead.'
    )
  }

  // An unchanged module bundles to the same bytes, and the host keys its
  // imported copy on those bytes: rewriting the file would only churn its
  // mtime and make every reader think the build moved.
  try {
    if (readFileSync(outfile, 'utf8') === bundled) return
  } catch {
    /* no readable bundle yet - write one */
  }
  mkdirSync(join(outfile, '..'), { recursive: true })
  writeFileSync(outfile, bundled)
}

/** Compile an installed module's main half to `modules/<id>/.dist/main.mjs`. */
export function compileModule(id: string): Promise<void> {
  const root = moduleDir(id)
  return compileModuleAt(root, join(root, '.dist', 'main.mjs'))
}
