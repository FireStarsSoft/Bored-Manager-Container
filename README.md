# Bored Manager — Container module

The Container module for [Bored Manager](https://github.com/FireStarsSoft/Bored-Manager),
developed and released on its own. Docker and Incus on the target machine, side by side: what is running, what it
costs, logs and an exec shell, images, volumes and networks — plus tags, bulk
create and bulk actions, each behind a check step that says what would happen
before it happens, and installing either runtime on a machine that has neither.

Everything the module itself does is documented in
[`container/README.md`](container/README.md); what changed in each version is in
[`container/CHANGELOG.md`](container/CHANGELOG.md). This file is about the
repository.

## Installing it

You do not need this repository to use the module. In Bored Manager, open
**Settings → Modules** and install it by any of:

| Source | What to enter |
|---|---|
| Official list | pick **Container** from the list the app ships |
| Catalog | pick **Container** from the reviewed list |
| GitHub repo | `FireStarsSoft/Bored-Manager-Container` |
| Zip URL / file | the `container-<version>.zip` attached to a [release](../../releases) |

It needs Bored Manager **0.2.0** or newer and installs **switched off** —
enable it in the same place. Bored Manager **0.4.2** is the first app
release that does not bundle it; an older app already carrying version 3.1.12
keeps it across the update and can update to 3.1.13 from here without losing its
tags, rules, saved hosts or history.

## Layout

```
container/          the module, and nothing else — this folder is what ships
  module.json         manifest: pages, widgets, streams, methods
  main/               the main half, compiled by the app at install time
  ui/pages/*.json     page specs the app renders (Dashboard, Docker, Images,
                        Logs, Incus, Fleet operations, Module settings)
  ui/widgets/*.json   Overview widget specs (Containers, Container resources)
  README.md           what the module does
  CHANGELOG.md        module versions, independent of the app's
shared/             vendored copy of the app's shared/ — what `@shared/*` means
vendor/             vendored copy of the app's module compiler, plus two shims
tests/              unit tests for main/, on the app's own module harness
scripts/            packaging and the checks CI runs
sdk.lock.json       which app ref the two vendored folders came from
```

`container/` is hashed byte for byte by the app that installs it, so the checkout
has to match the release zip exactly: `.gitattributes` pins the whole repository
to LF, and nothing that is not part of the module goes into that folder.

## Working on it

```bash
npm install
npm run check      # sdk:check + typecheck + test + specs + compile
```

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc` over the module, the vendored SDK and the tests |
| `npm test` | Vitest over `tests/`, using the app's `moduleHarness` |
| `npm run specs` | every `ui/*.json` through the app's own spec validator |
| `npm run compile` | esbuild through the app's real scope guard — catches an import a module is not allowed to make |
| `npm run pack` | writes `dist/container-<version>.zip` and its `.sha256` |
| `npm run sdk:check` | have the vendored copies been edited? (offline) |
| `npm run sdk:sync` | re-fetch them at the pinned ref |
| `npm run sdk:drift` | what has the app changed since the pin? (online) |

To try a build against a real app, unzip `dist/container-<version>.zip` into the
app's `modules/` folder and press **Reload** in Settings → Modules, or install
the zip from **From file**.

### Why `shared/` and `vendor/` are copies

A module's main half may import its own files and `@shared/*`, and nothing else
— the app's `server/services/module-compiler.ts` enforces that when it compiles
the module, and `@shared` resolves to the **app's** `shared/` folder, not to
anything shipped with the module. To typecheck and unit-test that code outside
the app, this repository keeps a copy of the app files it compiles against,
pinned to one app ref in [`sdk.lock.json`](sdk.lock.json) and hashed there.

- `npm run sdk:check` (in CI, offline) fails if a vendored file was edited here.
  They are copies; fix the app instead.
- `npm run sdk:drift` (online) reports which of them the app's `main` has moved
  since the pin. Re-pin with `node scripts/sync-sdk.mjs --ref <tag>` and run
  `npm run check`.

`vendor/store.ts` and `vendor/modules-host.ts` are the only two files written
here rather than copied: they answer the two questions the compiler asks its
host (where the app root is, where a module folder is), so
`vendor/module-compiler.ts` can stay a byte-for-byte copy.

## Releasing

1. Bump `version` in `container/module.json` and add a section to
   `container/CHANGELOG.md`.
2. `npm run check`, then `npm run pack` and note the sha256 it prints. The
   archive is byte-reproducible — a fixed timestamp rather than the clock — so
   that hash is a property of the source, not of the run.
3. Tag `v<version>` and push it. The release workflow re-runs every check,
   rebuilds the zip, refuses to publish if the tag and the manifest disagree,
   and attaches `container-<version>.zip` and its `.sha256`.
4. Update the catalog entry in the app repo's
   [`registry/modules.json`](https://github.com/FireStarsSoft/Bored-Manager/blob/main/registry/modules.json)
   with the new `version`, `download` URL, `sha256` and `verifiedAt`. Until that
   lands, installing still works — the user just gets the `unverified-source`
   warning and has to confirm.

Exactly one `.zip` may be attached to a release: the app picks the module
archive by "the only zip asset that is not the app's own", and a second one
makes the install fail rather than guess.

## Contributing

The rules a module has to follow — lifecycle, what `ctx` may be used for after
a stop, what a spec may name — are the app's:
[docs/MODULE-RULESET.md](https://github.com/FireStarsSoft/Bored-Manager/blob/main/docs/MODULE-RULESET.md)
and [docs/MODULES.md](https://github.com/FireStarsSoft/Bored-Manager/blob/main/docs/MODULES.md).
`npm run check` is what CI runs; a pull request that passes it locally passes
there.

## Licence

Apache-2.0, the same as the app. See [LICENSE](LICENSE).
