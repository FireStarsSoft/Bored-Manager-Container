import type { ModuleActivate } from '@shared/modules'
import { ContainerService, dockerRef, incusRef } from './service'
import { IncusCli, type IncusAction } from './incus'
import { HostStore } from './store'
import { TagStore, type RefSource } from './tags'
import { FleetJobs } from './jobs'
import { DockerCreator } from './create-docker'
import { IncusCreator } from './create-incus'
import { BulkRunner, type LiveContainers } from './bulk'
import { NetworkCreator } from './networks'
import { OptionSource, deleteTemplate, listTemplates } from './options'
import { RulesEditor } from './rules-editor'
import { RuntimeInstaller, type RuntimeKind } from './install'

/** The slow section this module owns, as named in settings.slowRefresh. */
const STORAGE_TARGET = 'container'

type ContainerAction = 'start' | 'stop' | 'restart' | 'rm' | 'kill' | 'pause' | 'unpause'

/**
 * Main-process half of the Container module. One fast poller covers Docker and
 * Incus in a single round trip, a slow one covers `docker system df`, and there
 * is one handler per action the pages offer. Listings and inspect are pulled on
 * demand, never polled.
 */
const activate: ModuleActivate = (ctx) => {
  const service = new ContainerService(ctx)
  const incus = new IncusCli(ctx)
  const hostStore = new HostStore(ctx)

  /**
   * Tags read the last tick rather than asking the machine again: they are
   * attached from a table the user is looking at, so the listing behind that
   * table is the right one to resolve against.
   */
  const refs: RefSource = {
    dockerAll: () => (service.history.at(-1)?.containers ?? []).map((c) => dockerRef(c.id)),
    dockerRunning: () =>
      (service.history.at(-1)?.containers ?? [])
        .filter((c) => c.state === 'running')
        .map((c) => dockerRef(c.id)),
    incusAll: () => (service.incusLatest?.instances ?? []).map((i) => incusRef(i.name)),
    describe: (ref) => {
      if (ref.startsWith('docker:')) {
        const id = ref.slice('docker:'.length)
        const found = service.history.at(-1)?.containers.find((c) => c.id === id)
        return found ? { name: found.name, status: found.status } : null
      }
      if (ref.startsWith('incus:')) {
        const name = ref.slice('incus:'.length)
        const found = service.incusLatest?.instances.find((i) => i.name === name)
        return found ? { name: found.name, status: found.status } : null
      }
      return null
    }
  }

  const tags = new TagStore(hostStore, refs, (message) => ctx.log(message))
  service.tags = tags

  const live: LiveContainers = {
    docker: () => service.history.at(-1)?.containers ?? [],
    incus: () => service.incusLatest?.instances ?? []
  }

  const jobs = new FleetJobs(ctx, hostStore)
  const dockerCreator = new DockerCreator(ctx, hostStore, jobs, tags)
  const incusCreator = new IncusCreator(ctx, incus, hostStore, jobs, tags)
  const bulk = new BulkRunner(ctx, incus, jobs, live, (ref) =>
    tags.badgesFor(ref).map((b) => b.label)
  )
  const networkCreator = new NetworkCreator(ctx)
  const options = new OptionSource(ctx, incus, hostStore)
  const rulesEditor = new RulesEditor(ctx)
  const installer = new RuntimeInstaller(ctx)

  ctx.handle('images', () => service.listImages())
  ctx.handle('volumes', () => service.listVolumes())
  ctx.handle('networks', () => service.listNetworks())
  ctx.handle('inspect', (id: string) => service.inspect(id))
  ctx.handle('containerAction', (id: string, action: ContainerAction) =>
    service.containerAction(id, action)
  )
  ctx.handle('removeImage', (id: string, force: boolean) => service.removeImage(id, force))
  ctx.handle('pruneImages', (all: boolean) => service.pruneImages(all))
  ctx.handle('removeVolume', (name: string) => service.removeVolume(name))
  ctx.handle('pruneVolumes', () => service.pruneVolumes())
  ctx.handle('removeNetwork', (id: string) => service.removeNetwork(id))
  ctx.handle('pruneNetworks', () => service.pruneNetworks())
  ctx.handle('logsStart', (id: string) => service.startLogs(id))
  ctx.handle('logsStop', (id: string) => service.stopLogs(id))

  ctx.handle('incusAction', (name: string, action: IncusAction) => incus.action(name, action))
  ctx.handle('incusInspect', (name: string) => incus.inspect(name))
  ctx.handle('incusImages', () => incus.images())
  ctx.handle('incusProfiles', () => incus.profiles())
  ctx.handle('incusNetworks', () => incus.networks())
  ctx.handle('incusPools', () => incus.pools())

  ctx.handle('tags', () => tags.list())
  ctx.handle('tagMembers', (id: string) => tags.members(id))
  // One pair serves both the "create tag" form and the edit form in a tag's
  // own drawer; the drawer passes its id through `argsFromScope`, so an extra
  // leading argument is what tells the two apart.
  ctx.handle('tagCheck', (...args: unknown[]) =>
    args.length >= 2 ? tags.check(String(args[0]), args[1]) : tags.check(null, args[0])
  )
  ctx.handle('tagApply', (...args: unknown[]) =>
    args.length >= 2 ? tags.apply(String(args[0]), args[1]) : tags.apply(null, args[0])
  )
  ctx.handle('tagDelete', (id: string) => tags.remove(id))
  ctx.handle('tagsPrune', () => tags.prune())
  ctx.handle('bulkTag', (keys: string[], engine: string, mode: string, tagName: string) =>
    tags.bulk(keys, engine, mode, tagName)
  )

  ctx.handle('jobs', () => jobs.snapshot())
  ctx.handle('jobCancel', (id: string) => jobs.cancel(id))
  ctx.handle('jobsClear', () => jobs.clearFinished())
  ctx.handle('bulkContainerAction', (keys: string[], action: string) =>
    bulk.dockerSelection(keys, action)
  )
  ctx.handle('bulkIncusAction', (keys: string[], action: string) => bulk.incusSelection(keys, action))
  ctx.handle('bulkActionCheck', (values: unknown) => bulk.check(values))
  ctx.handle('bulkActionApply', (payload: unknown) => bulk.apply(payload))

  ctx.handle('selectOptions', (kind: string) => options.list(kind))
  ctx.handle('templates', () => listTemplates(hostStore))
  ctx.handle('templateDelete', (id: string) => deleteTemplate(hostStore, id))

  ctx.handle('createDockerCheck', (values: unknown) => dockerCreator.check(values))
  ctx.handle('createDockerApply', (payload: unknown) => dockerCreator.apply(payload))
  ctx.handle('createIncusCheck', (values: unknown) => incusCreator.check(values))
  ctx.handle('createIncusApply', (payload: unknown) => incusCreator.apply(payload))
  ctx.handle('networkCreateCheck', (values: unknown) => networkCreator.check(values))
  ctx.handle('networkCreateApply', (payload: unknown) => networkCreator.apply(payload))

  ctx.handle('rulesEffective', () => rulesEditor.effective())
  ctx.handle('rulesCheck', (values: unknown) => rulesEditor.check(values))
  ctx.handle('rulesApply', (payload: unknown) => rulesEditor.apply(payload))
  ctx.handle('rulesReset', () => rulesEditor.reset())

  // A pair per runtime, like the create pages: a `checkForm` on a settings page
  // has no row to carry which one it means, and the apply reads the runtime off
  // the plan its check froze.
  const install = (kind: RuntimeKind) => (values: unknown) => installer.check(kind, values)
  ctx.handle('installDockerCheck', install('docker'))
  ctx.handle('installDockerApply', (payload: unknown) => installer.apply(payload))
  ctx.handle('installIncusCheck', install('incus'))
  ctx.handle('installIncusApply', (payload: unknown) => installer.apply(payload))
  ctx.handle('installLogTail', () => installer.logTail())
  ctx.handle('installCancel', () => installer.cancel())

  /** See the same guard in the Disk module: df must not re-run on every change. */
  let appliedSlow: string | null = null

  return {
    applyPollers() {
      const fast = ctx.fastIntervalMs('container')
      if (ctx.connected && fast > 0) service.poller.start(fast)
      else service.poller.stop()

      const slowSec = Math.max(0, ctx.slowIntervalSec(STORAGE_TARGET))
      const key = `${ctx.connected}|${slowSec}`
      if (key === appliedSlow) return
      appliedSlow = key
      service.slowPoller.stop()
      if (!ctx.connected) return
      if (slowSec > 0) service.slowPoller.start(slowSec * 1000)
      else if (!service.slowLatest) void service.refreshSlowNow()
    },
    reset() {
      appliedSlow = null
      service.reset()
      // A running job's commands were going to the machine that just went away,
      // and the next one has its own tags and job history.
      jobs.reset()
      hostStore.reset()
      installer.reset()
    },
    snapshots() {
      // `snapshot`/`incus`/`jobs` are 'latest' (the current listing), `series`
      // is 'series' (the last 5 minutes of it) - see the comment in service.ts.
      return {
        snapshot: service.history.at(-1) ?? null,
        incus: service.incusLatest,
        series: service.seriesHistory,
        storage: service.slowLatest,
        jobs: jobs.snapshot(),
        install: installer.status()
      }
    },
    slowTargets() {
      return [STORAGE_TARGET]
    },
    async refreshSlow() {
      await service.refreshSlowNow()
    },
    dispose() {
      service.dispose()
      jobs.dispose()
      installer.reset()
    }
  }
}

export default activate
