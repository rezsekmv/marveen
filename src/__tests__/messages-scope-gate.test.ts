// cc-link: a 'messages' scoped device key reaches its own mailbox (as ONE bound
// sender) and GET /api/auth/whoami, nothing else; it must expire; it cannot be
// bound to a fleet agent or a system identity. Full/operator keys, the token and
// sessions are untouched by the messages gate.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// 'laptop-cc' is the listed system sender the laptop link uses; 'cortex' is a
// second listed system, so "another listed sender" is a real case, not a typo.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  SYSTEM_SENDER_IDS: 'laptop-cc,cortex',
  OWNER_NAME: 'mate',
}))
// The fleet roster without a real agents/ tree: the main agent plus one
// sub-agent. Mutable, so a test can onboard an agent after a key was minted.
const ROSTER = vi.hoisted(() => new Set<string>(['neo']))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return { ...real, isKnownAgent: (name: string) => name === MAIN_AGENT_ID || ROSTER.has(name) }
})

import { initDatabase, getDb, createAgentMessage, markMessageDone, markMessageFailed, COMPLETION_REPORT_PREFIX } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { createDeviceKey, resolveDeviceKey, listDeviceKeys, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { resolveAuth, requiresAuth } from '../web/auth-gate.js'
import { messagesGateDecision, messagesKeyOwnsRow, messagesKeySender, isReservedSenderId, WHOAMI_PATH } from '../web/messages-gate.js'
import { operatorGateDecision } from '../web/operator-gate.js'
import { defaultOperatorAccess } from '../web/operator-access.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'
import { ROUTER_ABANDON_REASON, ROUTER_INJECT_GIVEUP_PREFIX, ROUTER_DELIVERY_ERROR_PREFIX, ROUTER_REFUSAL_PREFIX } from '../router-failure-reasons.js'

const TOKEN = 'a'.repeat(64)
const SENDER = 'laptop-cc'
const msgKey = { kind: 'device', scope: 'messages', senderId: SENDER, device: 'laptop', deviceId: 1 } as const
const owner = { kind: 'token' } as RouteContext['auth']

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => { _clearDeviceKeyCacheForTest() })

function u(pathAndQuery: string): URL {
  return new URL(`http://localhost${pathAndQuery}`)
}

function gate(auth: Parameters<typeof messagesGateDecision>[0], method: string, pathAndQuery: string): string | null {
  const url = u(pathAndQuery)
  return messagesGateDecision(auth, url.pathname, method, url)
}

function fakeCtx(method: string, pathAndQuery: string, body: unknown, auth: RouteContext['auth']) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  const url = u(pathAndQuery)
  return { ctx: { req, res, path: url.pathname, method, url, fedPeer: null, auth } as RouteContext, out }
}

async function run(handler: (c: RouteContext) => Promise<boolean>, method: string, pathAndQuery: string, body: unknown, auth: RouteContext['auth']) {
  const { ctx, out } = fakeCtx(method, pathAndQuery, body, auth)
  expect(await handler(ctx)).toBe(true)
  return out
}

// Same source scan as operator-scope-gate.test.ts: every /api path the server
// handles, so a route added later is covered without editing this list.
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!
        .replace(/\([^)]*\)/g, 'x')
        .replace(/\[[^\]]*\][+*]?/g, 'x')
        .replace(/\\\//g, '/')
        .replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

describe('messagesGateDecision', () => {
  it('lets a messages key reach exactly its allowlist', () => {
    expect(gate(msgKey, 'POST', '/api/messages')).toBeNull()
    expect(gate(msgKey, 'GET', `/api/messages?agent=${SENDER}`)).toBeNull()
    expect(gate(msgKey, 'GET', `/api/messages?agent=${SENDER}&status=pending`)).toBeNull()
    expect(gate(msgKey, 'GET', '/api/messages/42')).toBeNull()
    expect(gate(msgKey, 'PUT', '/api/messages/42')).toBeNull()
    expect(gate(msgKey, 'GET', WHOAMI_PATH)).toBeNull()
  })

  it('refuses every other enumerated /api path, on every method', () => {
    const paths = enumerateApiPaths()
    expect(paths.length).toBeGreaterThan(150)
    const allowed: string[] = []
    for (const p of paths) {
      for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
        // agent=<own sender> on every path: the query must not open anything but the list.
        if (gate(msgKey, m, `${p}?agent=${SENDER}`) === null) allowed.push(`${m} ${p}`)
      }
    }
    expect(allowed.sort()).toEqual([`GET ${WHOAMI_PATH}`, 'GET /api/messages', 'POST /api/messages'].sort())
  })

  it('refuses the sampled neighbours with the reason text', () => {
    for (const [m, p] of [
      ['GET', '/api/memories'], ['POST', '/api/memories'], ['GET', '/api/kanban'], ['GET', '/api/team/graph'],
      ['GET', '/api/agents'], ['GET', '/api/auth/device-keys'], ['POST', '/api/auth/device-keys'], ['GET', '/api/operator/status'],
      ['GET', '/api/messages/threads'], ['GET', '/api/messages/backlog'], ['DELETE', '/api/messages/42'], ['GET', '/api/network-info'],
      ['GET', '/api/agents/neo/pane/stream'], ['GET', '/api/messages/'], ['GET', '/api/messages/42/x'],
    ] as const) {
      expect(gate(msgKey, m, p), `${m} ${p}`).toBe('messages credential: not a message endpoint')
    }
  })

  it('the mailbox list: no agent=, a foreign agent=, a near-miss or a second agent= is 403', () => {
    for (const q of ['', '?status=pending', '?agent=neo', `?agent=${MAIN_AGENT_ID}`, '?agent=cortex', `?agent=${SENDER.toUpperCase()}`, `?agent=%20${SENDER}`, `?agent=${SENDER}&agent=neo`, `?agent=neo&agent=${SENDER}`]) {
      expect(gate(msgKey, 'GET', `/api/messages${q}`), q).toBe('messages credential: only its own mailbox (agent=<bound sender>)')
    }
  })

  it('a messages principal without a bound sender is refused everywhere, whoami included', () => {
    const unbound = { kind: 'device', scope: 'messages' }
    for (const [m, p] of [['GET', WHOAMI_PATH], ['POST', '/api/messages'], ['GET', '/api/messages/1']] as const) {
      expect(gate(unbound, m, p)).toBe('messages credential: no bound sender')
    }
  })

  it('every other credential passes untouched (full/operator keys, token, session, federation)', () => {
    for (const auth of [{ kind: 'token' }, { kind: 'session' }, { kind: 'federation' }, { kind: 'device', scope: 'full' }, { kind: 'device', scope: 'operator' }]) {
      expect(gate(auth, 'GET', '/api/memories')).toBeNull()
      expect(gate(auth, 'GET', '/api/messages')).toBeNull()
    }
  })

  it('the operator gate does not let a messages key through either way (they are independent fences)', () => {
    expect(operatorGateDecision(msgKey, '/api/memories', () => ({ ...defaultOperatorAccess(), enabled: true }))).toBeNull()
    expect(gate(msgKey, 'GET', '/api/operator/status')).not.toBeNull()
  })

  it('row ownership: the bound sender on either end, nothing else; other credentials always own', () => {
    expect(messagesKeyOwnsRow(msgKey, { from_agent: SENDER, to_agent: MAIN_AGENT_ID })).toBe(true)
    expect(messagesKeyOwnsRow(msgKey, { from_agent: MAIN_AGENT_ID, to_agent: SENDER })).toBe(true)
    expect(messagesKeyOwnsRow(msgKey, { from_agent: 'neo', to_agent: MAIN_AGENT_ID })).toBe(false)
    expect(messagesKeyOwnsRow({ kind: 'device', scope: 'messages' }, { from_agent: SENDER, to_agent: SENDER })).toBe(false)
    expect(messagesKeyOwnsRow({ kind: 'device', scope: 'full' }, { from_agent: 'neo', to_agent: MAIN_AGENT_ID })).toBe(true)
    expect(messagesKeyOwnsRow(undefined, { from_agent: 'neo', to_agent: MAIN_AGENT_ID })).toBe(true)
  })
})

describe('the gate binding in web.ts', () => {
  const SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
  it('runs inside the requiresAuth block, after the operator gate and before ANY handler', () => {
    const operator = SRC.indexOf('operatorGateDecision(auth, path, () => readOperatorAccess())')
    const messages = SRC.indexOf('messagesGateDecision(auth, path, method, url)')
    const networkInfo = SRC.indexOf("if (path === '/api/network-info' && method === 'GET')")
    const firstHandler = SRC.indexOf('if (await tryHandleAuth(routeCtx)) return')
    expect(operator).toBeGreaterThan(0)
    expect(messages).toBeGreaterThan(operator)
    expect(messages).toBeLessThan(networkInfo)
    expect(messages).toBeLessThan(firstHandler)
    // Same 403 shape as the operator gate.
    expect(SRC.slice(messages, messages + 400)).toContain("res.end(JSON.stringify({ error: 'Forbidden for this credential', reason: messagesDenied }))")
  })

  it('whoami is gated (requiresAuth), so an anonymous caller gets the 401', () => {
    expect(requiresAuth(WHOAMI_PATH, 'GET')).toBe(true)
  })
})

describe('messages device keys (storage and resolution)', () => {
  it('the scope and the sender travel from the stored key to the gate, across a cache drop', () => {
    const k = createDeviceKey('laptop', { scope: 'messages', senderId: SENDER, expiresInDays: 30 })
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(k.key)).toMatchObject({ scope: 'messages', senderId: SENDER })
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    const auth = resolveAuth(req, u('/api/messages'), '/api/messages', 'GET', TOKEN)
    expect(auth).toMatchObject({ kind: 'device', scope: 'messages', senderId: SENDER })
    const listed = listDeviceKeys().find(x => x.id === k.id)
    expect(listed).toMatchObject({ scope: 'messages', senderId: SENDER })
  })

  it('a full key carries no senderId (shape unchanged)', () => {
    const k = createDeviceKey('phone')
    expect(resolveDeviceKey(k.key)).toEqual({ id: k.id, name: 'phone', scope: 'full' })
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    expect(resolveAuth(req, u('/api/vault'), '/api/vault', 'GET', TOKEN)).toEqual({ kind: 'device', device: 'phone', deviceId: k.id, scope: 'full' })
    expect(listDeviceKeys().find(x => x.id === k.id)?.senderId).toBeNull()
  })

  it('a stray sender_id on a full row never surfaces as an identity', () => {
    const k = createDeviceKey('phone2')
    getDb().prepare('UPDATE device_keys SET sender_id = ? WHERE id = ?').run(SENDER, k.id)
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(k.key)).toEqual({ id: k.id, name: 'phone2', scope: 'full' })
  })

  it('the invariants hold below the route too', () => {
    expect(() => createDeviceKey('l', { scope: 'messages', senderId: SENDER })).toThrow(/must expire/)
    expect(() => createDeviceKey('l', { scope: 'messages', senderId: SENDER, expiresInDays: 366 })).toThrow(/at most 365 days/)
    expect(() => createDeviceKey('l', { scope: 'messages', expiresInDays: 30 })).toThrow(/bound to a sender/)
    expect(() => createDeviceKey('l', { scope: 'full', senderId: SENDER })).toThrow(/only a messages key/)
  })

  it('an expired messages key does not authenticate (the request gets the 401)', () => {
    const k = createDeviceKey('laptop-old', { scope: 'messages', senderId: SENDER, expiresInDays: 1 })
    getDb().prepare('UPDATE device_keys SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, k.id)
    _clearDeviceKeyCacheForTest()
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    expect(resolveAuth(req, u('/api/messages'), '/api/messages', 'POST', TOKEN)).toEqual({ kind: 'none' })
    expect(requiresAuth('/api/messages', 'POST')).toBe(true)
  })
})

describe('POST /api/auth/device-keys with scope messages', () => {
  const mint = (body: Record<string, unknown>) => run(tryHandleAuth, 'POST', '/api/auth/device-keys', body, owner)

  it('mints with a 90-day default, returns the sender, and no warning for a listed sender', async () => {
    const out = await mint({ name: 'laptop', scope: 'messages', sender_id: SENDER })
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ scope: 'messages', sender_id: SENDER })
    expect(out.body.warning).toBeUndefined()
    expect((out.body.expires_at - out.body.created_at) / 86400).toBe(90)
    expect(String(out.body.key)).toMatch(/^mvdk_/)
  })

  it('warns (not refuses) when the sender is not in SYSTEM_SENDER_IDS yet', async () => {
    const out = await mint({ name: 'laptop2', scope: 'messages', sender_id: 'laptop-two' })
    expect(out.status).toBe(201)
    expect(String(out.body.warning)).toContain('SYSTEM_SENDER_IDS')
  })

  it('explicit no-expiry is 400; 365 is fine, 366 is 400', async () => {
    for (const expires of [0, null]) {
      expect((await mint({ name: 'l', scope: 'messages', sender_id: SENDER, expires_in_days: expires })).status).toBe(400)
    }
    expect((await mint({ name: 'l', scope: 'messages', sender_id: SENDER, expires_in_days: 365 })).status).toBe(201)
    expect((await mint({ name: 'l', scope: 'messages', sender_id: SENDER, expires_in_days: 366 })).status).toBe(400)
  })

  it('a missing, empty or malformed sender_id is 400', async () => {
    for (const sender_id of [undefined, '', '   ', 42, null, 'laptop cc', 'laptop.cc', '@laptop', 'a/b', 'x'.repeat(65)]) {
      const out = await mint({ name: 'l', scope: 'messages', ...(sender_id === undefined ? {} : { sender_id }) })
      expect(out.status, String(sender_id)).toBe(400)
    }
  })

  it('reserved sender ids are 400: directive sender, coordinator, voice, main agent, heartbeat, owner, any fleet agent (any case)', async () => {
    for (const sender_id of ['system', 'System', 'telegram-coordinator', 'hanna', MAIN_AGENT_ID, MAIN_AGENT_ID.toUpperCase(), 'heartbeat', 'mate', 'neo', 'NEO']) {
      const out = await mint({ name: 'l', scope: 'messages', sender_id })
      expect(out.status, sender_id).toBe(400)
      expect(String(out.body.error)).toContain('reserved')
    }
  })

  it('a sender_id on any other scope is 400', async () => {
    expect((await mint({ name: 'p', sender_id: SENDER })).status).toBe(400)
    expect((await mint({ name: 'p', scope: 'full', sender_id: SENDER })).status).toBe(400)
    expect((await mint({ name: 'p', scope: 'operator', sender_id: SENDER })).status).toBe(400)
  })

  it('a messages key cannot list or mint keys (the gate refuses it; the handler allowlist does too)', async () => {
    expect(gate(msgKey, 'GET', '/api/auth/device-keys')).not.toBeNull()
    expect((await run(tryHandleAuth, 'GET', '/api/auth/device-keys', undefined, msgKey as RouteContext['auth'])).status).toBe(403)
  })
})

describe('GET /api/auth/whoami', () => {
  it('a messages key: kind, scope, device, sender_id and mainAgentId, nothing else', async () => {
    const out = await run(tryHandleAuth, 'GET', WHOAMI_PATH, undefined, msgKey as RouteContext['auth'])
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ kind: 'device', scope: 'messages', device: 'laptop', sender_id: SENDER, mainAgentId: MAIN_AGENT_ID })
  })

  it('the token, a session and a full key: no sender_id, no user, still the main agent id', async () => {
    expect((await run(tryHandleAuth, 'GET', WHOAMI_PATH, undefined, owner)).body).toEqual({ kind: 'token', mainAgentId: MAIN_AGENT_ID })
    expect((await run(tryHandleAuth, 'GET', WHOAMI_PATH, undefined, { kind: 'session', user: 'mate' })).body).toEqual({ kind: 'session', mainAgentId: MAIN_AGENT_ID })
    expect((await run(tryHandleAuth, 'GET', WHOAMI_PATH, undefined, { kind: 'device', scope: 'full', device: 'phone', deviceId: 3 })).body)
      .toEqual({ kind: 'device', scope: 'full', device: 'phone', mainAgentId: MAIN_AGENT_ID })
  })
})

describe('the message routes under a messages key', () => {
  const auth = msgKey as RouteContext['auth']

  it('POST as the bound sender to the main agent lands', async () => {
    const out = await run(tryHandleMessages, 'POST', '/api/messages', { from: SENDER, to: MAIN_AGENT_ID, content: 'hello from the laptop' }, auth)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ from_agent: SENDER, to_agent: MAIN_AGENT_ID })
  })

  it('POST with any other from is 403, a listed system sender and the main agent included', async () => {
    for (const from of ['cortex', MAIN_AGENT_ID, 'neo', `${SENDER}x`, SENDER.toUpperCase(), `@${SENDER}`]) {
      const out = await run(tryHandleMessages, 'POST', '/api/messages', { from, to: MAIN_AGENT_ID, content: 'x' }, auth)
      expect(out.status, from).toBe(403)
    }
  })

  it('POST with urgent:true is 403 (urgent needs a FULL listed key)', async () => {
    const out = await run(tryHandleMessages, 'POST', '/api/messages', { from: SENDER, to: MAIN_AGENT_ID, content: 'x', urgent: true }, auth)
    expect(out.status).toBe(403)
    expect(String(out.body.error)).toContain('urgent')
  })

  it('GET/PUT of its own row (either end) works; a foreign row is 403 and stays untouched; a missing row is 404', async () => {
    const inbound = createAgentMessage(MAIN_AGENT_ID, SENDER, 'answer for the laptop')
    const foreign = createAgentMessage('neo', MAIN_AGENT_ID, 'not the laptop\'s business')

    const getOwn = await run(tryHandleMessages, 'GET', `/api/messages/${inbound.id}`, undefined, auth)
    expect(getOwn.status).toBe(200)
    expect(getOwn.body.id).toBe(inbound.id)

    const getForeign = await run(tryHandleMessages, 'GET', `/api/messages/${foreign.id}`, undefined, auth)
    expect(getForeign.status).toBe(403)
    expect(getForeign.body.error).toBe('Forbidden for this credential')

    const putForeign = await run(tryHandleMessages, 'PUT', `/api/messages/${foreign.id}`, { status: 'done', notify: false }, auth)
    expect(putForeign.status).toBe(403)
    expect((getDb().prepare('SELECT status FROM agent_messages WHERE id = ?').get(foreign.id) as { status: string }).status).toBe('pending')

    const putOwn = await run(tryHandleMessages, 'PUT', `/api/messages/${inbound.id}`, { status: 'done', notify: false }, auth)
    expect(putOwn.status).toBe(200)
    expect((getDb().prepare('SELECT status FROM agent_messages WHERE id = ?').get(inbound.id) as { status: string }).status).toBe('done')

    expect((await run(tryHandleMessages, 'GET', '/api/messages/999999', undefined, auth)).status).toBe(404)
    expect((await run(tryHandleMessages, 'PUT', '/api/messages/999999', { status: 'done' }, auth)).status).toBe(404)
  })

  it('GET of its own mailbox returns only rows it is on', async () => {
    createAgentMessage('neo', MAIN_AGENT_ID, 'background traffic')
    const out = await run(tryHandleMessages, 'GET', `/api/messages?agent=${SENDER}`, undefined, auth)
    expect(out.status).toBe(200)
    expect(out.body.length).toBeGreaterThan(0)
    for (const row of out.body) expect([row.from_agent, row.to_agent]).toContain(SENDER)
  })

  it('the token lane is unchanged: a foreign row, any from, no ownership check', async () => {
    const foreign = createAgentMessage('neo', MAIN_AGENT_ID, 'token may read this')
    expect((await run(tryHandleMessages, 'GET', `/api/messages/${foreign.id}`, undefined, owner)).status).toBe(200)
    expect((await run(tryHandleMessages, 'POST', '/api/messages', { from: 'neo', to: MAIN_AGENT_ID, content: 'x' }, owner)).status).toBe(200)
  })
})

describe('rollback safety: an unknown stored scope denies', () => {
  it('a key whose scope this build does not know does not authenticate, and lists as unknown', () => {
    const k = createDeviceKey('future', { scope: 'messages', senderId: SENDER, expiresInDays: 30 })
    getDb().prepare("UPDATE device_keys SET scope = 'messages-v2' WHERE id = ?").run(k.id)
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(k.key)).toBeNull()
    const req: any = { headers: { authorization: `Bearer ${k.key}` } }
    expect(resolveAuth(req, u('/api/operator/status'), '/api/operator/status', 'GET', TOKEN)).toEqual({ kind: 'none' })
    expect(listDeviceKeys().find(x => x.id === k.id)?.scope).toBe('unknown')
  })

  it('the three known scopes still resolve as themselves', () => {
    for (const [scope, opts] of [['full', {}], ['operator', { expiresInDays: 5 }], ['messages', { expiresInDays: 5, senderId: SENDER }]] as const) {
      const k = createDeviceKey(`k-${scope}`, { scope, ...opts })
      _clearDeviceKeyCacheForTest()
      expect(resolveDeviceKey(k.key)?.scope).toBe(scope)
    }
  })
})

describe('isReservedSenderId, shared by mint and every use', () => {
  it('covers the system identities (both coordinator ids included), the owner and the roster, any case', () => {
    for (const id of ['system', 'telegram-coordinator', 'channel-coordinator', 'Channel-Coordinator', 'hanna', 'heartbeat', MAIN_AGENT_ID, 'mate', 'neo', 'NEO']) {
      expect(isReservedSenderId(id), id).toBe(true)
    }
    expect(isReservedSenderId(SENDER)).toBe(false)
    expect(isReservedSenderId('cortex')).toBe(false)
  })

  it('channel-coordinator is refused at mint', async () => {
    const out = await run(tryHandleAuth, 'POST', '/api/auth/device-keys', { name: 'l', scope: 'messages', sender_id: 'channel-coordinator' }, owner)
    expect(out.status).toBe(400)
  })

  it('an agent onboarded AFTER the mint under the key\'s id cuts the key off everywhere', async () => {
    const later = { kind: 'device', scope: 'messages', senderId: 'cortex', device: 'laptop2', deviceId: 2 } as const
    const auth = later as RouteContext['auth']
    // Before onboarding: a valid listed system sender, the key works.
    expect(gate(later, 'GET', '/api/messages?agent=cortex')).toBeNull()
    expect((await run(tryHandleMessages, 'POST', '/api/messages', { from: 'cortex', to: MAIN_AGENT_ID, content: 'before' }, auth)).status).toBe(200)
    const row = createAgentMessage(MAIN_AGENT_ID, 'cortex', 'to the laptop')

    ROSTER.add('cortex')
    try {
      expect(messagesKeySender(later)).toBeNull()
      for (const [m, p] of [['POST', '/api/messages'], ['GET', '/api/messages?agent=cortex'], ['GET', `/api/messages/${row.id}`], ['PUT', `/api/messages/${row.id}`], ['GET', WHOAMI_PATH]] as const) {
        expect(gate(later, m, p), `${m} ${p}`).toBe('messages credential: its bound sender is now a reserved id')
      }
      // The route-level checks agree even without the gate in front.
      expect((await run(tryHandleMessages, 'POST', '/api/messages', { from: 'cortex', to: MAIN_AGENT_ID, content: 'after' }, auth)).status).toBe(403)
      expect((await run(tryHandleMessages, 'GET', `/api/messages/${row.id}`, undefined, auth)).status).toBe(403)
      expect((await run(tryHandleMessages, 'PUT', `/api/messages/${row.id}`, { status: 'done' }, auth)).status).toBe(403)
      expect(messagesKeyOwnsRow(later, row)).toBe(false)
    } finally {
      ROSTER.delete('cortex')
    }
  })
})

describe('closing a message (security re-review M1)', () => {
  const reverseRows = (id: number) =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages WHERE content LIKE ?').get(`${COMPLETION_REPORT_PREFIX} msg_id:${id} %`) as { c: number }).c

  it('a messages key PUT with notify:true writes no reverse [Eredmény] row', async () => {
    const inbound = createAgentMessage(MAIN_AGENT_ID, SENDER, 'answer for the laptop')
    const out = await run(tryHandleMessages, 'PUT', `/api/messages/${inbound.id}`, { status: 'done', result: 'forged report', notify: true }, msgKey as RouteContext['auth'])
    expect(out.status).toBe(200)
    expect(reverseRows(inbound.id)).toBe(0)
    // Same row shape closed by the token with notify:true DOES notify (the lane is unchanged).
    const other = createAgentMessage(MAIN_AGENT_ID, SENDER, 'another answer for the laptop')
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${other.id}`, { status: 'done', result: 'ok', notify: true }, owner)).status).toBe(200)
    expect(reverseRows(other.id)).toBe(1)
  })

  it('a double close: the second is a 409 and writes no second [Eredmény]', async () => {
    const task = createAgentMessage(MAIN_AGENT_ID, 'neo', 'do the thing')
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${task.id}`, { status: 'done', result: 'first' }, owner)).status).toBe(200)
    expect(reverseRows(task.id)).toBe(1)
    for (const status of ['done', 'failed']) {
      const again = await run(tryHandleMessages, 'PUT', `/api/messages/${task.id}`, { status, result: 'second' }, owner)
      expect(again.status).toBe(409)
      expect(again.body).toMatchObject({ error: 'Message already closed', status: 'done' })
    }
    expect(reverseRows(task.id)).toBe(1)
    const row = getDb().prepare('SELECT status, result FROM agent_messages WHERE id = ?').get(task.id) as { status: string; result: string }
    expect(row).toEqual({ status: 'done', result: 'first' })
  })

  it('an invalid status on an existing row keeps the old 404 shape', async () => {
    const task = createAgentMessage(MAIN_AGENT_ID, 'neo', 'x')
    const out = await run(tryHandleMessages, 'PUT', `/api/messages/${task.id}`, { status: 'bogus' }, owner)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('Message not found or invalid status')
  })

  it('the closers are status-guarded: abandon after a done claim does not flip it to failed', () => {
    const m = createAgentMessage(MAIN_AGENT_ID, 'neo', 'y')
    expect(markMessageDone(m.id, 'agent finished')).toBe(true)
    expect(markMessageFailed(m.id, 'Abandoned: target session absent for full retry window')).toBe(false)
    expect(markMessageDone(m.id, 'again')).toBe(false)
    const row = getDb().prepare('SELECT status, result FROM agent_messages WHERE id = ?').get(m.id) as { status: string; result: string }
    expect(row).toEqual({ status: 'done', result: 'agent finished' })

    const f = createAgentMessage(MAIN_AGENT_ID, 'neo', 'z')
    expect(markMessageFailed(f.id, 'first failure')).toBe(true)
    expect(markMessageDone(f.id, 'late done')).toBe(false)
    expect((getDb().prepare('SELECT status FROM agent_messages WHERE id = ?').get(f.id) as { status: string }).status).toBe('failed')
  })

  it('a delivered row still closes (the drain-inbox and router paths need it)', () => {
    const d = createAgentMessage(MAIN_AGENT_ID, 'neo', 'w')
    getDb().prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), d.id)
    expect(markMessageFailed(d.id, 'Invalid or empty from_agent')).toBe(true)
  })
})

describe('a late real done on a row the ROUTER failed (final security review M1)', () => {
  const reverseRows = (id: number) =>
    (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages WHERE content LIKE ?').get(`${COMPLETION_REPORT_PREFIX} msg_id:${id} %`) as { c: number }).c
  const rowOf = (id: number) => getDb().prepare('SELECT status, result FROM agent_messages WHERE id = ?').get(id) as { status: string; result: string | null }
  // Failed BY THE ROUTER (failed_by = 'router'), as message-router.ts does.
  const routerFailed = (to: string, reason: string) => {
    const m = createAgentMessage(MAIN_AGENT_ID, to, `task for ${to}`)
    expect(markMessageFailed(m.id, reason, { by: 'router' })).toBe(true)
    return m
  }
  const ROUTER_REASONS = [
    ['abandon', ROUTER_ABANDON_REASON],
    ['inject give-up', `${ROUTER_INJECT_GIVEUP_PREFIX}3 attempts`],
    ['delivery error', `${ROUTER_DELIVERY_ERROR_PREFIX}Error: classify exploded`],
  ] as const

  for (const [label, reason] of ROUTER_REASONS) {
    it(`${label}: PUT done lands once, acks like a normal close, a second PUT is 409`, async () => {
      const m = routerFailed('neo', reason)
      const first = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'done', result: 'did it after all' }, owner)
      expect(first.status).toBe(200)
      expect(rowOf(m.id)).toEqual({ status: 'done', result: 'did it after all' })
      // Reopened in the same statement that clears the provenance: a done row no longer looks router-failed.
      expect((getDb().prepare('SELECT failed_by FROM agent_messages WHERE id = ?').get(m.id) as { failed_by: string | null }).failed_by).toBeNull()
      expect(reverseRows(m.id)).toBe(1)
      const second = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'done', result: 'again' }, owner)
      expect(second.status).toBe(409)
      expect(rowOf(m.id).result).toBe('did it after all')
      expect(reverseRows(m.id)).toBe(1)
    })

    it(`${label}: failed -> failed stays refused`, async () => {
      const m = routerFailed('neo', reason)
      const out = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'failed', result: 'x' }, owner)
      expect(out.status).toBe(409)
      expect(rowOf(m.id)).toEqual({ status: 'failed', result: reason })
    })
  }

  it('a failed row with any other result stays 409 even with router provenance (refusals, directives, federation, look-alikes)', async () => {
    for (const reason of [
      'Invalid or empty from_agent',
      'system-directive: not injected (busy)',
      'system-directive: tmux inject threw: x',
      'Abandoned: peer unreachable for full retry window',
      `${ROUTER_REFUSAL_PREFIX}PathTraversalError: Path traversal rejected: ../x`,
      `${ROUTER_ABANDON_REASON} (extra)`,
      'could not do it',
      'Delivery error',
      'Failed to inject into tmux session afterwards',
      'delivery error: lower case',
      '%',
    ]) {
      const m = routerFailed('neo', reason)
      const out = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'done', result: 'late' }, owner)
      expect(out.status, reason).toBe(409)
      expect(rowOf(m.id)).toEqual({ status: 'failed', result: reason })
    }
    const noResult = createAgentMessage(MAIN_AGENT_ID, 'neo', 'n')
    expect(markMessageFailed(noResult.id, undefined, { by: 'router' })).toBe(true)
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${noResult.id}`, { status: 'done' }, owner)).status).toBe(409)
  })

  it('cc-link: a messages key claims an abandoned row to its sender with notify:false, and nothing is written back', async () => {
    const m = routerFailed(SENDER, ROUTER_ABANDON_REASON)
    const out = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'done', notify: false }, msgKey as RouteContext['auth'])
    expect(out.status).toBe(200)
    expect(rowOf(m.id).status).toBe('done')
    expect(reverseRows(m.id)).toBe(0)
    // notify:true from the key is still forced off on this path.
    const m2 = routerFailed(SENDER, ROUTER_ABANDON_REASON)
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${m2.id}`, { status: 'done', notify: true }, msgKey as RouteContext['auth'])).status).toBe(200)
    expect(reverseRows(m2.id)).toBe(0)
    // ...and a key still cannot claim an abandoned row that is not its own.
    const foreign = routerFailed('neo', ROUTER_ABANDON_REASON)
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${foreign.id}`, { status: 'done' }, msgKey as RouteContext['auth'])).status).toBe(403)
    expect(rowOf(foreign.id).status).toBe('failed')
  })

  it('provenance is the failed_by column, not the text: a PUT failed with a router-looking result cannot be reopened', async () => {
    for (const reason of [ROUTER_ABANDON_REASON, `${ROUTER_INJECT_GIVEUP_PREFIX}3 attempts`, `${ROUTER_DELIVERY_ERROR_PREFIX}x`]) {
      const m = createAgentMessage(MAIN_AGENT_ID, 'neo', 'forge me')
      expect((await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'failed', result: reason, notify: false }, owner)).status).toBe(200)
      expect((getDb().prepare('SELECT failed_by FROM agent_messages WHERE id = ?').get(m.id) as { failed_by: string | null }).failed_by).toBeNull()
      const out = await run(tryHandleMessages, 'PUT', `/api/messages/${m.id}`, { status: 'done', result: 'reversed' }, owner)
      expect(out.status, reason).toBe(409)
      expect(rowOf(m.id)).toEqual({ status: 'failed', result: reason })
    }
  })

  it('the router close records failed_by = router; a plain markMessageFailed does not', () => {
    const r = routerFailed('neo', ROUTER_ABANDON_REASON)
    expect((getDb().prepare('SELECT failed_by FROM agent_messages WHERE id = ?').get(r.id) as { failed_by: string | null }).failed_by).toBe('router')
    const p = createAgentMessage(MAIN_AGENT_ID, 'neo', 'p')
    expect(markMessageFailed(p.id, ROUTER_ABANDON_REASON)).toBe(true)
    expect((getDb().prepare('SELECT failed_by FROM agent_messages WHERE id = ?').get(p.id) as { failed_by: string | null }).failed_by).toBeNull()
  })

  it('a row the router failed BEFORE the failed_by column (NULL) is not reopenable, by design', async () => {
    const old = createAgentMessage(MAIN_AGENT_ID, SENDER, 'pre-migration abandon')
    getDb().prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?, failed_by = NULL WHERE id = ?")
      .run(ROUTER_ABANDON_REASON, Math.floor(Date.now() / 1000), old.id)
    expect((await run(tryHandleMessages, 'PUT', `/api/messages/${old.id}`, { status: 'done', notify: false }, msgKey as RouteContext['auth'])).status).toBe(409)
    expect(rowOf(old.id).status).toBe('failed')
  })
})
