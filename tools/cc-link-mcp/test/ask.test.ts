import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { addr, fakeIdentity, framed, idFrom, MAIN, makeHarness, makeLink, ROUTER_ABANDON_REASON, SENDER, type Harness } from './helpers.ts'

describe('agent_message wait=true', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  test('answer within the wait returns the result and clears the ask', async () => {
    h.alive.add(1001)
    const s = makeLink(h, { pid: 1001 })
    let sleeps = 0
    h.onSleep = () => {
      if (++sleeps === 2) {
        const asked = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)!
        h.dash.answer(asked.id, 'Igen, mehet.')
      }
    }
    const r = await s.link.callTool('agent_message', { text: 'Mehet a deploy?', wait: true })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Igen, mehet.')
    const post = h.dash.posts()[0]!
    expect(post.body.content.startsWith('[Claude Code kérdés] ')).toBe(true)
    expect(post.body.content).not.toContain('Nem kell válasz.')
    expect(post.body.content.endsWith('\n\nMehet a deploy?')).toBe(true)
    expect(s.link.deps.asks.read()).toEqual([])
    // Returned directly: no extra channel push.
    expect(s.notified).toEqual([])
  })

  test('header line format: [Claude Code kérdés] YYYY-MM-DD HH:MM · repo@branch · ref:<token>', async () => {
    const s = makeLink(h, { pid: 1002, identity: fakeIdentity('/work/myrepo', 'feat/x') })
    await s.link.callTool('agent_message', { text: 'q?', wait: true })
    const first = h.dash.posts()[0]!.body.content.split('\n')[0]
    expect(first).toMatch(/^\[Claude Code kérdés\] \d{4}-\d\d-\d\d \d\d:\d\d · myrepo@feat\/x · ref:[a-z2-7]{10}$/)
  })

  test('timeout returns the Hungarian no-answer text; the watcher delivers it later via notify', async () => {
    h.alive.add(1003)
    const s = makeLink(h, { pid: 1003 })
    const r = await s.link.callTool('agent_message', { text: 'Mikor lesz kész?', wait: true })
    expect(r.isError).toBe(false)
    const id = idFrom(r.text)
    expect(r.text).toContain(
      `Nincs még válasz (id ${id}). Később érkezik channel-értesítésként, vagy kérd le: agent_reply(${id}).`,
    )
    expect(s.link.deps.asks.read().map(a => [a.id, a.pid])).toEqual([[id, 1003]])

    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    h.dash.answer(id, 'Holnap.')
    await s.link.pollOwnAsks()
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([{ content: framed('Holnap.'), meta: { kind: 'answer', ask_id: String(id), from: MAIN } }])
    expect(s.link.deps.asks.read()).toEqual([])
  })

  test('a failed ask row returns the failure', async () => {
    const s = makeLink(h, { pid: 1004 })
    h.onSleep = () => {
      const asked = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)
      if (asked) h.dash.answer(asked.id, ROUTER_ABANDON_REASON, 'failed')
    }
    const r = await s.link.callTool('agent_message', { text: 'q', wait: true })
    expect(r.text).toContain('failed')
    expect(r.text).toContain('Abandoned')
  })

  test('agent_reply returns status + result for an id this folder asked', async () => {
    h.alive.add(1005)
    const s = makeLink(h, { pid: 1005 })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'q', wait: true })).text)
    const waiting = await s.link.callTool('agent_reply', { id })
    expect(waiting.isError).toBe(false)
    expect(waiting.text).toContain('status pending')
    h.dash.answer(id, 'the answer')
    const done = await s.link.callTool('agent_reply', { id })
    expect(done.isError).toBe(false)
    expect(done.text).toContain('status done')
    expect(done.text).toContain('the answer')
  })

  test('agent_reply refuses ids this folder did not ask', async () => {
    const other = makeLink(h, { pid: 1006, identity: fakeIdentity('/work/other') })
    const otherId = idFrom((await other.link.callTool('agent_message', { text: 'other folder q', wait: true })).text)
    h.dash.answer(otherId, 'secret-ish answer for the other folder')
    const inboxMsg = h.dash.addInbox({ content: 'from main', origin_note: addr(fakeIdentity().folderKey) })

    const s = makeLink(h, { pid: 1007 })
    for (const id of [otherId, inboxMsg.id]) {
      const r = await s.link.callTool('agent_reply', { id })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('not sent from this folder')
      expect(r.text).not.toContain('secret-ish answer')
    }
    // An id that does not exist is reported as such, not as "not asked from this folder".
    const missing = await s.link.callTool('agent_reply', { id: 99999 })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('not found')
  })

  test('input validation: empty and over-long text are errors and send nothing', async () => {
    const s = makeLink(h, { pid: 1008 })
    const empty = await s.link.callTool('agent_message', { text: '   ', wait: true })
    const long = await s.link.callTool('agent_message', { text: 'x'.repeat(8001) })
    const ok = await s.link.callTool('agent_message', { text: 'x'.repeat(8000) })
    expect(empty.isError).toBe(true)
    expect(long.isError).toBe(true)
    expect(ok.isError).toBe(false)
    expect(h.dash.posts().length).toBe(1)
  })
})
