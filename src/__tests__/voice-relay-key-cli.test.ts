// VOICEPROV1022: the voice relay key (a 'messages' key bound to the voice id) is
// never minted over HTTP -- every HTTP lane traces back to the shared token,
// which can create a dashboard user and log in as it (security review of PR #4). It
// is minted on the host by scripts/voice-relay-key.ts (logic: src/web/voice-relay-key.ts), the dashboard-user.ts
// break-glass pattern. These tests run the CLI's command function in-process
// on an in-memory DB (the app's db module has no path env, and the script's
// own entry point would open store/claudeclaw.db), with the owner notification
// captured instead of sent.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

// The fleet roster without a real agents/ tree; mutable so a test can create a
// real 'hanna' agent and watch the CLI refuse.
const ROSTER = vi.hoisted(() => new Set<string>(['neo']))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return { ...real, isKnownAgent: (name: string) => name === MAIN_AGENT_ID || ROSTER.has(name) }
})

import { initDatabase, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveDeviceKey, listDeviceKeys, _clearDeviceKeyCacheForTest, MESSAGES_KEY_MAX_EXPIRY_DAYS, MESSAGES_KEY_DEFAULT_EXPIRY_DAYS } from '../web/auth-device-keys.js'
import { resolveAuth } from '../web/auth-gate.js'
import { messagesGateDecision } from '../web/messages-gate.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import type { RouteContext } from '../web/routes/types.js'
import { runVoiceRelayKey, voiceRelayKeys, DEFAULT_NAME } from '../web/voice-relay-key.js'

const TOKEN = 'a'.repeat(64)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().exec('DELETE FROM device_keys')
  _clearDeviceKeyCacheForTest()
})

type Cli = { code: number; out: string; err: string; notices: string[] }

async function cli(argv: string[]): Promise<Cli> {
  let out = ''
  let err = ''
  const notices: string[] = []
  const code = await runVoiceRelayKey(argv, { out: s => { out += s }, err: s => { err += s } }, {
    notify: async (t) => { notices.push(t) },
    now: () => Math.floor(Date.now() / 1000),
  })
  return { code, out, err, notices }
}

const freshOut = () => join(mkdtempSync(join(tmpdir(), 'voice-relay-key-')), 'hanna.key')

function u(p: string): URL { return new URL(`http://localhost${p}`) }

async function postAs(auth: RouteContext['auth'], body: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { setHeader() { return res }, writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
  req.headers = { 'content-type': 'application/json' }
  const url = u('/api/messages')
  expect(await tryHandleMessages({ req, res, path: url.pathname, method: 'POST', url, fedPeer: null, auth } as RouteContext)).toBe(true)
  return out
}

describe('voice-relay-key mint', () => {
  it('writes the key ONLY to a new 0600 file, never to stdout/stderr, and announces the mint', async () => {
    const path = freshOut()
    const r = await cli(['mint', '--out', path])
    expect(r.code, r.err).toBe(0)
    const key = readFileSync(path, 'utf-8').trim()
    expect(key.length).toBeGreaterThan(20)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(r.out).not.toContain(key)
    expect(r.err).not.toContain(key)
    expect(r.notices.join('\n')).not.toContain(key)
    expect(r.out).toContain(DEFAULT_NAME)
    expect(r.out).toMatch(/#\d+/)
    expect(r.out).toMatch(/expires \d{4}-\d\d-\d\dT/)
    // Announced to the owner, and audited.
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]).toContain(VOICE_CHANNEL_AGENT_ID)
    const audit = getDb().prepare("SELECT new_value, actor FROM config_change_log WHERE key = 'security.voice_relay_key_minted' ORDER BY id DESC LIMIT 1").get() as { new_value: string; actor: string } | undefined
    expect(audit?.new_value).toMatch(/^id=\d+ /)
    expect(audit?.actor).toBe('cli')
  })

  it('the minted key resolves to scope messages / sender hanna, passes the gate and can POST from=hanna through the route', async () => {
    const path = freshOut()
    expect((await cli(['mint', '--out', path, '--days', '30', '--name', 'hf e2e'])).code).toBe(0)
    const key = readFileSync(path, 'utf-8').trim()
    _clearDeviceKeyCacheForTest()
    expect(resolveDeviceKey(key)).toMatchObject({ scope: 'messages', senderId: VOICE_CHANNEL_AGENT_ID })
    const auth = resolveAuth({ headers: { authorization: `Bearer ${key}` } } as any, u('/api/messages'), '/api/messages', 'POST', TOKEN)
    expect(auth).toMatchObject({ kind: 'device', scope: 'messages', senderId: VOICE_CHANNEL_AGENT_ID })
    expect(messagesGateDecision(auth as any, '/api/messages', 'POST', u('/api/messages'))).toBeNull()
    const out = await postAs(auth as RouteContext['auth'], { from: VOICE_CHANNEL_AGENT_ID, to: MAIN_AGENT_ID, content: '[HANG-FRONT delegation cli] szia' })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ from_agent: VOICE_CHANNEL_AGENT_ID })
    // Expiry follows --days.
    const k = voiceRelayKeys()[0]!
    expect(k.expiresAt! - k.createdAt).toBe(30 * 86400)
  })

  it('refuses an existing --out (never overwrites) and mints NOTHING', async () => {
    const path = freshOut()
    writeFileSync(path, 'precious')
    const r = await cli(['mint', '--out', path])
    expect(r.code).toBe(1)
    expect(r.err).toContain('already exists')
    expect(readFileSync(path, 'utf-8')).toBe('precious')
    expect(voiceRelayKeys()).toHaveLength(0)
    expect(r.notices).toHaveLength(0)
  })

  it('refuses --days above the max, 0, negative or non-numeric; the default is the messages-key default', async () => {
    for (const days of [String(MESSAGES_KEY_MAX_EXPIRY_DAYS + 1), '0', '-1', 'abc', '1.5']) {
      const path = freshOut()
      const r = await cli(['mint', '--out', path, '--days', days])
      expect(r.code, days).toBe(1)
      expect(existsSync(path), days).toBe(false)
    }
    expect(voiceRelayKeys()).toHaveLength(0)
    expect((await cli(['mint', '--out', freshOut(), '--days', String(MESSAGES_KEY_MAX_EXPIRY_DAYS), '--name', 'max'])).code).toBe(0)
    expect((await cli(['mint', '--out', freshOut(), '--name', 'default'])).code).toBe(0)
    const max = voiceRelayKeys().find(k => k.name === 'max')!
    expect(max.expiresAt! - max.createdAt).toBe(MESSAGES_KEY_MAX_EXPIRY_DAYS * 86400)
    const def = voiceRelayKeys().find(k => k.name === 'default')!
    expect(def.expiresAt! - def.createdAt).toBe(MESSAGES_KEY_DEFAULT_EXPIRY_DAYS * 86400)
  })

  it('--out is required; unknown or valueless arguments are a usage error', async () => {
    expect((await cli(['mint'])).code).toBe(2)
    expect((await cli(['mint', '--out'])).code).toBe(2)
    expect((await cli(['mint', '--out', freshOut(), '--sender', 'x'])).code).toBe(2)
    expect((await cli(['nope'])).code).toBe(2)
    expect(voiceRelayKeys()).toHaveLength(0)
  })

  it('warns on stderr when another unrevoked, unexpired voice key exists (and still mints)', async () => {
    expect((await cli(['mint', '--out', freshOut(), '--name', 'old relay'])).err).not.toContain('WARNING')
    const r = await cli(['mint', '--out', freshOut(), '--name', 'new relay'])
    expect(r.code).toBe(0)
    expect(r.err).toContain('WARNING')
    expect(r.err).toContain('old relay')
    expect(voiceRelayKeys()).toHaveLength(2)
  })

  it('refuses when a real fleet agent holds the voice id (the binding would impersonate it)', async () => {
    ROSTER.add(VOICE_CHANNEL_AGENT_ID)
    try {
      const path = freshOut()
      const r = await cli(['mint', '--out', path])
      expect(r.code).toBe(1)
      expect(r.err).toContain('Refused')
      expect(existsSync(path)).toBe(false)
      expect(listDeviceKeys()).toHaveLength(0)
    } finally {
      ROSTER.delete(VOICE_CHANNEL_AGENT_ID)
    }
  })
})

describe('voice-relay-key list', () => {
  it('lists the hanna-bound keys with id/name/created/expires/last used, and never a secret', async () => {
    const path = freshOut()
    await cli(['mint', '--out', path, '--name', 'listed relay'])
    const key = readFileSync(path, 'utf-8').trim()
    const r = await cli(['list'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('listed relay')
    expect(r.out).toMatch(/created \d{4}-/)
    expect(r.out).toMatch(/expires \d{4}-/)
    expect(r.out).toContain('last used')
    expect(r.out).not.toContain(key)
    expect(r.out).not.toMatch(/mvdk_|[A-Za-z0-9_-]{40,}/)
  })

  it('says so when there is none', async () => {
    expect((await cli(['list'])).out).toContain('No voice relay keys')
  })
})

describe('wiring', () => {
  it('is registered as an npm script', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))
    expect(pkg.scripts['voice-relay-key']).toBe('tsx scripts/voice-relay-key.ts')
  })
})

// Security re-review of PR #4: `npm run` runs the script from the package root, so a
// relative --out used to land in the checkout. It is now resolved against
// INIT_CWD (the operator's directory), and any target inside the install root
// is refused before a key exists.
describe('voice-relay-key mint: --out resolution', () => {
  async function cliAt(argv: string[], cwd: string, repoRoot: string): Promise<Cli> {
    let out = ''
    let err = ''
    const notices: string[] = []
    const code = await runVoiceRelayKey(argv, { out: s => { out += s }, err: s => { err += s } }, {
      notify: async (t) => { notices.push(t) },
      now: () => Math.floor(Date.now() / 1000),
      cwd: () => cwd,
      repoRoot,
    })
    return { code, out, err, notices }
  }

  it('a relative --out is resolved against the operator directory, not the package root', async () => {
    const opDir = mkdtempSync(join(tmpdir(), 'vrk-op-'))
    const repo = mkdtempSync(join(tmpdir(), 'vrk-repo-'))
    const r = await cliAt(['mint', '--out', 'hanna.key'], opDir, repo)
    expect(r.code).toBe(0)
    expect(existsSync(join(opDir, 'hanna.key'))).toBe(true)
    expect(existsSync(join(repo, 'hanna.key'))).toBe(false)
    expect(statSync(join(opDir, 'hanna.key')).mode & 0o777).toBe(0o600)
  })

  it('a target inside the install root is refused and nothing is minted (relative and absolute)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'vrk-repo-'))
    for (const argv of [['mint', '--out', 'hanna.key'], ['mint', '--out', join(repo, 'hanna.key')]]) {
      const r = await cliAt(argv, repo, repo)
      expect(r.code).toBe(1)
      expect(r.err).toContain('inside the install root')
      expect(existsSync(join(repo, 'hanna.key'))).toBe(false)
    }
    expect(voiceRelayKeys()).toHaveLength(0)
  })

  it('a missing parent directory is refused with a mkdir hint, nothing minted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'vrk-op-'))
    const repo = mkdtempSync(join(tmpdir(), 'vrk-repo-'))
    const r = await cliAt(['mint', '--out', join(base, 'nope', 'hanna.key')], base, repo)
    expect(r.code).toBe(1)
    expect(r.err).toContain('mkdir -p -m 700')
    expect(voiceRelayKeys()).toHaveLength(0)
  })

  it('a symlinked directory pointing into the install root is refused', async () => {
    const { symlinkSync, mkdirSync } = await import('node:fs')
    const repo = mkdtempSync(join(tmpdir(), 'vrk-repo-'))
    mkdirSync(join(repo, 'store'))
    const op = mkdtempSync(join(tmpdir(), 'vrk-op-'))
    symlinkSync(join(repo, 'store'), join(op, 'link'))
    const r = await cliAt(['mint', '--out', join(op, 'link', 'hanna.key')], op, repo)
    expect(r.code).toBe(1)
    expect(r.err).toContain('inside the install root')
    expect(existsSync(join(repo, 'store', 'hanna.key'))).toBe(false)
  })

  it('control: the default repo root is this checkout, so a path in it is refused without overrides', async () => {
    const target = join(process.cwd(), 'should-not-exist.key')
    const r = await cli(['mint', '--out', target])
    expect(r.code).toBe(1)
    expect(r.err).toContain('inside the install root')
    expect(existsSync(target)).toBe(false)
  })
})
