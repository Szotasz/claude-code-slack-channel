// SLACKDUP1111: Slack redelivered one human message six more times, 62 to 251 s apart (2026-11-11, 16:00-16:14
// CET). Each copy fell outside the old 60 s dedup window and reached the session again. These tests pin the
// 30-minute window on the real gaps, the persisted cache across a restart, the journal fields of a delivery, and
// that the supervisor's default log stays off stdout (the MCP JSON-RPC stream).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deliveryFields,
  EVENT_DEDUP_TTL_MS,
  isDuplicateEvent,
  loadSeenEvents,
  SEEN_EVENTS_MAX,
  SEEN_EVENTS_MAX_BYTES,
  saveSeenEvents,
} from './lib.ts'

const MSG = { channel: 'C0C71PYBM6Z', ts: '1794409245.376499', thread_ts: '1794375326.617149' }
// The seven arrivals of the same message, in seconds after the first (measured in the plugin's audit journal).
const ARRIVALS_S = [0, 62, 139, 390, 454, 630, 802]

describe('the dedup window covers Slack redelivery (SLACKDUP1111)', () => {
  test('the window is at least 30 minutes', () => {
    expect(EVENT_DEDUP_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000)
  })

  test('the measured redelivery pattern: only the first of seven copies goes through', () => {
    const seen = new Map<string, number>()
    const t0 = 1_794_409_245_000
    const results = ARRIVALS_S.map(s => isDuplicateEvent({ ...MSG }, seen, t0 + s * 1000, EVENT_DEDUP_TTL_MS))
    expect(results).toEqual([false, true, true, true, true, true, true])
  })

  test('a copy 62 s and one 251 s after the previous one are both duplicates', () => {
    const seen = new Map<string, number>()
    expect(isDuplicateEvent({ ...MSG }, seen, 0, EVENT_DEDUP_TTL_MS)).toBe(false)
    expect(isDuplicateEvent({ ...MSG }, seen, 62_000, EVENT_DEDUP_TTL_MS)).toBe(true)
    expect(isDuplicateEvent({ ...MSG }, seen, 62_000 + 251_000, EVENT_DEDUP_TTL_MS)).toBe(true)
  })

  test('another message in the same thread still goes through', () => {
    const seen = new Map<string, number>()
    isDuplicateEvent({ ...MSG }, seen, 0, EVENT_DEDUP_TTL_MS)
    expect(isDuplicateEvent({ ...MSG, ts: '1794409300.000100' }, seen, 62_000, EVENT_DEDUP_TTL_MS)).toBe(false)
  })

  test('after the window the same key counts as new again', () => {
    const seen = new Map<string, number>()
    isDuplicateEvent({ ...MSG }, seen, 0, EVENT_DEDUP_TTL_MS)
    expect(isDuplicateEvent({ ...MSG }, seen, EVENT_DEDUP_TTL_MS + 1, EVENT_DEDUP_TTL_MS)).toBe(false)
  })

  test('the cache is bounded: the oldest key goes first', () => {
    const seen = new Map<string, number>()
    for (let i = 0; i < 4; i++) isDuplicateEvent({ channel: 'C1', ts: `1.${i}` }, seen, i, EVENT_DEDUP_TTL_MS, 3)
    expect([...seen.keys()]).toEqual(['C1:1.1', 'C1:1.2', 'C1:1.3'])
    expect(SEEN_EVENTS_MAX).toBeGreaterThanOrEqual(1000)
  })
})

describe('the dedup cache survives a restart (seen-events.json)', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'slackdup-')))
    file = join(dir, 'seen-events.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('save then load keeps the live keys, 0600, no temp file left', () => {
    const seen = new Map<string, number>()
    isDuplicateEvent({ ...MSG }, seen, 1000, EVENT_DEDUP_TTL_MS)
    saveSeenEvents(file, seen)
    expect(readFileSync(file, 'utf8')).not.toContain('thread')
    expect(existsSync(`${file}.tmp.${process.pid}`)).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const loaded = loadSeenEvents(file, 2000)
    expect(loaded.status).toBe('ok')
    // A redelivered copy right after a restart is still a duplicate.
    expect(isDuplicateEvent({ ...MSG }, loaded.seen, 62_000, EVENT_DEDUP_TTL_MS)).toBe(true)
  })

  test('expired rows are dropped, a far-future expiry is capped at one window, bad rows are counted', () => {
    const now = 10_000_000
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        events: [
          ['C1:1.1', now - 1],
          ['C1:1.2', now + 1000],
          ['C1:1.3', now + 10 * EVENT_DEDUP_TTL_MS],
          ['not a key', now + 1000],
          ['C1:1.4', 'soon'],
          'junk',
        ],
      }),
    )
    const loaded = loadSeenEvents(file, now)
    expect(loaded.status).toBe('ok')
    expect(loaded.expired).toBe(1)
    expect(loaded.invalid).toBe(3)
    expect(loaded.seen.get('C1:1.2')).toBe(now + 1000)
    expect(loaded.seen.get('C1:1.3')).toBe(now + EVENT_DEDUP_TTL_MS)
    expect(loaded.seen.has('C1:1.1')).toBe(false)
  })

  test('missing, symlink, bad JSON, wrong version and oversized files load as empty', () => {
    expect(loadSeenEvents(file, 0).status).toBe('missing')
    writeFileSync(join(dir, 'real.json'), JSON.stringify({ version: 1, events: [['C1:1.1', 5]] }))
    symlinkSync(join(dir, 'real.json'), file)
    expect(loadSeenEvents(file, 0)).toMatchObject({ status: 'refused', reason: 'symlink' })
    rmSync(file)
    writeFileSync(file, '{')
    expect(loadSeenEvents(file, 0)).toMatchObject({ status: 'refused', reason: 'bad_json' })
    writeFileSync(file, JSON.stringify({ version: 2, events: [] }))
    expect(loadSeenEvents(file, 0)).toMatchObject({ status: 'refused', reason: 'bad_version' })
    writeFileSync(file, 'x'.repeat(SEEN_EVENTS_MAX_BYTES + 1))
    expect(loadSeenEvents(file, 0)).toMatchObject({ status: 'refused', reason: 'too_big' })
    chmodSync(file, 0o600)
    expect(loadSeenEvents(file, 0, EVENT_DEDUP_TTL_MS, { uid: 999_999 })).toMatchObject({ status: 'refused', reason: 'foreign_owner' })
  })
})

describe('the journal gets Slack retry fields, nothing else', () => {
  test('well-formed fields pass', () => {
    expect(deliveryFields({ retryNum: 2, retryReason: 'timeout', envelopeId: 'a1b2c3d4-0000-4000-8000-0123456789ab' })).toEqual({
      retry_num: 2,
      retry_reason: 'timeout',
      envelope_id: 'a1b2c3d4-0000-4000-8000-0123456789ab',
    })
    expect(deliveryFields({})).toEqual({})
  })

  test('text, oversize and wrong types are dropped', () => {
    expect(
      deliveryFields({ retryNum: '2', retryReason: 'hello there, owner text', envelopeId: 'x'.repeat(65) }),
    ).toEqual({})
    expect(deliveryFields({ retryNum: -1, retryReason: '', envelopeId: 'a b' })).toEqual({})
    expect(deliveryFields({ retryNum: 1.5 })).toEqual({})
  })
})

describe('server.ts wiring', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')

  test('both Socket Mode listeners hand Slack retry fields to handleMessage', () => {
    const calls = src.match(/handleMessage\(event, \{\s*retryNum: retry_num,\s*retryReason: retry_reason,\s*envelopeId: envelope_id,?\s*\}\)/g) ?? []
    expect(calls.length).toBe(2)
  })

  test('a duplicate is journaled as a drop with reason duplicate, and a new key is persisted', () => {
    const i = src.indexOf('if (isDuplicateEvent(ev, seenEvents, Date.now(), EVENT_DEDUP_TTL_MS)) {')
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i, i + 600)
    expect(block).toContain("reason: 'duplicate'")
    expect(block).toContain('...deliveryFields(delivery)')
    expect(block).toMatch(/return\n\s*\}\n\s*persistSeenEvents\(\)/)
  })

  test('the cache is restored before Socket Mode connects', () => {
    const restore = src.indexOf('restoreSeenEvents()\n')
    const start = src.indexOf('await socket.start()')
    expect(restore).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(restore)
  })
})

describe('the supervisor default log is not on stdout (the MCP stream)', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'slackdup-sup-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('session.activate with the default log writes nothing to stdout and one JSON line to stderr', async () => {
    const { createSessionSupervisor } = await import('./supervisor.ts')
    const out: string[] = []
    const err: string[] = []
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((c: string | Uint8Array) => {
      out.push(String(c))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c))
      return true
    }) as typeof process.stderr.write
    try {
      const sup = createSessionSupervisor({ stateRoot: dir, clock: () => 1_700_000_000_000 })
      await sup.activate({ channel: 'C_SUP', thread: 'T1.0' }, 'U_OWNER')
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('"event":"session.activate"')
  })
})
