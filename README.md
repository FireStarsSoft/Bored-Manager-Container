# Container

Docker and Incus on the target machine, side by side: what is running, what it costs, and the bulk operations that would otherwise be a shell loop — each one behind a check step that says what would happen before it happens.

## What it adds

| Where | What |
|---|---|
| Sidebar | **Dashboard** — Docker and Incus counts, history charts, disk usage, recent jobs |
| Sidebar | **Docker** — the containers table (status, healthcheck, CPU and memory, network ↓/↑, block read/write, PIDs, ports, tags), a per-container detail panel, tick-and-act bulk operations |
| Sidebar | **Images & storage** — images, volumes, networks and what a prune would reclaim |
| Sidebar | **Logs** — `docker logs -f` for any container |
| Sidebar | **Incus** — instances (containers and VMs) with the same table, plus images, profiles, networks and storage pools |
| Sidebar | **Fleet operations** — jobs, tags, bulk create for both engines, bulk actions by criteria, and creating an ipvlan/macvlan network |
| Sidebar | **Module settings** — the rules every check measures against, and saved templates |
| Overview | **Containers** widget (on by default) and **Container resources** (off by default) |
| History | writes the `container` metrics stream (Docker running, Σ CPU, Σ memory, Incus running) |

## Check, then confirm

Nothing on the Fleet page runs when you press a button. Every form has a **Check** step that reads the machine and answers a report: what is fine (pass), what will happen anyway (info), what is worth reading twice (warning) and what stops it (error). Only a report with no errors unlocks **Confirm and apply**, and editing any field throws the report away — so what runs is always what you read the report for.

The check hands out a token that lasts ten minutes, is good for one use, and is bound to the exact values that were checked. Where a check resolved a list — "every container tagged `web`" — that list is frozen into the token, so a container that appeared in the meantime is not swept up in something you did not agree to.

### What the Docker create check looks at

Docker reachable · count within the module's limit · **whether Incus would be the better tool for this many containers** · name collisions · whether the image is here or has to be pulled · `KEY=VALUE` parsing · port ranges wide enough, not overlapping, and not already bound on the host · the network exists, is or is not L2-isolated, and has enough free addresses · memory against `MemAvailable` · the neighbour table against `gc_thresh3` when the network is L2 · script size · daemon permissions.

The Incus check is the same shape: incus installed, count, name collisions, image locally present, profile/network/pool exist, user name and password rules, memory, KVM for a VM, and the same neighbour advisory.

## Tags

A tag is a name, a colour and a description; a container can wear any number of them. They are stored per target machine on the app's own disk (`data/module-data/container/<host>.json`) rather than on the machine, so they need nothing writable there — but a container created with a tag also gets a `bored-manager.tags` label (Docker) or `user.bored-manager.tags` config key (Incus), so the grouping is visible to anything reading the machine directly.

Leaving the colour on **Auto** picks the least-used colour in the palette, so a machine with five tags gets five distinguishable ones. A tag named in a bulk action that does not exist yet is created on the spot.

## Jobs

Anything that touches more than one container becomes a job: a list of items run one at a time or a few at once, that can be cancelled between items, that reports per-item errors, and that survives on the Fleet page after it finishes. The last 50 jobs are kept per machine.

## What it runs on the target

Fast tick, one roundtrip for both engines:

```sh
docker ps -a --format '{{json .}}'
docker stats --no-stream --format '{{json .}}'
incus list --format json          # only if the incus CLI is installed
```

Slow tick: `docker system df`, falling back to counting images/volumes/containers.

On demand: `docker images|volume ls|network ls`, `docker inspect`, `docker logs -f`, `incus image|profile|network|storage list`, and one command per action. Jobs run `docker create` + `docker start` or `incus launch`, then `incus exec` for provisioning. Every id, name and reference is checked against a strict pattern and shell-quoted before it reaches a command line; an Incus password goes to `chpasswd` on stdin and never into an argv.

## Settings it reads

| Setting | Effect |
|---|---|
| Update intervals → **Container** (fast) | how often containers, instances and their stats are read |
| Update intervals → **Container** (slow) | how often disk usage is read; `Manual only` reads it once and then only on request |
| Overview → **Containers**, **Container resources** | which widgets are shown |
| Data & storage | whether the `container` history stream is written, and for how long |

The module's own rules — largest create job, when to suggest Incus, parallelism, memory headroom, minimum password length, per-item timeout — live on its **Module settings** page. A rule left empty there uses the default; anything set overrides it.

## When it shows nothing

No Docker daemon, or the connecting user is not in the `docker` group: the Docker sections say so and point at the fix. Incus missing is not an error — its page and stats simply say it is not installed. Note that the GPU module's auto power cap watches `docker ps` itself and does not need this module.

## Files

```
main/index.ts          activate(): the pollers, and one handler per method
main/service.ts        the Docker probes, parsers, inspect, actions, log streaming
main/incus.ts          the incus CLI: listings, inspect, per-instance actions
main/probe.ts          what a check needs to know about the machine, batched
main/parse.ts          env, ports, CIDR and memory parsing - pure, and testable
main/store.ts          the per-host document: tags, memberships, templates, jobs
main/tags.ts           tags and who wears them
main/jobs.ts           the job runner: pooling, cancellation, timeouts, progress
main/create-docker.ts  the Docker create check and its job
main/create-incus.ts   the Incus create check, its job and the provisioning
main/bulk.ts           acting on a selection, or on everything matching a rule
main/networks.ts       creating an ipvlan/macvlan/bridge network
main/options.ts        what the select fields offer; saved templates
main/rules.ts          the limits every check measures against
main/rules-editor.ts   reading and changing those limits
```
