/**
 * gate.inbound.drop carries WHY the gate dropped an event.
 *
 * Measured 2026-11-24 (Marveen dashboard, plugin 0.2.6): a drop was journaled as
 * {"kind":"gate.inbound.drop","outcome":"drop","actor":...,"input":{"channel","user"}}
 * with no reason, so a watcher that turns "someone @-mentioned the bot in a channel
 * it does not read" into a channel opt-in request had nothing to match on, and the
 * request list stayed empty while the bot ignored the mention.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Access, defaultAccess, type GateOptions, gate } from './lib.ts'

function makeOpts(access: Partial<Access> = {}): GateOptions {
  return {
    access: { ...defaultAccess(), ...access },
    staticMode: false,
    saveAccess: () => {},
    botUserId: 'U_BOT',
    selfBotId: 'B_BOT',
    selfAppId: 'A_BOT',
  }
}

const channelPolicy = { requireMention: true, allowFrom: [] as string[] }

describe('gate drop reasons', () => {
  test('a channel that is not opted in: channel-not-allowed, with the mention flag', async () => {
    const tagged = await gate(
      { user: 'U_ALICE', channel: 'C_NEW', channel_type: 'channel', text: '<@U_BOT> hello', ts: '1.1' },
      makeOpts(),
    )
    expect(tagged).toEqual({ action: 'drop', reason: 'channel-not-allowed', botMentioned: true })

    const untagged = await gate(
      { user: 'U_ALICE', channel: 'C_NEW', channel_type: 'channel', text: 'hello', ts: '1.2' },
      makeOpts(),
    )
    expect(untagged).toEqual({ action: 'drop', reason: 'channel-not-allowed', botMentioned: false })
  })

  test('an opted-in channel: sender-not-allowed and mention-required', async () => {
    const notListed = await gate(
      { user: 'U_EVE', channel: 'C1', channel_type: 'channel', text: '<@U_BOT> hi', ts: '1.3' },
      makeOpts({ channels: { C1: { ...channelPolicy, allowFrom: ['U_ALICE'] } } }),
    )
    expect(notListed.reason).toBe('sender-not-allowed')
    expect(notListed.botMentioned).toBe(true)

    const noMention = await gate(
      { user: 'U_ALICE', channel: 'C1', channel_type: 'channel', text: 'hi', ts: '1.4' },
      makeOpts({ channels: { C1: channelPolicy } }),
    )
    expect(noMention).toEqual({ action: 'drop', reason: 'mention-required', botMentioned: false })
  })

  test('DM, subtype and missing-user drops carry a reason and no mention flag', async () => {
    const dm = await gate(
      { user: 'U_EVE', channel: 'D1', channel_type: 'im', text: 'hi', ts: '1.5' },
      makeOpts({ dmPolicy: 'allowlist' }),
    )
    expect(dm).toEqual({ action: 'drop', reason: 'dm-not-allowed' })

    const edited = await gate(
      { subtype: 'message_changed', user: 'U_ALICE', channel: 'C1', channel_type: 'channel', ts: '1.6' },
      makeOpts(),
    )
    expect(edited).toEqual({ action: 'drop', reason: 'subtype' })

    const noUser = await gate({ channel: 'C1', channel_type: 'channel', ts: '1.7' }, makeOpts())
    expect(noUser).toEqual({ action: 'drop', reason: 'no-user' })
  })

  test('self-echo and an unlisted peer bot are told apart', async () => {
    const echo = await gate(
      { bot_id: 'B_BOT', user: 'U_BOT', channel: 'C1', channel_type: 'channel', ts: '1.8' },
      makeOpts(),
    )
    expect(echo.reason).toBe('self-echo')

    const peer = await gate(
      { bot_id: 'B_PEER', user: 'U_PEER', channel: 'C1', channel_type: 'channel', ts: '1.9' },
      makeOpts({ channels: { C1: channelPolicy } }),
    )
    expect(peer.reason).toBe('bot-not-allowed')
  })

  test('no drop in lib.ts is left without a reason', () => {
    const src = readFileSync(join(import.meta.dir, 'lib.ts'), 'utf8')
    expect(src).not.toContain("{ action: 'drop' }")
  })
})

describe('server.ts journals the reason', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

  test('handleMessage: reason at the top level, botMentioned in input', () => {
    const fn = src.slice(src.indexOf('async function handleMessage('))
    const dropCase = fn.slice(fn.indexOf("case 'drop': {"), fn.indexOf("case 'pair': {"))
    expect(dropCase).toContain("kind: 'gate.inbound.drop'")
    expect(dropCase).toMatch(/\.\.\.\(result\.reason \? \{ reason: result\.reason \} : \{\}\)/)
    expect(dropCase).toMatch(
      /input: \{[\s\S]*?\.\.\.\(result\.botMentioned !== undefined \? \{ botMentioned: result\.botMentioned \} : \{\}\)/,
    )
  })

  test('a refused answer press journals its reason too', () => {
    const fn = src.slice(src.indexOf('answerPressGate(press,'))
    const block = fn.slice(0, fn.indexOf('postEphemeral'))
    expect(block).toMatch(/\.\.\.\(result\.reason \? \{ reason: result\.reason \} : \{\}\)/)
  })
})

describe('the journal accepts the new shape', () => {
  let rawRoot: string
  let logPath: string
  beforeEach(() => {
    rawRoot = mkdtempSync(join(tmpdir(), 'drop-reason-'))
    logPath = join(realpathSync.native(rawRoot), 'audit.log')
  })
  afterEach(() => rmSync(rawRoot, { recursive: true, force: true }))

  test('reason and input.botMentioned survive the write and the chain verifies', async () => {
    const { JournalWriter, verifyJournal } = await import('./journal.ts')
    const w = await JournalWriter.open({ path: logPath, initialPrevHash: 'd'.repeat(64) })
    await w.writeEvent({
      kind: 'gate.inbound.drop',
      outcome: 'drop',
      actor: 'session_owner',
      reason: 'channel-not-allowed',
      input: { channel: 'C_NEW', user: 'U_ALICE', botMentioned: true },
    })
    await w.close()

    const result = await verifyJournal(logPath)
    expect(result.ok).toBe(true)
    const ev = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(ev.reason).toBe('channel-not-allowed')
    expect(ev.input).toEqual({ channel: 'C_NEW', user: 'U_ALICE', botMentioned: true })
  })
})
