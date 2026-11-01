/**
 * CC-Link 2: one message tool with an optional wait (replaces note/ask), a
 * reply tool that works for ANY own message, the tool-name prefix from
 * CC_LINK_AGENT_NAME, and the MARVEEN_URL base checks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_TOOL_PREFIX, loadConfig, sanitizeToolPrefix, TOOL_PREFIX_MAX } from '../src/config.ts'
import { ASK_HEADER, MESSAGE_HEADER, NOTE_HEADER, NO_REPLY_NEEDED } from '../src/format.ts'
import { buildInstructions } from '../src/instructions.ts'
import { toolDefinitions, toolNames } from '../src/tools.ts'
import { addr, BASE_URL, DEVICE_KEY, framed, idFrom, MAIN, makeConfig, makeHarness, makeLink, SENDER, type Harness } from './helpers.ts'

const FULL = { MARVEEN_URL: BASE_URL, MARVEEN_DEVICE_KEY: DEVICE_KEY, MARVEEN_SENDER_ID: SENDER }

describe('tool-name prefix (CC_LINK_AGENT_NAME)', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('unset: the neutral agent_* names', () => {
    const cfg = loadConfig(FULL, [], h.dir)
    expect(cfg.toolPrefix).toBe(DEFAULT_TOOL_PREFIX)
    expect(toolNames(cfg.toolPrefix)).toEqual({ message: 'agent_message', reply: 'agent_reply', inbox: 'agent_inbox' })
  })

  test('set: acme -> acme_message / acme_reply / acme_inbox, and only those are callable', async () => {
    const s = makeLink(h, { pid: 7001, env: { CC_LINK_AGENT_NAME: 'acme' } })
    expect(s.link.tools).toEqual({ message: 'acme_message', reply: 'acme_reply', inbox: 'acme_inbox' })
    const ok = await s.link.callTool('acme_message', { text: 'hi' })
    expect(ok.isError).toBe(false)
    const other = await s.link.callTool('agent_message', { text: 'hi' })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('unknown tool: agent_message')
    // An unknown name never reaches the network (no flush, no send).
    expect(h.dash.posts().length).toBe(1)
  })

  test('sanitized to [a-z0-9_]: case folded, other runs become one underscore, edges trimmed, capped', () => {
    expect(sanitizeToolPrefix('Acme')).toBe('acme')
    expect(sanitizeToolPrefix(' Mate-Laptop 2 ')).toBe('mate_laptop_2')
    expect(sanitizeToolPrefix('__a..b__')).toBe('a_b')
    expect(sanitizeToolPrefix('jános')).toBe('j_nos')
    expect(sanitizeToolPrefix('---')).toBeUndefined()
    const long = sanitizeToolPrefix('x'.repeat(100))!
    expect(long.length).toBe(TOOL_PREFIX_MAX)
    // The longest tool name stays inside the MCP 64-character limit.
    expect(`${long}_message`.length).toBeLessThanOrEqual(64)
  })

  test('a name with no letters or digits falls back to agent_ with a warning; a changed name is noticed once', () => {
    const bad = loadConfig({ ...FULL, CC_LINK_AGENT_NAME: '***' }, [], h.dir)
    expect(bad.toolPrefix).toBe('agent')
    expect(bad.warnings.some(w => w.includes('CC_LINK_AGENT_NAME'))).toBe(true)
    expect(bad.errors).toEqual([])
    const changed = loadConfig({ ...FULL, CC_LINK_AGENT_NAME: 'Acme' }, [], h.dir)
    expect(changed.toolPrefix).toBe('acme')
    expect(changed.notices.some(n => n.includes('tool prefix acme_'))).toBe(true)
    expect(changed.warnings).toEqual([])
  })

  test('the prefix never comes from whoami: the dashboard reports another main agent, the names stay', async () => {
    h.dash.whoami = { kind: 'device', scope: 'messages', sender_id: SENDER, mainAgentId: 'marveen' }
    const s = makeLink(h, { pid: 7002, env: { CC_LINK_AGENT_NAME: 'acme' } })
    await s.link.startup()
    expect(s.link.tools.message).toBe('acme_message')
  })

  test('tool definitions, instructions and every hint use the prefixed names, never a hardcoded agent name', async () => {
    const names = toolNames('zed')
    const defs = toolDefinitions(names, 8000, 60)
    expect(defs.map(d => d.name)).toEqual(['zed_message', 'zed_reply', 'zed_inbox'])
    expect(defs[0]!.inputSchema.required).toEqual(['text'])
    expect(Object.keys(defs[0]!.inputSchema.properties)).toEqual(['text', 'wait'])
    const all = JSON.stringify(defs) + buildInstructions(60, names)
    expect(all).not.toMatch(/agent_(message|reply|inbox)/)
    expect(all).toContain('zed_reply')

    h.alive.add(7003)
    const s = makeLink(h, { pid: 7003, env: { CC_LINK_AGENT_NAME: 'zed', CC_LINK_ASK_WAIT_SEC: '3' } })
    const r = await s.link.callTool('zed_message', { text: 'q', wait: true })
    expect(r.text).toContain(`zed_reply(${idFrom(r.text)})`)
  })

  test('the removed note/ask tools answer with a pointer to <prefix>_message', async () => {
    const s = makeLink(h, { pid: 7004, env: { CC_LINK_AGENT_NAME: 'acme' } })
    for (const old of ['acme_note', 'acme_ask']) {
      const r = await s.link.callTool(old, { text: 'x' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('acme_message(text, wait?)')
    }
    expect(h.dash.posts()).toEqual([])
  })
})

describe('upgrade hints and inbox listing (Q review of #1)', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('a tool name with another prefix answers with the right name (old allowlist / slash command)', async () => {
    const s = makeLink(h, { pid: 7401 })
    const r = await s.link.callTool('acme_reply', { id: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('prefix agent_ (CC_LINK_AGENT_NAME); did you mean agent_reply?')
    expect(h.dash.calls).toEqual([])
  })

  test('agent_inbox lists questions and no-wait messages separately', async () => {
    h.alive.add(7402)
    const s = makeLink(h, { pid: 7402, env: { CC_LINK_ASK_WAIT_SEC: '3' } })
    const q = idFrom((await s.link.callTool('agent_message', { text: 'a question', wait: true })).text)
    const n = idFrom((await s.link.callTool('agent_message', { text: 'a summary' })).text)
    const inbox = (await s.link.callTool('agent_inbox')).text
    expect(inbox).toContain(`questions waiting for an answer (1):\n- id ${q} `)
    expect(inbox).toContain(`messages sent without wait, not closed yet (1; an answer is pushed if one comes):\n- id ${n} `)
  })
})

describe('agent_message without wait (the old note)', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('returns at once with the id; neutral header, no "no reply needed" line; tracked quietly', async () => {
    h.alive.add(7101)
    const s = makeLink(h, { pid: 7101 })
    const r = await s.link.callTool('agent_message', { text: 'summary' })
    expect(r.isError).toBe(false)
    const id = idFrom(r.text)
    expect(r.text).toContain(`sent (id ${id})`)
    expect(r.text).toContain(`agent_reply(${id})`)
    const content = h.dash.posts()[0]!.body.content as string
    expect(content.startsWith(`${MESSAGE_HEADER} `)).toBe(true)
    expect(content).not.toContain(NO_REPLY_NEEDED)
    expect(content.endsWith('\n\nsummary')).toBe(true)
    // No read-back polling: one POST, no GET of the row.
    expect(h.dash.calls.some(c => c.method === 'GET' && c.path === `/api/messages/${id}`)).toBe(false)
    expect(s.link.deps.asks.read()).toEqual([expect.objectContaining({ id, pid: 7101, quiet: true })])
  })

  test('a later answer to it is pushed like any answer, and the record is dropped', async () => {
    h.alive.add(7102)
    const s = makeLink(h, { pid: 7102 })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'fyi' })).text)
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    h.dash.answer(id, 'Follow-up question: which branch?')
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([
      { content: framed('Follow-up question: which branch?'), meta: { kind: 'answer', ask_id: String(id), from: MAIN } },
    ])
    expect(s.link.deps.asks.read()).toEqual([])
    const inbox = await s.link.callTool('agent_inbox')
    expect(inbox.text).toContain(`answer to message ${id}`)
  })

  test('closed without an answer: dropped silently (no push, nothing "not yet shown")', async () => {
    h.alive.add(7103)
    const s = makeLink(h, { pid: 7103 })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'fyi' })).text)
    h.dash.answer(id, '')
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    expect(s.link.received).toEqual([])
    expect(s.link.deps.asks.read()).toEqual([])
    const after = await s.link.callTool('agent_inbox')
    expect(after.text).not.toContain('not yet shown')
  })

  test('unanswered for 7 days: dropped silently', async () => {
    h.alive.add(7104)
    const s = makeLink(h, { pid: 7104 })
    await s.link.callTool('agent_message', { text: 'fyi' })
    h.clock.t += 8 * 24 * 60 * 60 * 1000
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    expect(s.link.deps.asks.read()).toEqual([])
  })

  test('a failed one is still reported (the main agent never saw it)', async () => {
    h.alive.add(7105)
    const s = makeLink(h, { pid: 7105 })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'fyi' })).text)
    h.dash.answer(id, 'refused by policy', 'failed')
    await s.link.pollOwnAsks()
    expect(s.notified.length).toBe(1)
    expect(s.notified[0]!.meta).toEqual({ kind: 'answer', ask_id: String(id), from: MAIN, status: 'failed' })
  })

  test('a queued message is tracked quietly once the outbox flushes it', async () => {
    h.alive.add(7106)
    const s = makeLink(h, { pid: 7106 })
    await s.link.resolveMain(true)
    h.dash.override = c => (c.method === 'POST' ? 'network' : undefined)
    const q = await s.link.callTool('agent_message', { text: 'offline note' })
    expect(q.text).toContain('queued in outbox')
    h.dash.override = undefined
    await s.link.flushOutbox()
    const id = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)!.id
    expect(s.link.deps.asks.read()).toEqual([expect.objectContaining({ id, pid: 7106, quiet: true })])
  })

  test('wait accepts true/false and "true"/"false"; anything else is refused before sending', async () => {
    h.alive.add(7107)
    const s = makeLink(h, { pid: 7107, env: { CC_LINK_ASK_WAIT_SEC: '3' } })
    const asString = await s.link.callTool('agent_message', { text: 'q', wait: 'true' })
    expect(h.dash.posts().at(-1)!.body.content.startsWith(`${ASK_HEADER} `)).toBe(true)
    expect(asString.text).toContain('Nincs még válasz')
    await s.link.callTool('agent_message', { text: 'n', wait: false })
    expect(h.dash.posts().at(-1)!.body.content.startsWith(`${MESSAGE_HEADER} `)).toBe(true)
    const before = h.dash.posts().length
    const bad = await s.link.callTool('agent_message', { text: 'x', wait: 'yes' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('wait must be true or false')
    expect(h.dash.posts().length).toBe(before)
  })
})

describe('agent_reply works for ANY own message', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('states: not yet delivered, delivered, read without an answer, answered', async () => {
    h.alive.add(7201)
    const s = makeLink(h, { pid: 7201 })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'fyi' })).text)

    let r = await s.link.callTool('agent_reply', { id })
    expect(r.isError).toBe(false)
    expect(r.text).toContain(`id ${id}: waiting: not yet delivered to the main agent (status pending)`)

    h.dash.rows.get(id)!.status = 'delivered'
    r = await s.link.callTool('agent_reply', { id })
    expect(r.text).toContain('waiting: delivered to the main agent, no answer yet (status delivered)')

    h.dash.answer(id, 'Got it, one question: why?')
    r = await s.link.callTool('agent_reply', { id })
    expect(r.text).toContain(`id ${id}: answered (status done)`)
    expect(r.text).toContain(framed('Got it, one question: why?'))
    // Shown by the reply itself: settled, never pushed afterwards, nothing "not yet shown".
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    expect(r.text).not.toContain('not yet shown')
    expect(s.link.deps.asks.read()).toEqual([])

    const id2 = idFrom((await s.link.callTool('agent_message', { text: 'fyi 2' })).text)
    h.dash.answer(id2, '')
    r = await s.link.callTool('agent_reply', { id: id2 })
    expect(r.text).toContain(`id ${id2}: read by the main agent, closed without an answer (status done)`)
  })

  test('a legacy note row ([Claude Code összefoglaló]) from this folder is accepted, untracked', async () => {
    const s = makeLink(h, { pid: 7202 })
    const folderKey = s.link.deps.identity.folderKey
    const row = h.dash.insert({
      from_agent: SENDER,
      to_agent: MAIN,
      content: `${NOTE_HEADER} 2026-10-19 17:33 · repo-a@main · ref:abcdefghij\n${NO_REPLY_NEEDED}\n\nold note`,
      origin_note: `claude-code repo-a@main ${addr(folderKey)}`,
      status: 'done',
      result: 'late answer',
    })
    const r = await s.link.callTool('agent_reply', { id: row.id })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('answered')
    expect(r.text).toContain('late answer')
  })

  test('a row from this sender without a cc-link header, or from another folder, is refused', async () => {
    const s = makeLink(h, { pid: 7203 })
    const folderKey = s.link.deps.identity.folderKey
    const noHeader = h.dash.insert({ from_agent: SENDER, to_agent: MAIN, content: 'hand-made', origin_note: addr(folderKey) })
    const otherFolder = h.dash.insert({
      from_agent: SENDER,
      to_agent: MAIN,
      content: `${MESSAGE_HEADER} x · r@b\n\nx`,
      origin_note: addr('0123abcd'),
    })
    for (const id of [noHeader.id, otherFolder.id]) {
      const r = await s.link.callTool('agent_reply', { id })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('not sent from this folder')
    }
  })
})

describe('MARVEEN_URL base (item 9)', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('trailing slashes are stripped, so requests never go to //api', async () => {
    for (const raw of ['https://dash.test:3420/', 'https://dash.test:3420//', ' https://dash.test:3420/ ']) {
      expect(loadConfig({ ...FULL, MARVEEN_URL: raw }, [], h.dir).url).toBe('https://dash.test:3420')
    }
    const s = makeLink(h, { pid: 7301, config: makeConfig(h, { MARVEEN_URL: 'https://dash.test:3420/' }) })
    await s.link.callTool('agent_message', { text: 'x' })
    expect(h.dash.calls.length).toBeGreaterThan(0)
    expect(h.dash.calls.every(c => c.path.startsWith('/api/'))).toBe(true)
  })

  test('a sub-path base (reverse proxy) is kept', () => {
    expect(loadConfig({ ...FULL, MARVEEN_URL: 'https://proxy.test/marveen/' }, [], h.dir).url).toBe('https://proxy.test/marveen')
  })

  test('a base that already ends in /api, or carries a query, fails with a clear message', () => {
    for (const raw of ['https://dash.test:3420/api', 'https://dash.test:3420/api/', 'https://dash.test:3420/api/messages']) {
      const cfg = loadConfig({ ...FULL, MARVEEN_URL: raw }, [], h.dir)
      expect(cfg.url).toBeUndefined()
      expect(cfg.errors.some(e => e.includes('without /api'))).toBe(true)
    }
    const q = loadConfig({ ...FULL, MARVEEN_URL: 'https://dash.test:3420/?x=1' }, [], h.dir)
    expect(q.errors.some(e => e.includes('must not contain a query'))).toBe(true)
  })
})
