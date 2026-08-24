import { describe, expect, it } from 'vitest'
import {
  generatedNames,
  matchesPattern,
  parseCidr,
  parseEnvLines,
  parseIpRange,
  parseMemory,
  parsePorts,
  portsForIndex,
  usableAddresses
} from '../../container/main/parse'

describe('parseEnvLines', () => {
  it('keeps KEY=VALUE, skips comments, and records bad lines 1-based', () => {
    const parsed = parseEnvLines(['FOO=bar', '# comment', '1BAD=x', '=novalue', '', 'OK=1'].join('\n'))
    expect(parsed.entries).toEqual(['FOO=bar', 'OK=1'])
    expect(parsed.badLines).toEqual([3, 4])
  })
})

describe('parsePorts', () => {
  it('accepts a range and a single mapping', () => {
    const parsed = parsePorts('8080-8082:80/tcp, 9000:9000')
    expect(parsed.errors).toEqual([])
    expect(parsed.mappings).toEqual([
      { hostStart: 8080, hostEnd: 8082, containerPort: 80, proto: 'tcp', single: false },
      { hostStart: 9000, hostEnd: 9000, containerPort: 9000, proto: 'tcp', single: true }
    ])
  })

  it('reports overlapping same-proto hosts, out-of-range ports and a reversed range', () => {
    expect(parsePorts('80:80, 80:81').errors[0]).toMatch(/overlap/)
    expect(parsePorts('0:80').errors[0]).toMatch(/outside 1-65535/)
    expect(parsePorts('8082-8080:80').errors[0]).toMatch(/ends before it starts/)
    expect(parsePorts('80:80/udp, 80:80/tcp').errors).toEqual([])
  })

  it('offsets the host port by the container index', () => {
    expect(portsForIndex([{ hostStart: 8080, hostEnd: 8082, containerPort: 80, proto: 'tcp', single: false }], 2)).toEqual([
      { host: 8082, container: 80, proto: 'tcp' }
    ])
  })
})

describe('CIDR / IP range', () => {
  it('masks 10.0.0.5/24 to the network and counts usable hosts', () => {
    const cidr = parseCidr('10.0.0.5/24')
    expect(cidr).not.toBeNull()
    expect(cidr!.network).toBe(10 * 256 ** 3)
    expect(usableAddresses(cidr!)).toBe(254)
    expect(usableAddresses(parseCidr('10.0.0.1/31')!)).toBe(0)
    expect(usableAddresses(parseCidr('10.0.0.1/32')!)).toBe(0)
  })

  it('parses CIDR, a reversed range and a single address', () => {
    const slash = parseIpRange('10.0.0.0/30')
    expect(slash).toEqual({ first: (10 << 24) + 1, last: (10 << 24) + 2, count: 2 })
    expect(parseIpRange('10.0.0.5-10.0.0.3')).toBeNull()
    expect(parseIpRange('10.0.0.9')?.count).toBe(1)
  })
})

describe('memory and names', () => {
  it('parses binary memory suffixes and rejects an unknown unit', () => {
    expect(parseMemory('512m')).toBe(512 * 1024 ** 2)
    expect(parseMemory('1GiB')).toBe(1024 ** 3)
    expect(parseMemory('12tbx')).toBeNull()
  })

  it('numbers generated names with three digits', () => {
    expect(generatedNames('web-', 2)).toEqual(['web-001', 'web-002'])
  })

  it('treats a pattern without * as a substring and one with * as an anchored glob', () => {
    expect(matchesPattern('MyWeb', 'web')).toBe(true)
    expect(matchesPattern('MyWeb', 'web-*')).toBe(false)
    expect(matchesPattern('web-001', 'web-*')).toBe(true)
  })
})
