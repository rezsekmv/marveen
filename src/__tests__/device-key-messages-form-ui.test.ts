// Settings > Security > Device keys: the "Messages only" key type (cc-link).
// Pins the shipped buildDeviceKeyRequestBody() (evaluated from web/app.js, not
// a copy) against the POST /api/auth/device-keys contract: the full key keeps
// its old body, a messages key sends scope + sender_id + a bounded expiry, and
// the client-side checks mirror the server's (constants and the sender-id
// charset) so they can never refuse what the server would accept.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  isKnownAgent: () => false,
}))

import { validateMessagesSenderId, SENDER_ID_MAX } from '../web/messages-gate.js'
import { MESSAGES_KEY_DEFAULT_EXPIRY_DAYS, MESSAGES_KEY_MAX_EXPIRY_DAYS } from '../web/auth-device-keys.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

function appConst(name: string): number {
  const m = new RegExp(`^const ${name} = (\\d+)$`, 'm').exec(APP)
  if (!m) throw new Error(`const ${name} missing from web/app.js`)
  return Number(m[1])
}

const CONSTS = ['MESSAGES_KEY_DEFAULT_EXPIRY_DAYS', 'MESSAGES_KEY_MAX_EXPIRY_DAYS', 'DEVICE_KEY_SENDER_ID_MAX']
  .map((n) => `const ${n} = ${appConst(n)};`).join('\n')

type Built = { error?: string; params?: Record<string, unknown>; body?: Record<string, unknown> }
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const build = new Function(`${CONSTS}\n${extractFn('buildDeviceKeyRequestBody')}; return buildDeviceKeyRequestBody`)() as (
  fields: Record<string, unknown>,
) => Built

describe('buildDeviceKeyRequestBody', () => {
  it('a full key keeps the old body: name, optional expiry, no scope, no sender', () => {
    expect(build({ type: 'full', name: ' MacBook ', expiry: '', sender: 'ignored' })).toEqual({ body: { name: 'MacBook' } })
    expect(build({ type: 'full', name: 'Phone', expiry: '3650' })).toEqual({ body: { name: 'Phone', expires_in_days: 3650 } })
  })

  it('a name is required for either type', () => {
    expect(build({ type: 'full', name: '  ' }).error).toBe('auth.devices.err_name')
    expect(build({ type: 'messages', name: '', sender: 'laptop' }).error).toBe('auth.devices.err_name')
  })

  it('a messages key sends scope, the trimmed sender id and the expiry', () => {
    expect(build({ type: 'messages', name: 'Laptop', sender: ' laptop-cc ', expiry: '90' })).toEqual({
      body: { name: 'Laptop', scope: 'messages', sender_id: 'laptop-cc', expires_in_days: 90 },
    })
  })

  it('an empty expiry is left to the server default (90), never sent as 0 or null', () => {
    const r = build({ type: 'messages', name: 'Laptop', sender: 'laptop', expiry: '' })
    expect(r.body).toEqual({ name: 'Laptop', scope: 'messages', sender_id: 'laptop' })
  })

  it('refuses a missing, too long or badly formed sender id', () => {
    expect(build({ type: 'messages', name: 'L', sender: ' ' }).error).toBe('auth.devices.err_sender_required')
    expect(build({ type: 'messages', name: 'L', sender: 'a'.repeat(65) })).toEqual({ error: 'auth.devices.err_sender_long', params: { max: 64 } })
    expect(build({ type: 'messages', name: 'L', sender: 'laptop:cc' }).error).toBe('auth.devices.err_sender_chars')
    expect(build({ type: 'messages', name: 'L', sender: 'lap top' }).error).toBe('auth.devices.err_sender_chars')
  })

  it('refuses an expiry outside 1..365', () => {
    for (const bad of ['0', '-1', '366', 'abc']) {
      expect(build({ type: 'messages', name: 'L', sender: 'laptop', expiry: bad })).toEqual({
        error: 'auth.devices.err_messages_expiry', params: { max: 365 },
      })
    }
    expect(build({ type: 'messages', name: 'L', sender: 'laptop', expiry: '365' }).body?.expires_in_days).toBe(365)
  })
})

describe('client checks mirror the server', () => {
  it('the limits are the server constants', () => {
    expect(appConst('MESSAGES_KEY_DEFAULT_EXPIRY_DAYS')).toBe(MESSAGES_KEY_DEFAULT_EXPIRY_DAYS)
    expect(appConst('MESSAGES_KEY_MAX_EXPIRY_DAYS')).toBe(MESSAGES_KEY_MAX_EXPIRY_DAYS)
    expect(appConst('DEVICE_KEY_SENDER_ID_MAX')).toBe(SENDER_ID_MAX)
  })

  it('a non-reserved sender id passes the client exactly when it passes the server', () => {
    const ids = ['laptop', 'laptop-cc', 'Laptop_2', 'a'.repeat(64), 'a'.repeat(65), 'lap top', 'lap:top', 'lapöp', 'a.b', '']
    for (const id of ids) {
      const clientOk = !build({ type: 'messages', name: 'L', sender: id }).error
      const serverOk = validateMessagesSenderId(id) === null
      expect({ id, clientOk }).toEqual({ id, clientOk: serverOk })
    }
  })
})

describe('wiring and copy', () => {
  it('the form offers both types, full checked by default, and posts through the builder', () => {
    const section = extractFn('renderDeviceKeysSection')
    expect(section).toMatch(/name="authDevType" value="full" checked/)
    expect(section).toMatch(/name="authDevType" value="messages"/)
    expect(section).toContain('id="authDevSender"')
    expect(section).toContain('id="authDevMsgExpiry"')
    expect(extractFn('mintDeviceKey')).toContain('buildDeviceKeyRequestBody(')
  })

  it('a server 400 shows the server text, not a client paraphrase', () => {
    expect(extractFn('mintDeviceKey')).toContain("msg.textContent = data.error || t('auth.card.err_generic')")
  })

  it('the guide warns off a project .mcp.json and names both env variables, in both languages', () => {
    for (const src of [EN, HU]) {
      const guide = /'auth\.devices\.guide_key':\s*'([^']*)'/.exec(src)?.[1] ?? ''
      expect(guide).toContain('MARVEEN_DEVICE_KEY')
      expect(guide).toContain('.mcp.json')
      expect(/'auth\.devices\.guide_sender':\s*'([^']*)'/.exec(src)?.[1]).toContain('MARVEEN_SENDER_ID')
      expect(/'auth\.devices\.messages_warning':\s*'([^']*)'/.exec(src)?.[1]).toContain('SYSTEM_SENDER_IDS')
    }
  })

  it('the operator section is not touched by the type switch', () => {
    const op = extractFn('mintOperatorKey')
    expect(op).toContain("scope: 'operator'")
    expect(op).not.toContain('buildDeviceKeyRequestBody')
  })
})
