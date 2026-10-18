import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { MessageRow } from '../src/api.ts'
import {
  adoptOrphans,
  hasFolderKeyToken,
  orphanAsks,
  ownAsks,
  selectInbox,
  selectUnaddressed,
  type AskRecord,
} from '../src/delivery.ts'
import { AskStore } from '../src/state.ts'
import { addr, fakeIdentity, framed, idFrom, MAIN, makeHarness, makeLink, ROUTER_ABANDON_REASON, SENDER, type Harness } from './helpers.ts'

const KEY = 'abcd1234'
const OTHER_KEY = 'ffff0000'

function row(p: Partial<MessageRow>): MessageRow {
  return {
    id: 1,
    from_agent: MAIN,
    to_agent: SENDER,
    content: 'x',
    status: 'pending',
    result: null,
    created_at: 1000,
    origin_note: null,
    ...p,
  }
}

function ask(id: number, pid: number): AskRecord {
  // Recent: asks older than 7 days are settled as expired (see the expiry test).
  return { id, pid, createdAt: new Date().toISOString(), preview: `q${id}` }
}

describe('rule 3 (pure): folder-key token matching and inbox selection', () => {
  // M4: only an explicit folder:<key> marker addresses a folder.
  test('folder:<key> marker matches anywhere in the note, case-insensitive', () => {
    expect(hasFolderKeyToken(`claude-code repo@main folder:${KEY}`, KEY)).toBe(true)
    expect(hasFolderKeyToken(`folder:${KEY}`, KEY)).toBe(true)
    expect(hasFolderKeyToken(`for (folder:${KEY})\tplease`, KEY)).toBe(true)
    expect(hasFolderKeyToken(`FOLDER:${KEY.toUpperCase()}`, KEY)).toBe(true)
  })

  test('bare keys, glued markers and longer runs do not match', () => {
    expect(hasFolderKeyToken(KEY, KEY)).toBe(false)
    expect(hasFolderKeyToken(`claude-code repo@main ${KEY}`, KEY)).toBe(false)
    expect(hasFolderKeyToken(`subfolder:${KEY}`, KEY)).toBe(false)
    expect(hasFolderKeyToken(`folder:${KEY}5`, KEY)).toBe(false)
    expect(hasFolderKeyToken(`folder:${KEY}x`, KEY)).toBe(false)
    expect(hasFolderKeyToken(`claude-code repo@main folder:${OTHER_KEY}`, KEY)).toBe(false)
    expect(hasFolderKeyToken(null, KEY)).toBe(false)
    expect(hasFolderKeyToken('', KEY)).toBe(false)
  })

  const ctx = { senderId: SENDER, mainAgentId: MAIN, folderKey: KEY }

  test('selects own-folder and abandoned rows; never unaddressed; rejects the rest; oldest first', () => {
    const rows = [
      row({ id: 10, created_at: 500, origin_note: `claude-code r@b folder:${KEY}` }),
      row({ id: 11, created_at: 100, origin_note: null }), // unaddressed
      row({ id: 12, created_at: 300, origin_note: `claude-code r@b folder:${OTHER_KEY}` }), // other folder
      row({ id: 13, created_at: 200, status: 'failed', result: ROUTER_ABANDON_REASON, origin_note: `folder:${KEY}` }),
      row({ id: 14, created_at: 250, status: 'failed', result: 'Delivery error', origin_note: `folder:${KEY}` }),
      row({ id: 15, created_at: 260, from_agent: 'some-other-agent', origin_note: `folder:${KEY}` }),
      row({ id: 16, created_at: 270, to_agent: 'someone-else', origin_note: `folder:${KEY}` }),
      row({ id: 17, created_at: 280, status: 'done', origin_note: `folder:${KEY}` }),
      row({ id: 18, created_at: 290, status: 'delivered', origin_note: `folder:${KEY}` }),
      row({ id: 19, created_at: 400, origin_note: 'just a free text note' }), // unaddressed
    ]
    expect(selectInbox(rows, ctx).map(r => r.id)).toEqual([13, 10])
    // Unaddressed rows are only listed (peek), never selected for claiming.
    expect(selectUnaddressed(rows, ctx).map(r => r.id)).toEqual([11, 19])
  })

  test('deduplicates rows coming from two listings', () => {
    const r = row({ id: 7, origin_note: `folder:${KEY}` })
    expect(selectInbox([r, { ...r }], ctx).map(x => x.id)).toEqual([7])
  })
})

describe('rules 1-2 (pure): own asks and orphan adoption', () => {
  test('ownAsks keeps only this pid', () => {
    expect(ownAsks([ask(1, 10), ask(2, 20), ask(3, 10)], 10).map(a => a.id)).toEqual([1, 3])
  })

  test('orphanAsks / adoptOrphans take only dead pids', () => {
    const alive = new Set([10, 30])
    const asks = [ask(1, 10), ask(2, 20), ask(3, 30), ask(4, 40)]
    expect(orphanAsks(asks, p => alive.has(p)).map(a => a.id)).toEqual([2, 4])
    const r = adoptOrphans(asks, 30, p => alive.has(p))
    expect(r.adopted.sort()).toEqual([2, 4])
    expect(r.asks.map(a => [a.id, a.pid])).toEqual([
      [1, 10],
      [2, 30],
      [3, 30],
      [4, 30],
    ])
  })
})

describe('rule 1: an answer goes only to the asking session', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('two sessions in one folder each get only their own answer, exactly once', async () => {
    h.alive.add(101).add(102)
    const a = makeLink(h, { pid: 101 })
    const b = makeLink(h, { pid: 102 })
    const ra = await a.link.callTool('tony_ask', { question: 'question from A' })
    const rb = await b.link.callTool('tony_ask', { question: 'question from B' })
    expect(ra.isError).toBe(false)
    expect(rb.isError).toBe(false)
    const idA = idFrom(ra.text)
    const idB = idFrom(rb.text)
    expect(idA).not.toBe(idB)

    h.dash.answer(idA, 'answer for A')
    h.dash.answer(idB, 'answer for B')
    const callsBefore = h.dash.calls.length

    await a.link.pollOwnAsks()
    await b.link.pollOwnAsks()
    await a.link.pollOwnAsks()
    await b.link.pollOwnAsks()

    expect(a.notified).toEqual([{ content: framed('answer for A'), meta: { kind: 'answer', ask_id: String(idA), from: MAIN } }])
    expect(b.notified).toEqual([{ content: framed('answer for B'), meta: { kind: 'answer', ask_id: String(idB), from: MAIN } }])

    // Neither watcher even looked at the other session's ask.
    const later = h.dash.calls.slice(callsBefore)
    expect(later.some(c => c.who === '101' && c.path === `/api/messages/${idB}`)).toBe(false)
    expect(later.some(c => c.who === '102' && c.path === `/api/messages/${idA}`)).toBe(false)

    // Delivered asks leave asks.json; both are in their session's received list only.
    expect(a.link.deps.asks.read()).toEqual([])
    expect(a.link.received.map(r => r.id)).toEqual([idA])
    expect(b.link.received.map(r => r.id)).toEqual([idB])
    const inboxA = await a.link.callTool('tony_inbox')
    expect(inboxA.text).toContain('answer for A')
    expect(inboxA.text).not.toContain('answer for B')
  })
})

describe('rule 2: orphan asks are adopted by a NEW session only', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('new session adopts dead-pid asks at startup, delivers answered ones, keeps watching the rest', async () => {
    const id = fakeIdentity()
    const store = new AskStore(h.stateDir, id.folderKey)
    const answered = h.dash.insert({ from_agent: SENDER, to_agent: MAIN, content: '[Claude Code kérdés] q1' })
    const open = h.dash.insert({ from_agent: SENDER, to_agent: MAIN, content: '[Claude Code kérdés] q2' })
    const alivesAsk = h.dash.insert({ from_agent: SENDER, to_agent: MAIN, content: '[Claude Code kérdés] q3' })
    h.dash.answer(answered.id, 'late answer')
    h.dash.answer(alivesAsk.id, 'answer for the running session')
    h.alive.add(150) // a running session in the same folder
    await store.add(ask(answered.id, 999)) // dead
    await store.add(ask(open.id, 998)) // dead
    await store.add(ask(alivesAsk.id, 150)) // alive

    h.alive.add(200)
    const fresh = makeLink(h, { pid: 200, identity: id })
    await fresh.link.startup()

    expect(fresh.notified).toEqual([
      { content: framed('late answer'), meta: { kind: 'answer', ask_id: String(answered.id), from: MAIN } },
    ])
    const after = store.read()
    expect(after.find(a => a.id === answered.id)).toBeUndefined()
    expect(after.find(a => a.id === open.id)?.pid).toBe(200)
    expect(after.find(a => a.id === alivesAsk.id)?.pid).toBe(150)

    // The rest is still watched: answering later delivers it.
    h.dash.answer(open.id, 'even later')
    await fresh.link.pollOwnAsks()
    expect(fresh.notified.map(n => n.content)).toEqual([framed('late answer'), framed('even later')])
    expect(fresh.notified.some(n => n.content.includes('answer for the running session'))).toBe(false)
  })

  test('a running session never adopts, not even through tool calls or the watcher', async () => {
    const id = fakeIdentity()
    h.alive.add(300)
    const running = makeLink(h, { pid: 300, identity: id })
    await running.link.startup()

    const orphan = h.dash.insert({ from_agent: SENDER, to_agent: MAIN, content: '[Claude Code kérdés] q' })
    h.dash.answer(orphan.id, 'answer nobody owns yet')
    const store = new AskStore(h.stateDir, id.folderKey)
    await store.add(ask(orphan.id, 777)) // dead pid, appears while 300 is running

    await running.link.callTool('tony_inbox')
    await running.link.callTool('tony_note', { text: 'a note' })
    await running.link.pollOwnAsks()

    expect(running.notified).toEqual([])
    expect(store.read().find(a => a.id === orphan.id)?.pid).toBe(777)
  })
})

describe('rule 3: folder inbox is claimed only at startup', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('startup claims own-folder and abandoned rows; never unaddressed; skips others', async () => {
    const id = fakeIdentity('/work/repo-a')
    const other = fakeIdentity('/work/repo-b')
    const mine = h.dash.addInbox({ content: 'for A', origin_note: `claude-code repo-a@main ${addr(id.folderKey)}` })
    const theirs = h.dash.addInbox({ content: 'for B', origin_note: `claude-code repo-b@main ${addr(other.folderKey)}` })
    // A bare key (no folder: marker) does not address this folder.
    const substring = h.dash.addInbox({ content: 'substring only', origin_note: `see ${id.folderKey} ${addr(other.folderKey)}` })
    const unaddressed = h.dash.addInbox({ content: 'for anyone', origin_note: null })
    const abandoned = h.dash.addInbox({
      content: 'abandoned for A',
      origin_note: addr(id.folderKey),
      status: 'failed',
      result: ROUTER_ABANDON_REASON,
      failed_by: 'router',
    })
    const failedOther = h.dash.addInbox({ content: 'failed', origin_note: addr(id.folderKey), status: 'failed', result: 'boom' })
    const notMain = h.dash.insert({ from_agent: 'stranger', to_agent: 'laptop-cc', content: 'x', origin_note: addr(id.folderKey) })

    h.alive.add(400)
    const s = makeLink(h, { pid: 400, identity: id })
    await s.link.startup()

    const got = s.notified.map(n => Number(n.meta.msg_id))
    expect(got.sort()).toEqual([mine.id, abandoned.id].sort())
    expect(h.dash.rows.get(unaddressed.id)!.status).toBe('pending')
    for (const n of s.notified) {
      expect(n.meta).toEqual({ kind: 'inbox', msg_id: n.meta.msg_id!, from: MAIN })
    }
    expect(h.dash.rows.get(theirs.id)!.status).toBe('pending')
    expect(h.dash.rows.get(substring.id)!.status).toBe('pending')
    expect(h.dash.rows.get(failedOther.id)!.status).toBe('failed')
    expect(h.dash.rows.get(notMain.id)!.status).toBe('pending')
    expect(h.dash.puts().map(p => p.path).sort()).toEqual(
      [mine.id, abandoned.id].map(i => `/api/messages/${i}`).sort(),
    )
  })

  test('a running session does not claim through tool calls or the watcher; tony_inbox only peeks', async () => {
    const id = fakeIdentity()
    h.alive.add(500)
    const s = makeLink(h, { pid: 500, identity: id })
    await s.link.startup()
    h.dash.addInbox({ content: 'arrived later', origin_note: addr(id.folderKey) })

    const inbox = await s.link.callTool('tony_inbox')
    await s.link.callTool('tony_note', { text: 'note' })
    await s.link.pollOwnAsks()
    await s.link.callTool('tony_inbox')

    expect(inbox.text).toContain('folder inbox: 1 message(s) waiting')
    expect(s.notified).toEqual([])
    expect(h.dash.puts()).toEqual([])
  })
})

describe('rule 4: claiming', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('claim is PUT {"status":"done","result":...,"notify":false} with a JSON boolean, oldest first', async () => {
    const id = fakeIdentity()
    const newer = h.dash.addInbox({ content: 'second', origin_note: addr(id.folderKey), created_at: 2000 })
    const older = h.dash.addInbox({ content: 'first', origin_note: addr(id.folderKey), created_at: 1000 })
    h.alive.add(600)
    const s = makeLink(h, { pid: 600, identity: id })
    await s.link.startup()

    const puts = h.dash.puts()
    expect(puts.map(p => p.path)).toEqual([`/api/messages/${older.id}`, `/api/messages/${newer.id}`])
    for (const p of puts) {
      expect(p.body).toEqual({ status: 'done', result: `picked up by cc-link ${id.folderKey}`, notify: false })
      expect(typeof p.body.notify).toBe('boolean')
      expect(p.rawBody).toContain('"notify":false')
    }
    expect(s.notified.map(n => n.content)).toEqual([framed('first'), framed('second')])
    expect(s.link.received.map(r => [r.kind, r.id])).toEqual([
      ['inbox', older.id],
      ['inbox', newer.id],
    ])
  })

  test('two concurrent startups in one folder: each message is claimed exactly once', async () => {
    const id = fakeIdentity()
    const msgs = [1, 2, 3].map(i => h.dash.addInbox({ content: `m${i}`, origin_note: addr(id.folderKey) }))
    h.alive.add(701).add(702)
    const a = makeLink(h, { pid: 701, identity: id })
    const b = makeLink(h, { pid: 702, identity: id })
    await Promise.all([a.link.startup(), b.link.startup()])

    for (const m of msgs) {
      expect(h.dash.puts().filter(p => p.path === `/api/messages/${m.id}`).length).toBe(1)
    }
    const all = [...a.notified, ...b.notified].map(n => n.content).sort()
    expect(all).toEqual(['m1', 'm2', 'm3'].map(framed))
  })

  // M1: unaddressed messages are no longer delivered to any folder.
  test('two concurrent startups in DIFFERENT folders: an unaddressed message is never claimed', async () => {
    const m = h.dash.addInbox({ content: 'for anyone', origin_note: null })
    h.alive.add(711).add(712)
    const a = makeLink(h, { pid: 711, identity: fakeIdentity('/work/one') })
    const b = makeLink(h, { pid: 712, identity: fakeIdentity('/work/two') })
    await Promise.all([a.link.startup(), b.link.startup()])

    expect(h.dash.puts().filter(p => p.path === `/api/messages/${m.id}`).length).toBe(0)
    expect(a.notified.length + b.notified.length).toBe(0)
    expect(h.dash.rows.get(m.id)!.status).toBe('pending')
    const inbox = await a.link.callTool('tony_inbox')
    expect(inbox.text).toContain('unaddressed')
    expect(inbox.text).toContain(framed('for anyone').split('\n')[0]!)
  })

  test('a failed PUT means no delivery; the message stays for a later session', async () => {
    const id = fakeIdentity()
    const m = h.dash.addInbox({ content: 'try me', origin_note: addr(id.folderKey) })
    h.dash.override = c => (c.method === 'PUT' ? new Response('{"error":"db locked"}', { status: 500 }) : undefined)
    h.alive.add(800)
    const s = makeLink(h, { pid: 800, identity: id })
    await s.link.startup()
    expect(s.notified).toEqual([])
    expect(s.link.received).toEqual([])
    expect(h.dash.rows.get(m.id)!.status).toBe('pending')

    h.dash.override = undefined
    h.alive.add(801)
    const next = makeLink(h, { pid: 801, identity: id })
    await next.link.startup()
    expect(next.notified.map(n => n.content)).toEqual([framed('try me')])
  })
})
