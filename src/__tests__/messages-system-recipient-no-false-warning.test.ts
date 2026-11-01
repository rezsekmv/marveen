import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// POST /api/messages answers a send to a stopped LOCAL agent with a "not running, the message waits in the queue"
// warning. A SYSTEM_SENDER_IDS recipient (cc-link: a laptop's device sender id, e.g. mate-laptop) is exempt: it has
// no `agent-<name>` tmux session on this machine by definition, so isAgentRunning() reads it as stopped forever,
// while its client claims its rows over the API. Measured: msg 736 got targetRunning:false and the "start it" fix,
// yet the laptop claimed it. These run the real route with one listed system and a registered, stopped control.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  SYSTEM_SENDER_IDS: 'laptop-msgwarn-test',
}))

import { agentDir } from '../web/agent-config.js'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  const handled = await tryHandleMessages(ctx)
  expect(handled).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

const SYSTEM = 'laptop-msgwarn-test'
const STOPPED_AGENT = 'stopped-twin-agent-syswarn'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(agentDir(STOPPED_AGENT), { recursive: true })
  writeFileSync(join(agentDir(STOPPED_AGENT), 'agent-config.json'), JSON.stringify({}))
})
afterAll(() => {
  rmSync(agentDir(STOPPED_AGENT), { recursive: true, force: true })
})

describe('POST /api/messages to a SYSTEM_SENDER_IDS recipient (cc-link device sender)', () => {
  it('carries no "not running" warning and no queue-abandon fields: the device claims the row over the API', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: SYSTEM, content: 'hello laptop', origin_note: 'reply folder:ae2a5fc3' })
    expect(r.statusCode).toBe(200)
    expect(r.json.to_agent).toBe(SYSTEM)
    expect(r.json.status).toBe('pending')
    expect(r.json.warning).toBeUndefined()
    expect(r.json.targetRunning).toBeUndefined()
    expect(r.json.queued).toBeUndefined()
    expect(r.json.abandonAt).toBeUndefined()
  })

  it('CONTROL: a registered, stopped fleet agent still gets the queued warning (the exemption is system-ids only)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: STOPPED_AGENT, content: 'handoff' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect(r.json.queued).toBe(true)
    expect(String(r.json.warning)).toContain('SORBAN VÁR')
  })
})
