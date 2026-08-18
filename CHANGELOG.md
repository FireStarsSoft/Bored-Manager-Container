# Changelog

All notable changes to the Container module (called Docker before 3.0.0). Versions are independent of the app's.

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
