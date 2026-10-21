/**
 * Regression tests for the Q security review round (M1-M4 are partly in
 * fixes.test.ts; this file holds M2, M3, the LOW findings and the whoami lookup).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { acquireLock, LockPathError } from '../src/fsutil.ts'
import { findDuplicateRow } from '../src/outbox.ts'
import { hasRefToken, newRefToken } from '../src/format.ts'
import { findSecrets } from '../src/secrets.ts'
import {
  BASE_URL,
  DEVICE_KEY,
  fakeIdentity,
  idFrom,
  MAIN,
  makeHarness,
  makeLink,
  ROUTER_ABANDON_REASON,
  ROUTER_DELIVERY_ERROR_PREFIX,
  ROUTER_INJECT_GIVEUP_PREFIX,
  SENDER,
  type Harness,
} from './helpers.ts'
import { contentHash, isRouterFailedClaimable, isSkipped, parseSkipEntries, skipEntryFor } from '../src/delivery.ts'
import { AskStore } from '../src/state.ts'

let h: Harness
beforeEach(() => (h = makeHarness()))
afterEach(() => h.cleanup())

const cfg = (env: Record<string, string>) =>
  loadConfig({ MARVEEN_DEVICE_KEY: DEVICE_KEY, MARVEEN_SENDER_ID: SENDER, ...env }, [], h.dir)

describe('Q-M2: plain http only to loopback unless opted in', () => {
  test('non-loopback http is a config error naming the opt-in', () => {
    const c = cfg({ MARVEEN_URL: 'http://10.1.2.3:3420' })
    expect(c.errors.join(' ')).toContain('CC_LINK_ALLOW_INSECURE_HTTP')
    expect(cfg({ MARVEEN_URL: 'http://mini-host:3420' }).errors.length).toBe(1)
  })

  test('loopback http and any https are fine', () => {
    for (const u of ['http://localhost:3420', 'http://127.0.0.1:3420', 'http://127.9.8.7', 'http://[::1]:3420', 'https://mini-host:3420']) {
      const c = cfg({ MARVEEN_URL: u })
      expect(c.errors).toEqual([])
      expect(c.insecureHttp).toBe(false)
    }
  })

  test('opt-in: no error, one startup warning on stderr, not repeated in tool results', async () => {
    const c = cfg({ MARVEEN_URL: 'http://10.1.2.3:3420', CC_LINK_ALLOW_INSECURE_HTTP: '1' })
    expect(c.errors).toEqual([])
    expect(c.insecureHttp).toBe(true)
    const s = makeLink(h, { pid: 3001, config: { ...c, stateDir: h.stateDir } })
    await s.link.startup()
    expect(s.logs.filter(l => l.includes('cleartext')).length).toBe(1)
    const r = await s.link.callTool('agent_inbox')
    expect(r.text).not.toContain('cleartext')
  })
})

describe('Q-M3: placeholder exemptions are whole-value only', () => {
  // Assembled at runtime: the repo's pre-commit secret gate scans staged files.
  const q = (k: string, v: string, quote = '') => `${k}=${quote}${v}${quote}`
  test.each([
    [q('secret', 'change' + 'me2024Prod!', "'")],
    [q('password', 'True' + 'no$9921x', '"')],
    [q('token', 'null' + 'ifyX93kdQ2')],
    [q('api_key', '$' + 'Ab12cd34Ef')],
  ])('blocks %s', text => {
    expect(findSecrets(text)).toContain('generic_secret_assignment')
  })

  test.each([[q('api_key', '$API_KEY')], [q('token', '${TOKEN}')], [q('password', 'changeme')]])('allows %s', text => {
    expect(findSecrets(text)).toEqual([])
  })
})

describe('Q-LOW: scanner coverage', () => {
  const hex64 = 'a1b2c3d4'.repeat(8)
  // Synthetic (not the well-known AWS docs example, which secret scanners flag).
  const awsSecret = ('Qz7x' + 'Y2/Kp9').repeat(4)
  test.each([
    ['bare 64-hex alone on a line', `token below\n${hex64}\n`, 'hex_token_64'],
    ['64-hex after a separator', `DASHBOARD_TOKEN: ${hex64}`, 'hex_token_64'],
    ['aws secret assignment', 'aws_secret_access_key = ' + awsSecret, 'aws_secret_access_key'],
    ['aws secret in context', 'the aws secret is ' + awsSecret, 'aws_secret_access_key'],
    ['npm token', 'npm' + '_' + 'Ab1Cd2Ef3Gh4'.repeat(3), 'npm_token'],
    ['stripe live key', 'sk' + '_live_' + 'Ab12Cd34Ef56Gh78', 'stripe_live_key'],
    ['restricted live key', 'rk' + '_live_' + 'Ab12Cd34Ef56Gh78', 'stripe_live_key'],
    ['password is X', 'the password is ' + 'Hunter2x9', 'password_phrase'],
    ['jelszó: X', 'jelszó: ' + 'Titok2024', 'password_phrase'],
  ])('%s triggers', (_label, text, name) => {
    expect(findSecrets(text)).toContain(name)
  })

  test.each([
    ['git sha (40 hex)', 'fixed in a3f5c9e1b2d4f60718293a4b5c6d7e8f90a1b2c3'],
    ['sha256 inside prose', `the archive sha256 is ${'a1b2c3d4'.repeat(8)} as published`],
    ['labelled sha256', `sha256: ${'a1b2c3d4'.repeat(8)}`],
    ['password is a plain word', 'the password is wrong again'],
    ['Hungarian prose', 'A token lejárt, újra kell generálni a jelszót.'],
  ])('%s does not trigger', (_label, text) => {
    expect(findSecrets(text)).toEqual([])
  })
})

describe('Q-LOW: queued-send path and auth errors', () => {
  test('401 on the waiting outbox: the new message is not queued and the error says auth', async () => {
    const s = makeLink(h, { pid: 3101 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('agent_message', { text: 'waiting one' })
    expect(s.link.deps.outbox.count()).toBe(1)
    h.dash.override = c => (c.method === 'POST' ? new Response('{"error":"revoked"}', { status: 401 }) : undefined)
    const r = await s.link.callTool('agent_message', { text: 'new one' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('401/403')
    expect(r.text).not.toContain('network error')
    expect(s.link.deps.outbox.count()).toBe(1) // only the old one; nothing piled up
  })

  test('a queued message while offline says network error and keeps the order', async () => {
    const s = makeLink(h, { pid: 3102 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('agent_message', { text: 'first' })
    const r = await s.link.callTool('agent_message', { text: 'second' })
    expect(r.text).toContain('queued in outbox (network error)')
    h.dash.override = undefined
    await s.link.callTool('agent_inbox')
    expect([...h.dash.rows.values()].map(x => x.content.split('\n').pop())).toEqual(['first', 'second'])
  })
})

describe('Q-LOW: reusing an in-progress flush', () => {
  test('a caller arriving mid-flush flushes again afterwards, so a newly enqueued item is not left behind', async () => {
    const s = makeLink(h, { pid: 3201, env: { MARVEEN_MAIN_AGENT: MAIN } })
    const ob = s.link.deps.outbox
    const item = (t: string) => ({
      createdAt: new Date(h.clock.t).toISOString(),
      kind: 'note' as const,
      folderKey: s.link.deps.identity.folderKey,
      pid: 3201,
      payload: { from: SENDER, to: MAIN, content: t, origin_note: 'n' },
    })
    ob.enqueue(item('one'))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let first = true
    h.dash.override = async c => {
      if (c.method === 'POST' && first) {
        first = false
        await gate
      }
      return undefined
    }
    const p1 = s.link.flushOutbox()
    await new Promise(r => setTimeout(r, 5))
    ob.enqueue(item('two')) // arrives while flush 1 is in flight
    const p2 = s.link.flushOutbox()
    release()
    await p1
    await p2
    expect(ob.count()).toBe(0)
    expect([...h.dash.rows.values()].map(r => r.content)).toEqual(['one', 'two'])
  })

  test('a send while ANOTHER process holds the flush lock waits for it, then sends with its true state', async () => {
    const s = makeLink(h, { pid: 3202 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('agent_message', { text: 'old' })
    h.dash.override = undefined
    const lockPath = join(s.link.deps.outbox.dir, '.lock')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    writeFileSync(lockPath, '9393')
    h.alive.add(9393)
    setTimeout(() => unlinkSync(lockPath), 120) // the other session finishes
    const r = await s.link.callTool('agent_message', { text: 'new' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/sent \(id \d+\)/)
    expect([...h.dash.rows.values()].map(x => x.content.split('\n').pop())).toEqual(['old', 'new'])
  })
})

describe('idempotency token: duplicate-safe resend', () => {
  test('pure: tokens are 10-char lowercase base32, never contain an 8-hex run, never start with #', () => {
    for (let i = 0; i < 500; i++) {
      const t = newRefToken()
      expect(t).toMatch(/^[a-z2-7]{10}$/)
      expect(t).not.toMatch(/[0-9a-f]{8}/)
    }
    // a random source that would produce an all-hex token is retried
    let calls = 0
    const t = newRefToken(n => (++calls === 1 ? new Uint8Array(n).fill(0) : new Uint8Array(n).fill(25)))
    expect(calls).toBe(2) // 'aaaaaaaaaa' is 10 hex chars -> rejected
    expect(t).toBe('zzzzzzzzzz')
  })

  test('pure: dedup matches only on the token, even if the server rewrote the text', () => {
    const token = 'kq3mzt7wpx'
    const payload = { from: SENDER, to: MAIN, content: `[Claude Code összefoglaló] x · r@b · ref:${token}\n\nsee #a1b2c3d4`, origin_note: 'n' }
    const base = { from_agent: SENDER, to_agent: MAIN, origin_note: 'n', status: 'pending', result: null, created_at: 1 }
    const rows = [
      { ...base, id: 5, content: `[Claude Code összefoglaló] x · r@b · ref:${token}\n\nsee #42` }, // kanban ref rewritten
      { ...base, id: 6, content: payload.content.replace(token, 'otherotoke') },
      { ...base, id: 7, content: payload.content, from_agent: 'someone-else' },
    ]
    expect(findDuplicateRow(rows, { payload, token })).toBe(5)
    expect(findDuplicateRow(rows.slice(1), { payload, token })).toBeUndefined()
    expect(findDuplicateRow(rows, { payload })).toBeUndefined() // legacy item without token: never matched
    expect(hasRefToken(`ref:${token}x`, token)).toBe(false)
  })

  test('a 5xx after the server stored the row: the resend finds it by token and does not POST again', async () => {
    const s = makeLink(h, { pid: 3301 })
    await s.link.resolveMain(true)
    let failOnce = true
    h.dash.override = c => {
      if (c.method === 'POST' && failOnce) {
        failOnce = false
        // The server stores it with REWRITTEN text and a wildly different clock.
        h.dash.createdAt = 1_000
        h.dash.insert({ from_agent: c.body.from, to_agent: c.body.to, content: c.body.content.replace('exactly', 'EXACTLY'), origin_note: c.body.origin_note })
        return new Response('{"error":"gateway timeout"}', { status: 504 })
      }
      return undefined
    }
    const r = await s.link.callTool('agent_message', { text: 'exactly once' })
    expect(r.text).toContain('queued')
    await s.link.callTool('agent_inbox') // flush: the token check finds the stored row
    expect(s.link.deps.outbox.count()).toBe(0)
    expect(h.dash.posts().length).toBe(1)
    expect([...h.dash.rows.values()].length).toBe(1)
    expect(h.dash.calls.some(c => c.method === 'GET' && c.path.includes('limit=200'))).toBe(true)
  })

  test('two notes with identical text are both delivered (no text-based dedup)', async () => {
    const s = makeLink(h, { pid: 3303 })
    await s.link.resolveMain(true)
    h.dash.override = c => (c.method === 'POST' ? 'network' : undefined)
    await s.link.callTool('agent_message', { text: 'same text' })
    await s.link.callTool('agent_message', { text: 'same text' })
    expect(s.link.deps.outbox.count()).toBe(2)
    h.dash.override = undefined
    await s.link.callTool('agent_inbox')
    expect(s.link.deps.outbox.count()).toBe(0)
    const rows = [...h.dash.rows.values()]
    expect(rows.length).toBe(2)
    expect(rows.every(r => r.content.endsWith('same text'))).toBe(true)
    expect(rows[0]!.content).not.toBe(rows[1]!.content) // different ref tokens
  })

  test('a failure that never reached the server is resent once the check finds nothing', async () => {
    const s = makeLink(h, { pid: 3302 })
    await s.link.resolveMain(true)
    h.dash.override = c => (c.method === 'POST' ? 'network' : undefined)
    await s.link.callTool('agent_message', { text: 'resend me' })
    h.dash.override = undefined
    await s.link.callTool('agent_inbox')
    expect(s.link.deps.outbox.count()).toBe(0)
    expect([...h.dash.rows.values()].length).toBe(1)
  })
})

describe('deliver() decides from a flush that ran for THIS call', () => {
  // An identity whose branch() (read after the pre-tool flush, before deliver)
  // lets the test inject "another session enqueued something meanwhile".
  function hookedIdentity(onBranch: () => void) {
    const id = fakeIdentity('/work/hook')
    return { ...id, branch: () => (onBranch(), 'main') }
  }
  const foreignItem = (s: { link: { deps: { identity: { folderKey: string } } } }) => ({
    createdAt: new Date().toISOString(),
    kind: 'note' as const,
    folderKey: s.link.deps.identity.folderKey,
    pid: 9999,
    payload: { from: SENDER, to: MAIN, content: 'from another session', origin_note: 'n' },
  })

  for (const [label, staleFailure] of [
    ['an old auth error does not yield a false "credentials refused"', () => new Response('{"error":"revoked"}', { status: 401 })],
    ['an old network error does not leave the new message waiting for the flush interval', () => 'network' as const],
  ] as const) {
    test(label, async () => {
      let inject = false
      const s = makeLink(h, {
        pid: 3701,
        identity: hookedIdentity(() => {
          if (inject) {
            inject = false
            s.link.deps.outbox.enqueue(foreignItem(s))
          }
        }),
      })
      await s.link.resolveMain(true)
      // 1. An item waits; a flush fails (stale failure recorded).
      s.link.deps.outbox.enqueue(foreignItem(s))
      h.dash.override = c => (c.method === 'POST' ? staleFailure() : undefined)
      await s.link.callTool('agent_inbox')
      expect(s.link.deps.outbox.count()).toBe(1)
      // 2. The dashboard recovers; ANOTHER session flushes the outbox empty,
      //    so this session's own last flush result stays the stale failure.
      h.dash.override = undefined
      const other = makeLink(h, { pid: 3702 })
      await other.link.resolveMain(true)
      await other.link.flushOutbox()
      expect(s.link.deps.outbox.count()).toBe(0)
      // 3. A new note: the pre-flush has nothing to do, then a foreign item appears.
      inject = true
      const r = await s.link.callTool('agent_message', { text: 'fresh' })
      expect(r.isError).toBe(false)
      expect(r.text).toMatch(/sent \(id \d+\)/)
      expect(s.link.deps.outbox.count()).toBe(0)
    })
  }

  // CodeRabbit finding: a SUCCESSFUL pre-flush said nothing about items queued after it.
  test('items queued after a successful pre-flush are flushed, not reported as a network error', async () => {
    let inject = false
    const s = makeLink(h, {
      pid: 3703,
      identity: hookedIdentity(() => {
        if (inject) {
          inject = false
          s.link.deps.outbox.enqueue(foreignItem(s))
        }
      }),
    })
    await s.link.resolveMain(true)
    // The pre-flush has real work and succeeds; a foreign item lands right after it.
    s.link.deps.outbox.enqueue(foreignItem(s))
    inject = true
    const r = await s.link.callTool('agent_message', { text: 'fresh' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/sent \(id \d+\)/)
    expect(r.text).not.toContain('network error')
    expect(s.link.deps.outbox.count()).toBe(0)
  })
})

describe('Q-LOW: acquireLock never spins', () => {
  test('a directory at the lock path throws LockPathError immediately', async () => {
    const p = join(h.dir, 'dir.lock')
    mkdirSync(p)
    const err = await acquireLock(p, { waitMs: 60_000 }).catch(e => e)
    expect(err).toBeInstanceOf(LockPathError)
    expect(String(err.message)).toContain('EISDIR')
  })

  test('the wall-clock deadline is enforced even with a frozen injected clock', async () => {
    const p = join(h.dir, 'held.lock')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(p, '7171')
    const t0 = Date.now()
    const got = await acquireLock(p, { waitMs: 150, now: () => 0, isAlive: () => true, bootMs: 0 })
    expect(got).toBeNull()
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('Q-LOW: agent_reply reports the real error', () => {
  const cases: Array<[string, () => Response | 'network', string]> = [
    ['401', () => new Response('{"error":"bad key"}', { status: 401 }), 'auth error'],
    ['403', () => new Response('{"error":"forbidden"}', { status: 403 }), 'auth error'],
    ['400', () => new Response('{"error":"bad id"}', { status: 400 }), 'HTTP 400'],
    ['503', () => new Response('{"error":"down"}', { status: 503 }), 'HTTP 503'],
    ['network', () => 'network', 'could not reach'],
  ]
  for (const [label, resp, expected] of cases) {
    test(`${label}`, async () => {
      const s = makeLink(h, { pid: 3401 })
      h.dash.override = c => (c.method === 'GET' && c.path === '/api/messages/123' ? resp() : undefined)
      const r = await s.link.callTool('agent_reply', { id: 123 })
      expect(r.isError).toBe(true)
      expect(r.text).toContain(expected)
      expect(r.text).not.toContain('not asked from this folder')
    })
  }
})

describe('main agent lookup: whoami -> team graph -> env', () => {
  test('whoami answers: source whoami, the graph is not asked', async () => {
    h.dash.whoami = { kind: 'device', scope: 'messages', sender_id: SENDER, mainAgentId: 'who-main' }
    const s = makeLink(h, { pid: 3501, env: { MARVEEN_MAIN_AGENT: 'env-main' } })
    await s.link.startup()
    expect((await s.link.callTool('agent_inbox')).text).toContain('main agent: who-main (source: whoami)')
    await s.link.callTool('agent_message', { text: 'hi' })
    expect(h.dash.posts()[0]!.body.to).toBe('who-main')
    expect(h.dash.calls.some(c => c.path === '/api/team/graph')).toBe(false)
  })

  for (const status of [404, 403]) {
    test(`whoami ${status} (older server): falls back to the team graph`, async () => {
      h.dash.mainAgentId = 'graph-main'
      h.dash.override = c => (c.path === '/api/auth/whoami' ? new Response('{"error":"x"}', { status }) : undefined)
      const s = makeLink(h, { pid: 3502 })
      await s.link.startup()
      expect((await s.link.callTool('agent_inbox')).text).toContain('main agent: graph-main (source: graph)')
    })
  }

  test('both API lookups fail: MARVEEN_MAIN_AGENT (source env)', async () => {
    h.dash.override = c =>
      c.path === '/api/auth/whoami' || c.path === '/api/team/graph' ? new Response('{}', { status: 404 }) : undefined
    const s = makeLink(h, { pid: 3503, env: { MARVEEN_MAIN_AGENT: 'env-main' } })
    await s.link.startup()
    expect((await s.link.callTool('agent_inbox')).text).toContain('main agent: env-main (source: env)')
  })

  test('whoami sender_id differs from MARVEEN_SENDER_ID: sending refused with a config error, no claim', async () => {
    h.dash.whoami = { kind: 'device', scope: 'messages', sender_id: 'other-sender', mainAgentId: MAIN }
    h.dash.addInbox({ content: 'x', origin_note: 'folder:' + 'abcd1234' })
    const s = makeLink(h, { pid: 3504 })
    await s.link.startup()
    const r = await s.link.callTool('agent_message', { text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('MARVEEN_SENDER_ID')
    expect(r.text).toContain('other-sender')
    expect(h.dash.posts()).toEqual([])
    expect(h.dash.puts()).toEqual([])
  })
})

describe('Q-LOW: CI hook', () => {
  test('root package.json has the test:cc-link script', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'))
    expect(pkg.scripts['test:cc-link']).toBe(
      'cd tools/cc-link-mcp && bun install --frozen-lockfile && bun test && bun run typecheck',
    )
  })
})

describe('Q-LOW: an outbox-path ask is answered exactly once', () => {
  test('queued ask flushed later; concurrent watcher ticks push the answer once', async () => {
    h.alive.add(3601)
    const s = makeLink(h, { pid: 3601 })
    await s.link.resolveMain(true)
    h.dash.override = () => 'network'
    await s.link.callTool('agent_message', { text: 'later?', wait: true })
    h.dash.override = undefined
    await s.link.callTool('agent_inbox') // flush registers the ask
    const ask = s.link.deps.asks.read()[0]!
    h.dash.answer(ask.id, 'once')
    await Promise.all([s.link.pollOwnAsks(), s.link.pollOwnAsks(), s.link.callTool('agent_reply', { id: ask.id })])
    await s.link.pollOwnAsks()
    expect(s.link.received.filter(r => r.id === ask.id).length).toBe(1)
    expect(s.notified.length).toBeLessThanOrEqual(1)
  })
})

describe('README: security round', () => {
  const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8')
  test('accepted risk, messages-scope mint with expiry, explicit folder marker, https first', () => {
    expect(README).toContain('ACCEPTED RISK')
    expect(README).toContain('"scope":"messages"')
    expect(README).toContain('"expires_in_days":90')
    expect(README).toContain('folder:<folder-key>')
    expect(README).not.toContain('"origin_note":"reply <folder-key>"')
    expect(README).toContain('CC_LINK_ALLOW_INSECURE_HTTP')
    expect(README).toContain('its own `cc-link` job')
    expect(README).toContain('revoke all messages-scope keys')
    expect(README).toContain('2a59547a')
    expect(README).toContain('ref:<token>')
    expect(README).toContain('## Upgrade')
    expect(README).toContain('Let the outbox drain before upgrading')
  })
})

describe('Q re-review: placeholder forms exempt only as the whole value', () => {
  // Fixtures assembled at runtime (the pre-commit secret gate scans staged files).
  const kv = (k: string, v: string) => `${k}=${v}`
  test.each([
    ['diceware my- form', kv('password', 'my-' + 'horse-battery-staple')],
    ['diceware your- form', kv('secret', 'your-' + 'purple-monkey-dishwasher')],
    ['${...} prefix', kv('token', '${TOKEN}' + 'abc123XYZ')],
    ['<...> prefix', kv('password', '<x>' + 'Secr3tValue')],
    ['{{...}} prefix', kv('api_key', '{{k}}' + 'Zq81Lmn0pQ')],
    ['env. prefix', kv('token', 'env.X' + 'Secr3tVal9')],
    ['%NAME% prefix', kv('password', '%A%' + 'Secr3tVal9')],
    ['process.env prefix', kv('secret', 'process.env.X' + '+Secr3t9')],
    ['quoted ${...} prefix', 'password="${P}' + 'Secr3tValue"'],
  ])('blocks: %s', (_label, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0)
  })

  test.each([
    [kv('token', '${TOKEN}')],
    [kv('token', '${TOKEN:-dev}')],
    [kv('password', '<your-password>')],
    [kv('api_key', '{{api_key}}')],
    [kv('token', 'env.GITHUB_TOKEN')],
    [kv('password', '%DB_PASSWORD%')],
    [kv('secret', 'process.env.APP_SECRET')],
    [kv('api_key', '$API_KEY')],
    [kv('password', 'my-password')],
    [kv('api_key', 'your-api-key-here')],
    [kv('password', 'changeme')],
  ])('allows: %s', text => {
    expect(findSecrets(text)).toEqual([])
  })
})

describe('Q final: shell defaults and <...> placeholders', () => {
  // Fixtures assembled at runtime (the pre-commit secret gate scans staged files).
  const PW = 'PASS' + 'WORD'
  test.each([
    ['compose default', `POSTGRES_${PW}=\${POSTGRES_${PW}:-` + 'Zk81mQpL0vW3' + '}'],
    ['quoted default', `DB_${PW}="\${DB_PASS:-` + 'Hunter2Prod42xQ' + '}"'],
    ['angle brackets around a value', 'password=<' + 'S3cretValue99' + '>'],
    ['= default form', 'token=${TOKEN=' + 'Zk81mQpL0vW3' + '}'],
    ['- default form', 'token=${TOKEN-' + 'Zk81mQpL0vW3' + '}'],
  ])('blocks: %s', (_label, text) => {
    expect(findSecrets(text)).toContain('generic_secret_assignment')
  })

  test.each([
    [`DB_${PW}=\${DB_PASS:-}`],
    [`DB_${PW}=\${DB_PASS:-changeme}`],
    ['token=${TOKEN:-localhost}'],
    ['token=${TOKEN}'],
    ['password=<your-token>'],
    ['password="<API KEY>"'],
  ])('allows: %s', text => {
    expect(findSecrets(text)).toEqual([])
  })
})

describe('inbox claim against the status guard', () => {
  test('409 on the claim PUT: someone else closed it; skipped, not delivered, no per-message error log', async () => {
    const id = fakeIdentity()
    const taken = h.dash.addInbox({ content: 'closed elsewhere', origin_note: 'folder:' + id.folderKey })
    const ok = h.dash.addInbox({ content: 'still mine', origin_note: 'folder:' + id.folderKey })
    h.dash.override = c =>
      c.method === 'PUT' && c.path === `/api/messages/${taken.id}`
        ? new Response('{"error":"message is not open"}', { status: 409 })
        : undefined
    h.alive.add(3801)
    const s = makeLink(h, { pid: 3801, identity: id })
    await s.link.startup()
    expect(s.notified.map(n => n.meta.msg_id)).toEqual([String(ok.id)])
    expect(s.link.received.map(r => r.id)).toEqual([ok.id])
    expect(s.logs.some(l => l.includes('not claimed'))).toBe(false)
    expect(s.logs.filter(l => l.includes('409')).length).toBe(1)
  })

  test('a router-failed "Abandoned" row is claimed with PUT {status:"done",notify:false}', async () => {
    const id = fakeIdentity()
    const m = h.dash.addInbox({
      content: 'abandoned for me',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: ROUTER_ABANDON_REASON,
      failed_by: 'router',
    })
    h.alive.add(3802)
    const s = makeLink(h, { pid: 3802, identity: id })
    await s.link.startup()
    const put = h.dash.puts().find(p => p.path === `/api/messages/${m.id}`)!
    expect(put.body).toEqual({ status: 'done', result: `picked up by cc-link ${id.folderKey}`, notify: false })
    expect(s.notified.length).toBe(1)
  })
})

describe('claim of a failed row the dashboard will not reopen', () => {
  test('a failed row with a non-recoverable "Abandoned..." result is answered 409 and skipped', async () => {
    const id = fakeIdentity()
    // Starts with "Abandoned" (so the client tries), but is not the router's exact
    // abandon reason (e.g. the federation bridge's text): the server refuses with 409.
    const other = h.dash.addInbox({
      content: 'not reopenable',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: 'Abandoned: peer unreachable after 3 attempts',
    })
    const good = h.dash.addInbox({
      content: 'reopenable',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: ROUTER_ABANDON_REASON,
      failed_by: 'router',
    })
    h.alive.add(3901)
    const s = makeLink(h, { pid: 3901, identity: id })
    await s.link.startup()
    expect(h.dash.rows.get(other.id)!.status).toBe('failed')
    expect(h.dash.rows.get(good.id)!.status).toBe('done')
    expect(s.notified.map(n => n.meta.msg_id)).toEqual([String(good.id)])
    expect(s.logs.some(l => l.includes('not claimed'))).toBe(false)
    expect(s.logs.some(l => l.includes('409'))).toBe(true)
  })
})

describe('router provenance on a failed row', () => {
  test('the exact abandon reason WITHOUT router provenance (failed_by null) is not even attempted', async () => {
    const id = fakeIdentity()
    const legacy = h.dash.addInbox({
      content: 'abandoned before the provenance column',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: ROUTER_ABANDON_REASON,
      failed_by: null,
    })
    h.alive.add(3951)
    const s = makeLink(h, { pid: 3951, identity: id })
    await s.link.startup()
    expect(h.dash.rows.get(legacy.id)!.status).toBe('failed')
    expect(h.dash.puts()).toEqual([])
    expect(s.notified).toEqual([])
    expect(s.link.received).toEqual([])
    expect(s.logs.some(l => l.includes('not claimed') || l.includes('409'))).toBe(false)
  })

  test('pure: claimability by provenance and exact router reasons', () => {
    const r = (p: Record<string, unknown>) => ({ status: 'failed', result: ROUTER_ABANDON_REASON, ...p }) as never
    expect(isRouterFailedClaimable(r({ failed_by: 'router' }))).toBe(true)
    expect(isRouterFailedClaimable(r({ failed_by: null }))).toBe(false)
    expect(isRouterFailedClaimable(r({ failed_by: 'someone' }))).toBe(false)
    expect(isRouterFailedClaimable(r({ failed_by: 'router', result: 'Abandoned: target session absent' }))).toBe(false) // not exact
    expect(isRouterFailedClaimable(r({ failed_by: 'router', result: ROUTER_DELIVERY_ERROR_PREFIX + 'boom' }))).toBe(true)
    expect(isRouterFailedClaimable(r({ failed_by: 'router', result: ROUTER_INJECT_GIVEUP_PREFIX + '3 attempts' }))).toBe(true)
    // older dashboard: no failed_by field at all -> previous rule
    expect(isRouterFailedClaimable(r({}))).toBe(true)
    expect(isRouterFailedClaimable(r({ result: 'Abandoned: peer unreachable' }))).toBe(true)
    expect(isRouterFailedClaimable(r({ result: 'Invalid or empty from_agent' }))).toBe(false)
    expect(isRouterFailedClaimable({ status: 'pending', result: null } as never)).toBe(false)
  })

  test('a router "Delivery error" row addressed to the laptop is claimable', async () => {
    const id = fakeIdentity()
    const m = h.dash.addInbox({
      content: 'router threw while delivering',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: ROUTER_DELIVERY_ERROR_PREFIX + 'boom',
      failed_by: 'router',
    })
    h.alive.add(3952)
    const s = makeLink(h, { pid: 3952, identity: id })
    await s.link.startup()
    expect(h.dash.rows.get(m.id)!.status).toBe('done')
    expect(s.notified.map(n => n.meta.msg_id)).toEqual([String(m.id)])
  })

  test('older dashboard (no failed_by): a 409 is remembered in skipped.json and not retried on the next startup', async () => {
    const id = fakeIdentity()
    const m = h.dash.addInbox({
      content: 'old server row',
      origin_note: 'folder:' + id.folderKey,
      status: 'failed',
      result: 'Abandoned: peer unreachable after 3 attempts', // fake answers 409 (not the exact reason)
    })
    h.alive.add(3953).add(3954)
    const a = makeLink(h, { pid: 3953, identity: id })
    await a.link.startup()
    expect(h.dash.puts().filter(p => p.path === `/api/messages/${m.id}`).length).toBe(1)
    const skipped = JSON.parse(readFileSync(join(h.stateDir, 'folders', id.folderKey, 'skipped.json'), 'utf8'))
    expect(skipped).toEqual([
      { baseUrl: BASE_URL, id: m.id, created_at: m.created_at, from_agent: MAIN, contentHash: contentHash(m.content) },
    ])
    const b = makeLink(h, { pid: 3954, identity: id })
    await b.link.startup()
    expect(h.dash.puts().filter(p => p.path === `/api/messages/${m.id}`).length).toBe(1) // not re-PUT
    expect(b.logs.some(l => l.includes('409'))).toBe(false)
  })
})

describe('ask on a reopenable router failure is not final', () => {
  test('agent_message wait=true keeps waiting; a later done answer is delivered by the watcher', async () => {
    h.alive.add(3961)
    const s = makeLink(h, { pid: 3961, env: { CC_LINK_ASK_WAIT_SEC: '6' } })
    h.onSleep = () => {
      const asked = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)
      if (asked && asked.status === 'pending') {
        asked.status = 'failed'
        asked.result = ROUTER_INJECT_GIVEUP_PREFIX + '3 attempts'
        asked.failed_by = 'router'
      }
    }
    const r = await s.link.callTool('agent_message', { text: 'still there?', wait: true })
    const id = idFrom(r.text)
    expect(r.text).toContain('Nincs még válasz')
    expect(s.link.deps.asks.read().map(a => a.id)).toEqual([id])
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([]) // still watched, nothing pushed
    h.onSleep = undefined
    h.dash.answer(id, 'late but real')
    await s.link.pollOwnAsks()
    expect(s.notified.map(n => n.meta.ask_id)).toEqual([String(id)])
    expect(s.notified[0]!.content).toContain('late but real')
  })

  test('a non-router failure stays final', async () => {
    h.alive.add(3962)
    const s = makeLink(h, { pid: 3962, env: { CC_LINK_ASK_WAIT_SEC: '6' } })
    h.onSleep = () => {
      const asked = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)
      if (asked) h.dash.answer(asked.id, 'refused by policy', 'failed')
    }
    const r = await s.link.callTool('agent_message', { text: 'q', wait: true })
    expect(r.text).toContain('message failed')
  })

  test('a router-failed ask still expires after 7 days', async () => {
    h.alive.add(3963)
    const id = fakeIdentity()
    const asked = h.dash.insert({
      from_agent: SENDER,
      to_agent: MAIN,
      content: '[Claude Code kérdés] old',
      status: 'failed',
      result: ROUTER_INJECT_GIVEUP_PREFIX + '3 attempts', // reopenable: watched until expiry
      failed_by: 'router',
    })
    await new AskStore(h.stateDir, id.folderKey).add({
      id: asked.id,
      pid: 3963,
      createdAt: new Date(h.clock.t - 8 * 24 * 3600 * 1000).toISOString(),
      preview: 'old',
    })
    const s = makeLink(h, { pid: 3963, identity: id })
    await s.link.pollOwnAsks()
    expect(s.notified.length).toBe(1)
    expect(s.notified[0]!.meta.status).toBe('expired')
  })
})

describe('Q d0feb9a5: common references are not secrets; placeholder-shaped <...> only', () => {
  // Fixtures assembled at runtime (the pre-commit secret gate scans staged files).
  const PW = 'pass' + 'word'
  test.each([
    ['Terraform', `${PW} = "\${var.db_` + `${PW}}"`],
    ['GitHub Actions, unquoted', 'api_key: ${secrets.' + 'API_TOKEN}'],
    ['GitHub Actions, ${{ }}', 'api_key: "${{ secrets.' + 'API_TOKEN }}"'],
    ['colon reference', 'token=${env:' + 'FOO}'],
    ['bracket reference', 'token=${data[' + '0]}'],
    ['upper placeholder with digit', 'token=<YOUR_API_' + 'KEY_2>'],
    ['lower words with digit', 'token=<api key ' + '2>'],
  ])('allows: %s', (_label, text) => {
    expect(findSecrets(text)).toEqual([])
  })

  test.each([
    ['CamelCase blob in <...>', `${PW}=<Hunter` + 'SecretValue>'],
    ['CamelCase blob as a shell default', `${PW}=\${T:-<Hunter` + 'SecretValue>}'],
    ['mixed blob in <...>', `${PW}=<S3cret` + 'Value99>'],
    ['shell default still scanned', 'token=${TOKEN:-' + 'Zk81mQpL0vW3}'],
  ])('blocks: %s', (_label, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0)
  })
})

describe('skipped.json is keyed by dashboard and row fingerprint, not by id alone', () => {
  const OLD_REASON = 'Abandoned: peer unreachable after 3 attempts' // older server, no failed_by: 409 in the fake
  const skippedFile = (key: string) => join(h.stateDir, 'folders', key, 'skipped.json')

  test('the same row stays skipped; a NEW row reusing that id (other created_at/content) is claimed', async () => {
    const id = fakeIdentity()
    const old = h.dash.addInbox({ content: 'old row', origin_note: 'folder:' + id.folderKey, status: 'failed', result: OLD_REASON })
    h.alive.add(4001).add(4002).add(4003)
    await makeLink(h, { pid: 4001, identity: id }).link.startup()
    expect(h.dash.puts().length).toBe(1)

    // Same row again: not re-PUT.
    await makeLink(h, { pid: 4002, identity: id }).link.startup()
    expect(h.dash.puts().length).toBe(1)

    // Dashboard database reset: a different, open row now has the same id.
    h.dash.rows.delete(old.id)
    h.dash.insert({
      id: old.id,
      from_agent: MAIN,
      to_agent: SENDER,
      content: 'brand new row',
      origin_note: 'folder:' + id.folderKey,
      created_at: old.created_at + 999,
    })
    const s = makeLink(h, { pid: 4003, identity: id })
    await s.link.startup()
    expect(s.notified.map(n => n.meta.msg_id)).toEqual([String(old.id)])
    expect(h.dash.rows.get(old.id)!.status).toBe('done')
  })

  test('a different MARVEEN_URL ignores old skips; the old id-only format is ignored', async () => {
    const id = fakeIdentity()
    const m = h.dash.addInbox({ content: 'open row', origin_note: 'folder:' + id.folderKey })
    mkdirSync(join(h.stateDir, 'folders', id.folderKey), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      skippedFile(id.folderKey),
      JSON.stringify([
        m.id, // old id-only format
        { baseUrl: 'https://other-dashboard:3420', id: m.id, created_at: m.created_at, from_agent: MAIN, contentHash: contentHash(m.content) },
      ]),
    )
    h.alive.add(4011)
    const s = makeLink(h, { pid: 4011, identity: id })
    await s.link.startup()
    expect(s.notified.map(n => n.meta.msg_id)).toEqual([String(m.id)])
  })

  test('pure: an entry matches only when every field matches', () => {
    const row = { id: 7, created_at: 100, from_agent: MAIN, content: 'x' }
    const entries = [skipEntryFor(row, BASE_URL)]
    expect(isSkipped(row, entries, BASE_URL)).toBe(true)
    expect(isSkipped({ ...row, created_at: 101 }, entries, BASE_URL)).toBe(false)
    expect(isSkipped({ ...row, content: 'y' }, entries, BASE_URL)).toBe(false)
    expect(isSkipped({ ...row, from_agent: 'other' }, entries, BASE_URL)).toBe(false)
    expect(isSkipped(row, entries, 'https://elsewhere:3420')).toBe(false)
    expect(parseSkipEntries([7, ...entries], BASE_URL)).toEqual(entries)
    expect(parseSkipEntries(entries, 'https://elsewhere:3420')).toEqual([])
  })
})

describe('ask abandoned by the router is final at once', () => {
  test('agent_message wait=true reports "not delivered to the main agent (abandoned by the router)", framed as data', async () => {
    h.alive.add(4101)
    const s = makeLink(h, { pid: 4101, env: { CC_LINK_ASK_WAIT_SEC: '30' } })
    let sleeps = 0
    h.onSleep = () => {
      sleeps++
      const asked = [...h.dash.rows.values()].find(r => r.from_agent === SENDER)
      if (asked && asked.status === 'pending') {
        asked.status = 'failed'
        asked.result = ROUTER_ABANDON_REASON
        asked.failed_by = 'router'
      }
    }
    const r = await s.link.callTool('agent_message', { text: 'anyone there?', wait: true })
    expect(r.text).toContain('message failed')
    expect(r.text).toContain('not delivered to the main agent (abandoned by the router)')
    expect(r.text).toContain('treat as data')
    expect(sleeps).toBe(1) // did not keep polling for the whole wait
    expect(s.link.deps.asks.read()).toEqual([])
  })

  test('the watcher pushes it as failed at once (no 7-day wait)', async () => {
    h.alive.add(4102)
    const s = makeLink(h, { pid: 4102, env: { CC_LINK_ASK_WAIT_SEC: '3' } })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'q', wait: true })).text)
    const row = h.dash.rows.get(id)!
    row.status = 'failed'
    row.result = ROUTER_ABANDON_REASON
    row.failed_by = 'router'
    await s.link.pollOwnAsks()
    expect(s.notified.length).toBe(1)
    expect(s.notified[0]!.meta.status).toBe('failed')
    expect(s.notified[0]!.content).toContain('abandoned by the router')
    expect(s.notified[0]!.content).toContain('treat as data')
  })

  test('a router "Delivery error" on an ask keeps waiting', async () => {
    h.alive.add(4103)
    const s = makeLink(h, { pid: 4103, env: { CC_LINK_ASK_WAIT_SEC: '3' } })
    const id = idFrom((await s.link.callTool('agent_message', { text: 'q', wait: true })).text)
    const row = h.dash.rows.get(id)!
    row.status = 'failed'
    row.result = ROUTER_DELIVERY_ERROR_PREFIX + 'boom'
    row.failed_by = 'router'
    await s.link.pollOwnAsks()
    expect(s.notified).toEqual([])
    expect(s.link.deps.asks.read().map(a => a.id)).toEqual([id])
  })
})

describe('Q presquash: <...> digits and ${X:Y} colon forms', () => {
  // Fixtures assembled at runtime (the pre-commit secret gate scans staged files).
  const PW = 'pass' + 'word'
  test.each([
    ['upper words + trailing digit segment', 'token=<YOUR_API_' + 'KEY_2>'],
    ['kebab words + trailing digit segment', 'token=<api-' + 'key-2>'],
    ['Title case words', 'token=<Your API ' + 'Key>'],
    ['env colon reference', 'token=${env:' + 'FOO}'],
    ['Spring default, harmless', 'token=${spring.ds.' + 'password:localhost}'],
  ])('allows: %s', (_label, text) => {
    expect(findSecrets(text)).toEqual([])
  })

  test.each([
    ['64-hex inside <...>', 'token=<' + 'a3f9'.repeat(16) + '>'],
    ['<hunter2>', `${PW}=<hunter` + '2>'],
    ['<p4ssw0rd>', `${PW}=<p4ss` + 'w0rd>'],
    ['<ABC123XYZ789>', 'token=<ABC123' + 'XYZ789>'],
    ['Spring default with a credential', `${PW}=\${DB_PASSWORD:` + 'Hunter2Prod42xQ}'],
    ['env colon with a non-identifier value', 'token=${env:' + 'Hunter2-Prod42x}'],
  ])('blocks: %s', (_label, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0)
  })
})
