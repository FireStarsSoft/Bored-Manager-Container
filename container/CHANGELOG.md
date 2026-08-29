# Changelog

All notable changes to the Container module (called Docker before 3.0.0). Versions are independent of the app's.

## 3.1.14

- **Declares the storage it uses.** Bored Manager 0.5.0 lets a module say in its
  manifest what it needs kept for it, and grants that rather than applying one
  fixed cap to everything. This module asks for what it already used: the same
  512 KB for its settings and for what it remembers per machine.
  It writes one history stream of its own (`container`) and is granted 32 MB of the
  metrics store for it.
- **Nothing else changed**, and nothing about it needs a newer app. `minAppVersion`
  is untouched: an app that has never heard of a `storage` block ignores it, so
  this release installs on 0.4.3 exactly as the previous one did. On 0.5.0 and
  later it also shows up in Settings → Data & storage with its own figures.

## 3.1.13

- **The module now lives in its own repository** and is installed rather than
  shipped: [FireStarsSoft/Bored-Manager-Container](https://github.com/FireStarsSoft/Bored-Manager-Container).
  Bored Manager 0.4.2 is the first release that does not bundle it - get it from
  Settings → Modules (the official list, `FireStarsSoft/Bored-Manager-Container`, or the
  release zip). An install that already has 3.1.12 keeps working untouched
  across the app update, and updating to 3.1.13 keeps its tags, rules, saved hosts and history:
  nothing about the module's behaviour, manifest ids or stored shapes changed
  here.
- README: an Installing section, since the module is no longer in the app
  download, and a link back to the repository.
- `minAppVersion` corrected to **0.4.0**. The manifest said `0.2.0`, but the
  rules editor calls `ctx.onConfigChange`, which the app only provides from
  0.4.0, and `@shared/cache` only exists from 0.3.3. On anything older the
  install passed the version gate and then threw during activation.

## 3.1.12

- Removed the dead `jobs` method. The Fleet pages read the `jobs` stream, and
  a surface opened mid-run is seeded from `snapshots()` - nothing ever called
  the method, so it was unreachable surface.

## 3.1.11

- Removed two pieces of code nothing could reach: a `docker system prune`
  helper no page or manifest method called, and a helper that worked out which
  rules had been overridden for a column the rules editor does not render.

## 3.1.10

- **Fixed: a bulk action by tag, state, name or image reported "Nothing
  matches that" whenever the container interval was paused or the page had
  not been open long enough to poll.** The check now takes one listing of its
  own when the last one is missing or older than two intervals, and says in
  its findings how old the list it froze is.
- Performance: installing Docker or Incus from the settings page re-sent the
  whole install state - up to 500 buffered output lines - to every connected
  browser on every chunk of output. The output already has its own stream; the
  state is now sent when it changes (start, finish, cancel) and carries only
  the three fields the page reads.

## 3.1.9

- Fixed: the Images & storage and Incus pages exec'd `docker images`, `docker volume ls`, `docker network ls` and the four `incus ... list` commands every fast tick (2 s by default) while their page was open, on top of the module's own collector - 4-5x the rate the README and the module's own comments describe ("pulled on demand, never polled"). Those seven listings now load once when their page becomes visible; a row action already refetches its own table afterwards.
- Fixed: the "Rules in force" panel on Module settings re-read module-config.json on the same fast tick for a value that only changes when Save/Reset is pressed. It is now pushed the moment the rules change (by this browser or another one already open on a different connected machine) instead of polled.

## 3.1.8

- **Fixed: a container's Created/Started/Finished times in its inspect panel
  were rendered in the server's own locale/timezone, not the viewer's.** They
  read in the viewer's own locale now.

## 3.1.7

- **Fixed: every "Disk usage" section's refresh button (Dashboard, Docker,
  Images, and the Container resources widget) always showed "never" for its
  age**, even right after the storage snapshot had just refreshed - the
  sections had a refresh control but nothing feeding it a timestamp. They now
  resolve the age from the storage stream's own `t`.

## 3.1.6

- **Fixed: the two "History" charts on Dashboard (Running containers; Docker
  CPU and memory) were empty at every chart window under 30 minutes**, and
  even above that only ever showed archived data with no movement between
  refetches. They now show data at any window and keep moving, by tying to
  the module's own live `series` stream.

## 3.1.5

- **The Containers card's sparkline plots running containers**, which is what
  the number above it counts. It was plotting CPU.

## 3.1.4

- **Fixed: a Fleet job still running when the module stopped could take the
  server down.** Disabling or reloading the module - or the machine
  disconnecting - while a bulk action or a create job was mid `docker pull`
  left that job to finish against a context the app had already revoked. Its
  progress push, its log line, the tag it attaches on completion and the
  poll that waits for it all threw from a promise nobody was holding, which
  ended the whole server process and with it every other machine, terminal
  and browser. Everything a job does after an await now stops when the module
  has stopped.

## 3.1.3

- Adds an opt-in “while page/card is visible” mode for the fast Docker/Incus metrics poller. The default remains Always, and the slow storage inventory continues independently.

## 3.1.2

- Coalesces duplicate Docker inspect and Docker/Incus inventory reads from one visible page, while actions still run immediately and invalidate cached reads.

## 3.1.1

- Container and Incus row actions refuse an unknown verb before a command is built, so a bad RPC argument cannot reach the shell.

## 3.1.0

- **Install a missing runtime** from Module settings. It only appears while that runtime is unavailable, and goes through the usual check step: the check names the package manager it found (apt-get, dnf or pacman), refuses without root, and prints the exact command it will run; the apply runs that command and streams its output onto the page. Distro packages only (`docker.io` / `moby-engine` / `docker`, and `incus`) - no third-party repository, and nothing downloaded into a root shell. A custom command box covers everything else.
- Pages that were showing an empty card with the fix written in its title now say what is wrong in the card, and say where to install it.
- The Docker create check no longer claims "Docker will be tried with sudo" when the daemon is unreachable. Nothing here is elevated, so it says what actually helps: the connected user in the `docker` group, or a connection as root.

## 3.0.0

- Renamed from `docker` to `container`: Incus sits next to Docker now, and the module covers both. An existing install keeps its enabled state, its Overview widget positions and its update intervals — the settings file migrates `refresh.docker` to `refresh.container` and `docker.summary`/`docker.resources` to `container.*`. The `docker` metrics stream is not converted; the new `container` stream starts empty and the old files expire on their own retention.
- **Incus**: instances (system containers and virtual machines) probed in the same roundtrip as Docker, with their own page, per-instance actions, exec shell, and listings for images, profiles, networks and storage pools.
- **Tags**: a name, a colour and a description, any number per container, stored per target machine. Tag columns on both tables, filter by tag, and add or remove one across a selection.
- **Fleet operations**: bulk create for Docker and Incus, bulk actions on a selection or on everything matching a tag/state/name/image, and creating an ipvlan, macvlan or bridge network — each behind a check step that reads the machine and reports what would happen before it unlocks apply.
- **Jobs**: anything touching more than one container runs as a cancellable job with per-item progress and errors, sequential or a few at a time. The last 50 are kept per machine.
- Creating ten or more Docker containers at once now says so and suggests Incus for that shape of work, without blocking it.
- Creating containers on an ipvlan or macvlan network warns that the host cannot reach them directly, and checks the projected neighbour table against `gc_thresh3` — pointing at Network → Host tuning when it would not fit.
- **Module settings**: the limits every check measures against (largest job, Incus threshold, parallelism, memory headroom, minimum password length, per-item timeout) can be overridden per install; an empty field means the default.
- Saved templates for both create forms, minus the fields that make no sense to reuse. An Incus template never stores the password.

## 2.0.0

- Moved to API v2: the UI is declared in `ui/pages/*.json` (Containers, Images & storage, Logs) and `ui/widgets/*.json`. The app renders the pages; this module no longer ships React. Install, update and reload no longer rebuild or restart the app.

## 1.0.0

- First version as a Bored Manager module. The page, the detail panel, the actions and the log streaming are unchanged.
- Log streams are now released by the module's own dispose step, which the app calls when the module is disabled as well as on a clean close - so switching the module off also stops any `docker logs -f` still running on the target.
- The two Overview widgets are enabled through Settings → Overview, and the whole module can be disabled or uninstalled in Settings → Modules.
