/**
 * CC-Link 2 item 8: a folder:<key> message reaches EVERY session running in
 * that folder right away; with none running it waits for the next new one.
 * The row is claimed (closed on the dashboard) once, by whichever session
 * sees it first; the others get it from broadcast.json.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from '../src/fsutil.ts'
import { SessionRegistry } from '../src/state.ts'
import { addr, fakeIdentity, framed, makeHarness, makeLink, type Harness } from './helpers.ts'

describe('folder messages to running sessions', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  async function running(pid: number, folder = '/work/repo-a') {
    h.alive.add(pid)
    const s = makeLink(h, { pid, identity: fakeIdentity(folder) })
    await s.link.startup()
    return s
  }

  test('two running sessions: the first tick claims it once, BOTH show it, the hand-out is cleaned up', async () => {
    const a = await running(9001)
    const b = await running(9002)
    const m = h.dash.addInbox({ content: 'to the folder', origin_note: addr(a.link.deps.identity.folderKey) })

    await a.link.pollFolderInbox()
    expect(h.dash.puts().filter(p => p.path === `/api/messages/${m.id}`).length).toBe(1)
    expect(h.dash.rows.get(m.id)!.status).toBe('done')
    expect(a.notified).toEqual([{ content: framed('to the folder'), meta: { kind: 'inbox', msg_id: String(m.id), from: 'main-agent' } }])
    expect(a.link.deps.broadcast.read().map(e => [e.id, e.recipients])).toEqual([[m.id, [9002]]])

    await b.link.pollFolderInbox()
    expect(b.notified).toEqual(a.notified)
    expect(b.link.received.map(r => [r.kind, r.id, r.status])).toEqual([['inbox', m.id, 'done']])
    expect(b.link.deps.broadcast.read()).toEqual([])
    // No second claim from B, and nothing repeats on later ticks.
    await a.link.pollFolderInbox()
    await b.link.pollFolderInbox()
    expect(h.dash.puts().length).toBe(1)
    expect(a.notified.length + b.notified.length).toBe(2)
  })

  test('pull mode (no channel): the other session sees it on its next tool call via the status line', async () => {
    const a = await running(9011)
    const b = await running(9012)
    h.dash.addInbox({ content: 'heads up', origin_note: addr(a.link.deps.identity.folderKey) })
    await a.link.pollFolderInbox()

    const r = await b.link.callTool('agent_message', { text: 'still working' })
    expect(r.text).toContain('1 received item(s) not yet shown: call agent_inbox')
    const inbox = await b.link.callTool('agent_inbox')
    expect(inbox.text).toContain(framed('heads up').split('\n')[0]!)
    expect(inbox.text).toContain('heads up')
  })

  test('no session running: the row stays pending and the next new session claims it', async () => {
    const id = fakeIdentity('/work/repo-a')
    const m = h.dash.addInbox({ content: 'for later', origin_note: addr(id.folderKey) })
    expect(h.dash.rows.get(m.id)!.status).toBe('pending')
    const c = await running(9021)
    expect(c.notified.map(n => n.content)).toEqual([framed('for later')])
    expect(c.link.deps.broadcast.read()).toEqual([])
  })

  test('a session in another folder neither claims nor receives it', async () => {
    const a = await running(9031, '/work/repo-a')
    const other = await running(9032, '/work/repo-b')
    h.dash.addInbox({ content: 'only A', origin_note: addr(a.link.deps.identity.folderKey) })
    await other.link.pollFolderInbox()
    expect(h.dash.puts()).toEqual([])
    await a.link.pollFolderInbox()
    await other.link.pollFolderInbox()
    expect(other.notified).toEqual([])
    expect(a.notified.length).toBe(1)
  })

  test('the recipients are the sessions running at claim time: a session started later does not get it', async () => {
    const a = await running(9041)
    h.dash.addInbox({ content: 'early', origin_note: addr(a.link.deps.identity.folderKey) })
    await a.link.pollFolderInbox()
    const late = await running(9042)
    await late.link.pollFolderInbox()
    expect(late.notified).toEqual([])
  })

  test('an exited session is not a recipient; a recipient that dies before taking it is pruned', async () => {
    const a = await running(9051)
    const b = await running(9052)
    const c = await running(9053)
    b.link.stopBackground() // clean exit: unregistered
    h.alive.delete(9052)
    h.dash.addInbox({ content: 'x', origin_note: addr(a.link.deps.identity.folderKey) })
    await a.link.pollFolderInbox()
    expect(a.link.deps.broadcast.read()[0]!.recipients).toEqual([9053])

    h.alive.delete(9053) // crashed before its tick
    await a.link.receiveBroadcasts()
    expect(a.link.deps.broadcast.read()).toEqual([])
    expect(c.notified).toEqual([])
  })

  test('a tick never waits for the inbox lock: another session holding it skips the round', async () => {
    const a = await running(9061)
    h.dash.addInbox({ content: 'busy', origin_note: addr(a.link.deps.identity.folderKey) })
    h.alive.add(9999)
    const held = await acquireLock(a.link.inboxLockPath, { pid: 9999, isAlive: p => h.alive.has(p), waitMs: 0 })
    expect(held).not.toBeNull()
    const t0 = Date.now()
    await a.link.pollFolderInbox()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(a.notified).toEqual([])
    expect(a.logs.some(l => l.includes('inbox poll'))).toBe(false)
    held!.release()
    await a.link.pollFolderInbox()
    expect(a.notified.map(n => n.content)).toEqual([framed('busy')])
  })

  test('a tick lists pending rows only (the 200-row conversation scan stays at startup)', async () => {
    const a = await running(9071)
    const before = h.dash.calls.length
    await a.link.pollFolderInbox()
    const tickCalls = h.dash.calls.slice(before).map(c => c.path)
    expect(tickCalls.every(p => p.includes('status=pending'))).toBe(true)
  })

  test('the registry ignores dead pids and sessions registered before the last boot', () => {
    const reg = new SessionRegistry(h.stateDir, 'abcd1234')
    const boot = Date.parse('2026-10-21T08:00:00Z')
    reg.register(1, '2026-10-21T09:00:00Z')
    reg.register(2, '2026-10-21T07:00:00Z') // before the boot: pid reused
    reg.register(3, '2026-10-21T09:00:00Z') // dead
    writeFileSync(join(reg.dir, 'junk.json'), '{}')
    expect(reg.alive(p => p !== 3, boot)).toEqual([1])
    expect(existsSync(join(reg.dir, '2.json'))).toBe(false)
    expect(existsSync(join(reg.dir, '3.json'))).toBe(false)
  })
})
