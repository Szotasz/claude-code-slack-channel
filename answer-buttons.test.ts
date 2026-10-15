// One-tap answer buttons on reply (SLACKGOMB1015): the payload going out, the
// press coming back, and who may press. The press is gated as the typed
// message it stands for, through the real gate().
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Access,
  ANSWER_BLOCK_ID,
  type AnswerPress,
  answeredBlocks,
  answerPressGate,
  buildAnswerBlocks,
  defaultAccess,
  type GateOptions,
  matchPermissionReply,
  parseAnswerPress,
  replyChunkBlocks,
  validateAnswerButtons,
} from './lib.ts'

const OWNER = 'U0OWNER1'
const STRANGER = 'U0STRANG'
const DM = 'D0C74N9SAF6'
const CHAN = 'C0TEAM001'

function opts(access: Partial<Access> = {}, extra: Partial<GateOptions> = {}): GateOptions {
  return {
    access: { ...defaultAccess(), ...access },
    staticMode: false,
    saveAccess: () => {},
    botUserId: 'U_BOT',
    selfBotId: 'B_BOT',
    selfAppId: 'A_BOT',
    ...extra,
  }
}

function press(over: Partial<AnswerPress> = {}): AnswerPress {
  return { label: 'Igen', userId: OWNER, channel: DM, messageTs: '1760000000.000100', threadTs: undefined, ...over }
}

/** A block_actions payload as Slack sends it for a press on our message. */
function payload(over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    user: { id: OWNER },
    channel: { id: DM },
    container: { type: 'message', channel_id: DM, message_ts: '1760000000.000100' },
    message: {
      ts: '1760000000.000100',
      text: 'Mehet?',
      blocks: buildAnswerBlocks('Mehet?', ['Igen', 'Nem']),
    },
    actions: [{ type: 'button', block_id: ANSWER_BLOCK_ID, action_id: 'answer:0', value: 'Igen', ...action }],
    ...over,
  }
}

describe('validateAnswerButtons', () => {
  test('absent means no buttons', () => {
    expect(validateAnswerButtons(undefined)).toBeUndefined()
    expect(validateAnswerButtons(null)).toBeUndefined()
  })

  test('a valid list passes through unchanged', () => {
    expect(validateAnswerButtons(['Igen', 'Nem', 'Később'])).toEqual(['Igen', 'Nem', 'Később'])
  })

  test.each([
    ['an empty list', []],
    ['13 labels', Array.from({ length: 13 }, (_, i) => `o${i}`)],
    ['an empty label', ['Igen', '']],
    ['a blank label', ['Igen', '   ']],
    ['a 65-character label', ['x'.repeat(65)]],
    ['a non-string label', ['Igen', 2]],
    ['not a list', 'Igen'],
    ['duplicate labels', ['Igen', 'Igen']],
  ])('rejects %s', (_name, value) => {
    expect(() => validateAnswerButtons(value)).toThrow(/^buttons:/)
  })

  test('12 labels of 64 characters is the edge that still passes', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(64, 'x'))
    expect(validateAnswerButtons(twelve)).toEqual(twelve)
  })
})

describe('buildAnswerBlocks (the outgoing payload)', () => {
  test('the text as a mrkdwn section, then one actions block with a button per label', () => {
    expect(buildAnswerBlocks('Mehet a *merge*?', ['Igen', 'Nem'])).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Mehet a *merge*?' } },
      {
        type: 'actions',
        block_id: ANSWER_BLOCK_ID,
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Igen', emoji: true }, action_id: 'answer:0', value: 'Igen' },
          { type: 'button', text: { type: 'plain_text', text: 'Nem', emoji: true }, action_id: 'answer:1', value: 'Nem' },
        ],
      },
    ])
  })

  test('a text over the 3000-character section limit is split, nothing lost', () => {
    const text = 'a'.repeat(3000) + 'b'.repeat(1000)
    const blocks = buildAnswerBlocks(text, ['OK'])
    const sections = blocks.filter((b) => b.type === 'section') as { text: { text: string } }[]
    expect(sections).toHaveLength(2)
    expect(sections.every((s) => s.text.text.length <= 3000)).toBe(true)
    expect(sections.map((s) => s.text.text).join('')).toBe(text)
    expect(blocks.at(-1)?.type).toBe('actions')
  })

  test('the buttons go on the last chunk only', () => {
    const chunks = ['első', 'második', 'harmadik']
    expect(replyChunkBlocks(chunks, 0, ['Igen'])).toBeUndefined()
    expect(replyChunkBlocks(chunks, 1, ['Igen'])).toBeUndefined()
    expect(replyChunkBlocks(chunks, 2, ['Igen'])).toEqual(buildAnswerBlocks('harmadik', ['Igen']))
    expect(replyChunkBlocks(chunks, 2, undefined)).toBeUndefined()
  })
})

describe('parseAnswerPress (the press coming back)', () => {
  test('reads label, presser, conversation and question from a press', () => {
    expect(parseAnswerPress(payload())).toEqual({
      label: 'Igen',
      userId: OWNER,
      channel: DM,
      messageTs: '1760000000.000100',
      threadTs: undefined,
    })
  })

  test('a question inside a thread keeps its thread', () => {
    const p = payload({ message: { ts: '1760000000.000200', thread_ts: '1760000000.000001', blocks: [] } })
    expect(parseAnswerPress(p)?.threadTs).toBe('1760000000.000001')
  })

  test('falls back to the container for channel and message ts', () => {
    const p = payload({ channel: undefined, message: undefined })
    expect(parseAnswerPress(p)).toMatchObject({ channel: DM, messageTs: '1760000000.000100' })
  })

  test.each([
    ['a permission button', payload({}, { block_id: 'perm', action_id: 'perm:allow:abcde', value: undefined })],
    ['another block id', payload({}, { block_id: 'something_else' })],
    ['another action id shape', payload({}, { action_id: 'answer:x' })],
    ['not block_actions', payload({ type: 'view_submission' })],
    ['no actions', payload({ actions: [] })],
    ['a label over the limit', payload({}, { value: 'x'.repeat(65) })],
    ['an empty label', payload({}, { value: '' })],
    ['a malformed user id', payload({ user: { id: 'u<script>' } })],
    ['no channel at all', payload({ channel: undefined, container: undefined })],
  ])('ignores %s', (_name, body) => {
    expect(parseAnswerPress(body)).toBeNull()
  })
})

describe('answerPressGate (who may press)', () => {
  test('the DM owner (allowFrom): delivered as the label, on the question ts', async () => {
    const { event, result } = await answerPressGate(press(), opts({ allowFrom: [OWNER] }))
    expect(result.action).toBe('deliver')
    expect(event).toMatchObject({ channel: DM, channel_type: 'im', user: OWNER, ts: '1760000000.000100' })
    expect(event.text).toBe('<@U_BOT> Igen')
  })

  test('a DM press from someone not on allowFrom is dropped, and opens no pairing request', async () => {
    let saved = 0
    const o = opts({ dmPolicy: 'pairing', allowFrom: [OWNER] }, { saveAccess: () => saved++ })
    const { result } = await answerPressGate(press({ userId: STRANGER }), o)
    expect(result.action).toBe('drop')
    expect(Object.keys(o.access.pending)).toHaveLength(0)
    expect(saved).toBe(0)
  })

  test('a channel that is not opted in: dropped', async () => {
    const { result } = await answerPressGate(press({ channel: CHAN }), opts({ allowFrom: [OWNER] }))
    expect(result.action).toBe('drop')
  })

  test("an opted-in channel's own allowFrom decides: listed delivers, unlisted drops", async () => {
    const access = { channels: { [CHAN]: { requireMention: false, allowFrom: [OWNER] } } }
    expect((await answerPressGate(press({ channel: CHAN }), opts(access))).result.action).toBe('deliver')
    const stranger = await answerPressGate(press({ channel: CHAN, userId: STRANGER }), opts(access))
    expect(stranger.result.action).toBe('drop')
  })

  test('a requireMention channel: pressing a button on our message addresses us', async () => {
    const access = { channels: { [CHAN]: { requireMention: true, allowFrom: [] } } }
    const { event, result } = await answerPressGate(press({ channel: CHAN }), opts(access))
    expect(event.channel_type).toBe('channel')
    expect(result.action).toBe('deliver')
  })

  test('a question inside a thread is answered in that thread', async () => {
    const { event } = await answerPressGate(press({ threadTs: '1760000000.000001' }), opts({ allowFrom: [OWNER] }))
    expect(event.thread_ts).toBe('1760000000.000001')
  })
})

describe('after the press', () => {
  test('the buttons give way to one line naming the choice and the presser; the text stays', () => {
    const blocks = buildAnswerBlocks('Mehet?', ['Igen', 'Nem'])
    expect(answeredBlocks(blocks, 'Igen', OWNER)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Mehet?' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `➡️ *Igen* (<@${OWNER}>)` }] },
    ])
  })

  test('a label cannot inject markup into that line', () => {
    const line = answeredBlocks([], '<!channel> & co', OWNER).at(-1) as { elements: { text: string }[] }
    expect(line.elements[0]!.text).toContain('&lt;!channel&gt; &amp; co')
  })

  test('a button label is never a permission verdict; the same text typed still is', () => {
    expect(matchPermissionReply('yes abcde', false)).not.toBeNull()
    expect(matchPermissionReply('yes abcde', true)).toBeNull()
  })
})

describe('server.ts wiring (read, since importing it starts the Slack client)', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

  test('the reply tool lists `buttons`, and its zod schema accepts it', () => {
    expect(src).toMatch(/buttons: \{\s*type: 'array',\s*items: \{ type: 'string' \}/)
    expect(src).toMatch(/files: z\.array\(z\.string\(\)\)\.optional\(\),\s*buttons: z\.array\(z\.string\(\)\)\.optional\(\),/)
  })

  test('executeReply validates the buttons before the outbound gate, and sends them per chunk', () => {
    const body = src.slice(src.indexOf('async function executeReply'), src.indexOf('// Upload files if provided'))
    const validate = body.indexOf('validateAnswerButtons(args.buttons)')
    expect(validate).toBeGreaterThan(-1)
    expect(validate).toBeLessThan(body.indexOf('assertOutboundAllowed(chatId, threadTs)'))
    expect(body).toMatch(/chat\.postMessage\(\{[\s\S]*blocks: replyChunkBlocks\(chunks, i, buttons\),[\s\S]*\}/)
  })

  test('the interactive handler tries an answer press before the permission buttons', () => {
    const body = src.slice(src.indexOf("socket.on('interactive'"))
    const answer = body.indexOf('parseAnswerPress(body)')
    expect(answer).toBeGreaterThan(-1)
    expect(answer).toBeLessThan(body.indexOf('perm:(allow|deny|more)'))
    expect(body).toMatch(/if \(press\) \{\s*await handleAnswerPress\(press, body\.message\)\s*return\s*\}/)
  })

  test('a press is gated by answerPressGate and delivered as a button press', () => {
    const body = src.slice(src.indexOf('async function handleAnswerPress'), src.indexOf("socket.on('interactive'"))
    expect(body).toContain('await answerPressGate(press, {')
    expect(body).toMatch(/if \(result\.action !== 'deliver'\) \{[\s\S]*?return\s*\}/)
    expect(body).toContain('await deliverEvent(ev, result.access!, { viaButton: true })')
  })

  test('deliverEvent skips the permission-reply path for a button press', () => {
    expect(src).toContain('const permMatch = matchPermissionReply(msgText, opts.viaButton === true)')
  })
})
