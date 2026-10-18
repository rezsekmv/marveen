import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { BASE_URL, DEVICE_KEY, MAIN, makeHarness, makeLink, SENDER, type Harness } from './helpers.ts'

const FULL = { MARVEEN_URL: BASE_URL, MARVEEN_DEVICE_KEY: DEVICE_KEY, MARVEEN_SENDER_ID: SENDER }

describe('config', () => {
  let h: Harness
  beforeEach(() => (h = makeHarness()))
  afterEach(() => h.cleanup())

  for (const name of ['MARVEEN_URL', 'MARVEEN_DEVICE_KEY', 'MARVEEN_SENDER_ID'] as const) {
    test(`missing ${name}: loadConfig does not throw; every tool errors naming it; nothing is fetched`, async () => {
      const env: Record<string, string | undefined> = { ...FULL, CC_LINK_STATE_DIR: h.stateDir }
      delete env[name]
      const cfg = loadConfig(env, [], h.dir)
      expect(cfg.errors.some(e => e.includes(name))).toBe(true)
      const s = makeLink(h, { pid: 2000, config: cfg })
      await s.link.startup() // must not throw
      for (const [tool, args] of [
        ['tony_note', { text: 'x' }],
        ['tony_ask', { question: 'x' }],
        ['tony_reply', { id: 1 }],
        ['tony_inbox', {}],
      ] as const) {
        const r = await s.link.callTool(tool, args)
        expect(r.isError).toBe(true)
        expect(r.text).toContain(name)
      }
      expect(h.dash.calls).toEqual([])
    })
  }

  test('MARVEEN_DEVICE_KEY is not required in dry run', () => {
    const cfg = loadConfig({ MARVEEN_URL: BASE_URL, MARVEEN_SENDER_ID: SENDER, CC_LINK_DRY_RUN: '1' }, [], h.dir)
    expect(cfg.errors).toEqual([])
    expect(loadConfig({ MARVEEN_URL: BASE_URL, MARVEEN_SENDER_ID: SENDER }, ['--dry-run'], h.dir).dryRun).toBe(true)
  })

  test('URL is validated and the trailing slash stripped', () => {
    expect(loadConfig({ ...FULL, MARVEEN_URL: 'http://h:3420/' }, [], h.dir).url).toBe('http://h:3420')
    const bad = loadConfig({ ...FULL, MARVEEN_URL: 'ftp://h' }, [], h.dir)
    expect(bad.errors.some(e => e.includes('MARVEEN_URL'))).toBe(true)
  })

  test('older dashboard (no whoami): main agent id comes from /api/team/graph (source: graph)', async () => {
    h.dash.mainAgentId = 'graph-main'
    const s = makeLink(h, { pid: 2001, env: { MARVEEN_MAIN_AGENT: 'env-main' } })
    await s.link.startup()
    const inbox = await s.link.callTool('tony_inbox')
    expect(inbox.text).toContain('main agent: graph-main (source: graph)')
    await s.link.callTool('tony_note', { text: 'hi' })
    expect(h.dash.posts()[0]!.body.to).toBe('graph-main')
    expect(h.dash.calls.some(c => c.path === '/api/team/graph')).toBe(true)
  })

  test('falls back to MARVEEN_MAIN_AGENT when the graph lookup fails (source: env)', async () => {
    h.dash.override = c => (c.path === '/api/team/graph' ? new Response('{"error":"x"}', { status: 500 }) : undefined)
    const s = makeLink(h, { pid: 2002, env: { MARVEEN_MAIN_AGENT: 'env-main' } })
    await s.link.startup()
    const inbox = await s.link.callTool('tony_inbox')
    expect(inbox.text).toContain('main agent: env-main (source: env)')
    await s.link.callTool('tony_note', { text: 'hi' })
    expect(h.dash.posts()[0]!.body.to).toBe('env-main')
  })

  test('falls back when the graph has no mainAgentId field', async () => {
    h.dash.mainAgentId = null
    const s = makeLink(h, { pid: 2003, env: { MARVEEN_MAIN_AGENT: MAIN } })
    await s.link.startup()
    expect((await s.link.callTool('tony_inbox')).text).toContain(`main agent: ${MAIN} (source: env)`)
  })

  test('both sources fail: sending returns an error, nothing is posted or queued', async () => {
    h.dash.override = c => (c.path === '/api/team/graph' ? 'network' : undefined)
    const s = makeLink(h, { pid: 2004 })
    await s.link.startup()
    const r = await s.link.callTool('tony_note', { text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('MARVEEN_MAIN_AGENT')
    expect(h.dash.posts()).toEqual([])
    expect(s.link.deps.outbox.count()).toBe(0)
  })
})

describe('server process with missing config', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cc-link-srv-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('starts, answers initialize, and a tool call errors naming the missing variable', async () => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('MARVEEN_') && !k.startsWith('CC_LINK_')) env[k] = v
    }
    env.HOME = dir
    env.CC_LINK_STATE_DIR = join(dir, 'state')
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'server.ts')], {
      cwd: dir,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const send = (msg: unknown) => proc.stdin.write(JSON.stringify(msg) + '\n')
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tony_note', arguments: { text: 'x' } } })
    await proc.stdin.flush()

    const reader = proc.stdout.getReader()
    const responses = new Map<number, any>()
    let buf = ''
    const deadline = Date.now() + 8000
    while (responses.size < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (typeof msg.id === 'number') responses.set(msg.id, msg)
      }
    }
    proc.stdin.end()
    proc.kill()
    await proc.exited

    const init = responses.get(1)
    expect(init?.result?.capabilities?.tools).toBeDefined()
    expect(init?.result?.capabilities?.experimental?.['claude/channel']).toEqual({})
    const call = responses.get(2)
    expect(call?.result?.isError).toBe(true)
    expect(call?.result?.content?.[0]?.text).toContain('MARVEEN_URL')
    expect(call?.result?.content?.[0]?.text).toContain('MARVEEN_DEVICE_KEY')
    expect(call?.result?.content?.[0]?.text).toContain('MARVEEN_SENDER_ID')
  }, 15000)
})
