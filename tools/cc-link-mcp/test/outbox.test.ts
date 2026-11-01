import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OutboxItem } from '../src/outbox.ts'
import { DEVICE_KEY, framed, MAIN, makeHarness, makeLink, SENDER, type Harness } from './helpers.ts'

const fail503 = () => new Response('{"error":"upstream down"}', { status: 503 })

function items(dir: string): OutboxItem[] {
  return readdirSync(dir)
    .filter(n => /^\d+-[0-9a-f]+\.json$/.test(n))
    .sort()
    .map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as OutboxItem)
}

describe('outbox', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  for (const [label, override] of [
    ['network error', () => 'network' as const],
    ['5xx', fail503],
  ] as const) {
    test(`${label} on send queues the FULL payload`, async () => {
      const s = makeLink(h, { pid: 900 })
      await s.link.resolveMain(true)
      h.dash.override = c => (c.path === '/api/messages' && c.method === 'POST' ? override() : undefined)
      const r = await s.link.callTool('tony_note', { text: 'summary body' })
      expect(r.isError).toBe(false)
      expect(r.text).toContain('queued in outbox (network error), will retry')
      const q = items(s.link.deps.outbox.dir)
      expect(q.length).toBe(1)
      const it = q[0]!
      expect(it.kind).toBe('note')
      expect(it.pid).toBe(900)
      expect(it.folderKey).toBe(s.link.deps.identity.folderKey)
      expect(it.payload.from).toBe(SENDER)
      expect(it.payload.to).toBe(MAIN)
      expect(it.payload.origin_note).toBe(s.link.deps.identity.originNote())
      expect(it.payload.content).toContain('[Claude Code összefoglaló]')
      expect(it.payload.content).toContain('Nem kell válasz.')
      expect(it.payload.content.endsWith('summary body')).toBe(true)
      expect(r.text).toContain('outbox: 1 waiting')
    })
  }

  test('4xx on send is not queued and returns status + server error', async () => {
    const s = makeLink(h, { pid: 901 })
    h.dash.override = c =>
      c.method === 'POST' ? new Response('{"error":"sender not allowed"}', { status: 403 }) : undefined
    const r = await s.link.callTool('tony_note', { text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('403')
    expect(r.text).toContain('sender not allowed')
    expect(s.link.deps.outbox.count()).toBe(0)
  })

  test('flush keeps order, deletes each item on success, stops at the first retryable failure', async () => {
    const s = makeLink(h, { pid: 902 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    for (const t of ['one', 'two', 'three']) await s.link.callTool('tony_note', { text: t })
    expect(s.link.deps.outbox.count()).toBe(3)

    // Second POST fails with 503: first is sent and deleted, second and third stay.
    let posts = 0
    h.dash.override = c => {
      if (c.method === 'POST') {
        posts++
        if (posts === 2) return fail503()
      }
      return undefined
    }
    const r = await s.link.callTool('tony_inbox')
    const sent = h.dash.posts().filter(c => c.body && c.who === '902')
    const okBodies = [...h.dash.rows.values()].map(row => row.content)
    expect(okBodies.length).toBe(1)
    expect(okBodies[0]!.endsWith('one')).toBe(true)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    const left = items(s.link.deps.outbox.dir).map(i => i.payload.content.split('\n').pop())
    expect(left).toEqual(['two', 'three'])
    expect(r.text).toContain('outbox: 2 waiting')

    // Back online: the rest goes out in order.
    h.dash.override = undefined
    await s.link.callTool('tony_inbox')
    expect([...h.dash.rows.values()].map(row => row.content.split('\n').pop())).toEqual(['one', 'two', 'three'])
    expect(s.link.deps.outbox.count()).toBe(0)
  })

  test('success deletes the item immediately (before the next item is sent)', async () => {
    const s = makeLink(h, { pid: 903 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('tony_note', { text: 'a' })
    await s.link.callTool('tony_note', { text: 'b' })
    const counts: number[] = []
    h.dash.override = c => {
      if (c.method === 'POST') counts.push(s.link.deps.outbox.count())
      return undefined
    }
    await s.link.callTool('tony_inbox')
    expect(counts).toEqual([2, 1])
  })

  test('a queued ask is registered in asks.json with its pid after flush, then delivered', async () => {
    h.alive.add(904)
    const s = makeLink(h, { pid: 904 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    const r = await s.link.callTool('tony_ask', { question: 'what is up?' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('queued')
    expect(s.link.deps.asks.read()).toEqual([])

    h.dash.override = undefined
    await s.link.callTool('tony_inbox')
    const asks = s.link.deps.asks.read()
    expect(asks.length).toBe(1)
    expect(asks[0]!.pid).toBe(904)
    expect(asks[0]!.preview).toContain('what is up?')
    h.dash.answer(asks[0]!.id, 'all good')
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([{ content: framed('all good'), meta: { kind: 'answer', ask_id: String(asks[0]!.id), from: MAIN } }])
  })

  test('4xx during flush moves the item to rejected/, logs errors.log, reports in the next tool result', async () => {
    const s = makeLink(h, { pid: 905 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('tony_note', { text: 'BODY-MARKER-4XX' })
    h.dash.override = c => (c.method === 'POST' ? new Response('{"error":"bad request"}', { status: 400 }) : undefined)
    const r = await s.link.callTool('tony_inbox')
    const ob = s.link.deps.outbox
    expect(ob.count()).toBe(0)
    expect(readdirSync(ob.rejectedDir).length).toBe(1)
    const errLog = readFileSync(join(ob.dir, 'errors.log'), 'utf8')
    expect(errLog).toContain('status=400')
    expect(errLog).not.toContain('BODY-MARKER-4XX')
    expect(errLog).not.toContain(DEVICE_KEY)
    expect(r.text).toContain('rejected by the server')
    // Reported once, not on every later call.
    h.dash.override = undefined
    const r2 = await s.link.callTool('tony_inbox')
    expect(r2.text).not.toContain('rejected by the server')
  })

  test('items older than 7 days are kept and warned about', async () => {
    const s = makeLink(h, { pid: 906, env: { MARVEEN_MAIN_AGENT: MAIN } })
    const old = new Date(h.clock.t - 8 * 24 * 3600 * 1000).toISOString()
    s.link.deps.outbox.enqueue({
      createdAt: old,
      kind: 'note',
      folderKey: s.link.deps.identity.folderKey,
      pid: 906,
      payload: { from: SENDER, to: MAIN, content: 'old', origin_note: 'n' },
    })
    h.dash.override = () => 'network'
    const r = await s.link.callTool('tony_inbox')
    expect(r.text).toContain('1 outbox item(s) older than 7 days')
    expect(r.text).toContain('outbox: 1 waiting')
    expect(s.link.deps.outbox.count()).toBe(1)
  })

  test('flush.log has one line per flush with counts, and no message body or device key', async () => {
    const s = makeLink(h, { pid: 907 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('tony_note', { text: 'BODY-MARKER-FLUSH' })
    await s.link.callTool('tony_inbox') // flush attempt 1 (fails)
    h.dash.override = undefined
    await s.link.callTool('tony_inbox') // flush attempt 2 (sends)
    const log = readFileSync(join(s.link.deps.outbox.dir, 'flush.log'), 'utf8').trim().split('\n')
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log.at(-1)).toMatch(/^\d{4}-\d\d-\d\dT.*sent=1 failed=0 rejected=0 remaining=0$/)
    const all = log.join('\n')
    expect(all).not.toContain('BODY-MARKER-FLUSH')
    expect(all).not.toContain(DEVICE_KEY)
  })

  test('dry run sends nothing and shows Bearer <redacted>', async () => {
    const s = makeLink(h, { pid: 908, env: { CC_LINK_DRY_RUN: '1' } })
    await s.link.startup()
    const note = await s.link.callTool('tony_note', { text: 'dry note body' })
    const askR = await s.link.callTool('tony_ask', { question: 'dry question' })
    const reply = await s.link.callTool('tony_reply', { id: 5 })
    const inbox = await s.link.callTool('tony_inbox')
    expect(h.dash.calls).toEqual([])
    for (const r of [note, askR]) {
      expect(r.isError).toBe(false)
      expect(r.text).toContain('POST /api/messages')
      expect(r.text).toContain('Bearer <redacted>')
      expect(r.text).not.toContain(DEVICE_KEY)
    }
    expect(note.text).toContain('dry note body')
    expect(reply.text).toContain('Bearer <redacted>')
    expect(inbox.isError).toBe(false)
    expect(s.link.deps.outbox.count()).toBe(0)
    expect(existsSync(join(h.stateDir, 'outbox', 'flush.log'))).toBe(false)
    expect(s.logs.join('\n')).toContain('Bearer <redacted>')
  })
})
