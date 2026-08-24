/**
 * `ss -Htunapi` parsing, shared by the Network detail collector and the
 * Overview top-consumers collector. The `-i` flag is what makes per-socket
 * accounting possible: bytes_acked / bytes_received are kernel counters, so
 * diffing them between ticks yields per-connection and per-process rates
 * without installing anything on the target.
 */
export const SS_CMD = `ss -Htunapi 2>/dev/null || true`

export const MAX_CONNECTIONS = 2000

export interface SsRecord {
  proto: string
  state: string
  local: string
  peer: string
  pid: number | null
  process: string
  bytesAcked: number | null
  bytesReceived: number | null
}

/** Fold ss's wrapped continuation lines (tcp info) back into one record each. */
export function parseSs(text: string): SsRecord[] {
  const records: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (/^(tcp|udp)\s/.test(line)) records.push(line)
    else if (records.length) records[records.length - 1] += ' ' + line.trim()
  }
  const out: SsRecord[] = []
  for (const rec of records.slice(0, MAX_CONNECTIONS * 2)) {
    const f = rec.trim().split(/\s+/)
    if (f.length < 6) continue
    const users = rec.match(/users:\(\("([^"]*)",pid=(\d+)/)
    const acked = rec.match(/bytes_acked:(\d+)/)
    const recv = rec.match(/bytes_received:(\d+)/)
    out.push({
      proto: f[0],
      state: f[1],
      local: f[4],
      peer: f[5],
      pid: users ? parseInt(users[2], 10) : null,
      process: users ? users[1] : '',
      bytesAcked: acked ? parseInt(acked[1], 10) : null,
      bytesReceived: recv ? parseInt(recv[1], 10) : null
    })
  }
  return out
}

export function splitAddr(s: string): { addr: string; port: number; v6: boolean } {
  const i = s.lastIndexOf(':')
  if (i < 0) return { addr: s, port: 0, v6: false }
  let addr = s.slice(0, i)
  const portStr = s.slice(i + 1)
  const v6 = addr.includes(':') || addr.startsWith('[')
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  return { addr, port: portStr === '*' ? 0 : parseInt(portStr, 10) || 0, v6 }
}

/** Identifies one socket across ticks, for diffing its byte counters. */
export function socketKey(r: SsRecord): string {
  return `${r.proto}|${r.local}|${r.peer}`
}
