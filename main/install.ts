/**
 * Installing the runtimes this module needs, from its own settings page.
 *
 * The rest of the module can only report that Docker or Incus is missing, which
 * leaves the user copying commands into a terminal on a machine the app is
 * already connected to as root. This does that step, with the same
 * check-then-apply the create pages use: the check freezes the exact command
 * that will run and says what it will do, and the apply runs that command and
 * nothing else.
 *
 * The distro package is deliberate. Upstream convenience scripts pipe a
 * downloaded script into a root shell, which is not something this app is going
 * to do on the user's behalf - anyone who wants that can put it in the custom
 * command, where they can read it first.
 */
import { createCheckSession, hasBlockingFinding, type ModuleCheckFinding, type ModuleCheckReport } from '@shared/check'
import type { ModuleContext, ModuleStreamHandle } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { splitSections } from '@shared/shell'

export type RuntimeKind = 'docker' | 'incus'

/** Lines kept from the install output; enough to see what went wrong. */
const MAX_LINES = 500

interface Plan {
  kind: RuntimeKind
  /** Exactly what will run, as root. */
  command: string
  custom: boolean
}

export interface InstallState {
  running: boolean
  kind: RuntimeKind | null
  /** null while it runs, then whether the command exited 0. */
  ok: boolean | null
  log: string[]
}

interface Facts {
  manager: 'apt' | 'dnf' | 'pacman' | 'none'
  dockerPresent: boolean
  incusPresent: boolean
  systemd: boolean
}

const FACTS_CMD = [
  `echo '===MANAGER==='; for m in apt-get dnf pacman; do if command -v $m >/dev/null 2>&1; then echo $m; break; fi; done`,
  `echo '===DOCKER==='; if command -v docker >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo '===INCUS==='; if command -v incus >/dev/null 2>&1; then echo yes; else echo no; fi`,
  `echo '===SYSTEMD==='; if command -v systemctl >/dev/null 2>&1; then echo yes; else echo no; fi`
].join('; ')

/**
 * The package each distro family calls it. Docker on Fedora/RHEL is `moby-engine`
 * (the engine without Docker Inc's repo); Debian and Arch ship it under a name
 * of their own too, so none of this needs a third-party repository.
 */
const PACKAGES: Record<RuntimeKind, Record<'apt' | 'dnf' | 'pacman', string>> = {
  docker: { apt: 'docker.io', dnf: 'moby-engine', pacman: 'docker' },
  incus: { apt: 'incus', dnf: 'incus', pacman: 'incus' }
}

/** The service to bring up once the package is in. */
const SERVICES: Record<RuntimeKind, string> = { docker: 'docker', incus: 'incus' }

function installCommand(kind: RuntimeKind, manager: 'apt' | 'dnf' | 'pacman', systemd: boolean): string {
  const pkg = PACKAGES[kind][manager]
  const install =
    manager === 'apt'
      ? `DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg}`
      : manager === 'dnf'
        ? `dnf install -y ${pkg}`
        : `pacman -Sy --noconfirm --needed ${pkg}`
  if (!systemd) return install
  return `${install} && systemctl enable --now ${SERVICES[kind]}`
}

export class RuntimeInstaller {
  private session = createCheckSession<Plan>()
  private state: InstallState = { running: false, kind: null, ok: null, log: [] }
  private handle: ModuleStreamHandle | null = null
  /** Set by cancel(), so the exit the kill causes is not read as a verdict. */
  private cancelled = false

  constructor(private ctx: ModuleContext) {}

  /** Cancels a running install; called from dispose() and on disconnect. */
  reset(): void {
    this.session.clear()
    this.cancelled = true
    this.kill()
    this.state = { running: false, kind: null, ok: null, log: [] }
  }

  status(): InstallState {
    return { ...this.state, log: [...this.state.log] }
  }

  /**
   * Re-send the output so far, for a page that was opened after the install
   * started: a `log` block starts empty and only shows what arrives while it is
   * mounted.
   */
  logTail(): OkResult {
    if (this.state.log.length) this.ctx.emit('installlog', this.state.log.join('\n'))
    return { ok: true }
  }

  async check(kind: RuntimeKind, input: unknown): Promise<ModuleCheckReport> {
    const values = (input as Record<string, unknown>) ?? {}
    const mode = String(values['mode'] ?? 'default')
    const typed = String(values['command'] ?? '').trim()
    const findings: ModuleCheckFinding[] = []

    if (this.state.running) {
      findings.push({
        level: 'error',
        label: 'An install is already running',
        detail: 'Wait for it to finish, or cancel it, before starting another.'
      })
      return { ok: false, findings }
    }
    if (!this.ctx.connected) {
      return { ok: false, findings: [{ level: 'error', label: 'No machine is connected' }] }
    }

    const facts = await this.readFacts()
    // Installing a package is root's work, and this module never elevates
    // anything else - so say so here rather than failing halfway through apt.
    if (!this.ctx.hasSudo) {
      findings.push({
        level: 'error',
        label: 'This needs root on the target machine',
        detail: 'Connect as root, or with a sudo password, and check again.'
      })
    }

    const already = kind === 'docker' ? facts.dockerPresent : facts.incusPresent
    if (already) {
      findings.push({
        level: 'warning',
        label: `${label(kind)} is already installed`,
        detail:
          kind === 'docker'
            ? 'If the dashboard still says it is unavailable, the daemon is not running or your user is not in the docker group - installing it again will not change that.'
            : 'If the dashboard still says it is unavailable, the daemon is not initialised yet (incus admin init).'
      })
    }

    let command = ''
    if (mode === 'custom') {
      if (!typed) {
        findings.push({ level: 'error', label: 'The custom command is empty' })
      } else if (/\n/.test(typed)) {
        findings.push({
          level: 'error',
          label: 'The custom command has to be a single line',
          detail: 'Join the steps with && so one failure stops the rest.'
        })
      } else {
        command = typed
        findings.push({
          level: 'warning',
          label: 'This command is run as root, exactly as typed',
          detail: 'Nothing in it is checked or escaped by the app.'
        })
      }
    } else if (facts.manager === 'none') {
      findings.push({
        level: 'error',
        label: 'No supported package manager was found',
        detail:
          'apt-get, dnf and pacman are the ones this can drive. Use Custom command with whatever this distro uses.'
      })
    } else {
      command = installCommand(kind, facts.manager, facts.systemd)
      if (!facts.systemd) {
        findings.push({
          level: 'info',
          label: 'No systemctl on this machine',
          detail: 'The package is installed but the service is not started - do that with whatever this distro uses.'
        })
      }
    }

    if (command) {
      findings.push({
        level: 'pass',
        label: `Will run as root: ${command}`,
        detail: `Output appears below while it runs. ${
          kind === 'docker'
            ? 'Afterwards, add your user to the docker group (or connect as root) for the dashboard to see it.'
            : 'Afterwards, run `incus admin init` once to choose storage and networking.'
        }`
      })
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }
    return { ok: true, token: this.session.issue(input, { kind, command, custom: mode === 'custom' }), findings }
  }

  /**
   * Starts the install and returns straight away: apt over SSH takes minutes,
   * and the page follows the `install` stream rather than one long RPC call.
   */
  async apply(payload: unknown): Promise<OkResult> {
    const p = payload as { token?: unknown; values?: unknown } | null
    const token = typeof p?.token === 'string' ? p.token : ''
    const taken = this.session.take(token, p?.values)
    if (!taken) return { ok: false, error: 'that check has expired or the form changed - check again' }
    if (this.state.running) return { ok: false, error: 'an install is already running' }
    const plan = taken.payload
    if (!plan.command) return { ok: false, error: 'nothing to run - check again' }

    this.cancelled = false
    this.state = { running: true, kind: plan.kind, ok: null, log: [] }
    this.push(`# ${plan.command}`)
    try {
      const handle = await this.ctx.streamSudo(`${plan.command} 2>&1`)
      this.handle = handle
      handle.onData((data) => this.push(data))
      handle.onExit((code) => {
        this.handle = null
        // Killing the command is itself an exit, and its code says nothing
        // about the install - cancel() has already had the last word.
        if (this.cancelled) return
        this.state.running = false
        this.state.ok = code === 0
        this.push(code === 0 ? `# done` : `# exited with code ${code ?? 'unknown'}`)
        this.ctx.log(`${plan.kind} install ${code === 0 ? 'succeeded' : `failed (code ${code})`}`)
      })
      this.emit()
      return { ok: true }
    } catch (err) {
      this.state = { running: false, kind: plan.kind, ok: false, log: [...this.state.log, String(err)] }
      this.emit()
      return { ok: false, error: String(err) }
    }
  }

  cancel(): OkResult {
    if (!this.state.running) return { ok: false, error: 'nothing is running' }
    this.cancelled = true
    this.kill()
    this.state.running = false
    this.state.ok = false
    this.push('# cancelled')
    return { ok: true }
  }

  private kill(): void {
    const handle = this.handle
    this.handle = null
    if (!handle) return
    try {
      handle.kill()
    } catch {
      /* the command may have ended on its own already */
    }
  }

  private async readFacts(): Promise<Facts> {
    const res = await this.ctx.exec(FACTS_CMD, { timeoutMs: 30000 })
    const s = splitSections(res.stdout)
    const manager = (s.get('MANAGER') ?? '').trim()
    return {
      manager: manager === 'apt-get' ? 'apt' : manager === 'dnf' ? 'dnf' : manager === 'pacman' ? 'pacman' : 'none',
      dockerPresent: (s.get('DOCKER') ?? '').trim() === 'yes',
      incusPresent: (s.get('INCUS') ?? '').trim() === 'yes',
      systemd: (s.get('SYSTEMD') ?? '').trim() === 'yes'
    }
  }

  private push(text: string): void {
    if (!text.trim()) return
    // A chunk usually ends in a newline, which would otherwise leave a blank
    // line in the buffer for every chunk that arrived.
    for (const line of text.replace(/\n+$/, '').split('\n')) this.state.log.push(line)
    if (this.state.log.length > MAX_LINES) {
      this.state.log.splice(0, this.state.log.length - MAX_LINES)
    }
    // The page tails this as a log block, so lines are pushed as they arrive as
    // well as kept for a page that is opened later.
    this.ctx.emit('installlog', text)
    this.emit()
  }

  private emit(): void {
    this.ctx.emit('install', this.status())
  }
}

function label(kind: RuntimeKind): string {
  return kind === 'docker' ? 'Docker' : 'Incus'
}
