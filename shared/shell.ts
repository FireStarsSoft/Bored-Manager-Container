/**
 * Helpers for talking to the target machine's shell. They live in `shared/`
 * because both the app and its modules need them: a module batches its probes
 * into one command exactly like the core collectors do, and it may not import
 * from `electron/`.
 */

/**
 * The collectors batch many probes into ONE shell command per tick (cheap over
 * SSH). Sections are delimited with `===NAME===` marker lines; this splits the
 * combined output back into named sections.
 */
export function splitSections(out: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current = ''
  const lines = out.split('\n')
  const buf: string[] = []
  const flush = (): void => {
    if (current) sections.set(current, buf.join('\n'))
    buf.length = 0
  }
  for (const line of lines) {
    const m = line.match(/^===([A-Z]+)===$/)
    if (m) {
      flush()
      current = m[1]
    } else {
      buf.push(line)
    }
  }
  flush()
  return sections
}

/** Quote a string for safe interpolation into a POSIX shell command. */
export function shQuote(s: string): string {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`
}

/**
 * Block devices that carry real traffic, as they appear in /proc/diskstats.
 * Partitions, loop, dm and ram devices are excluded so the same bytes are not
 * counted twice.
 */
/**
 * A number a command printed, read with whichever decimal separator the
 * target's locale gave it.
 *
 * Every command goes out under `LC_ALL=C` (see both executors), so it should
 * be a dot - but `sudo` is free to drop that on the way to a privileged
 * command, since `env_reset` only keeps `LC_*` when the sudoers file says so.
 * A parser meeting `12,5` should read 12.5 rather than skip the row it is on,
 * which for a `ps` sweep means every row, and so no readings at all.
 *
 * Only the separator is handled: glibc's printf groups digits only when asked
 * with `%'`, and nothing here asks.
 */
export function parseDecimal(text: string): number {
  return Number(text.replace(',', '.'))
}

export const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+|hd[a-z]+)$/
