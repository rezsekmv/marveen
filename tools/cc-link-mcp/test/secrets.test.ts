import { afterEach, describe, expect, test } from 'bun:test'
import { findSecrets, SECRET_PATTERNS } from '../src/secrets.ts'
import { makeHarness, makeLink, type Harness } from './helpers.ts'

// Every sample is assembled at runtime so the test file itself holds no literal token.
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)
const SAMPLES: Record<string, string> = {
  pem_rsa: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  pem_openssh: '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA',
  pem_plain: '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  aws: 'key id ' + 'AKIA' + 'IOSFODNN7EXAMPLE' + ' in config',
  ghp: 'gh' + 'p_' + rep('aB3dE5', 36),
  gho: 'gh' + 'o_' + rep('Zx9Yw8', 36),
  ghs: 'gh' + 's_' + rep('Qr7St6', 36),
  github_pat: 'github' + '_pat_' + rep('11ABCDEFG0', 82),
  slack_bot: 'xox' + 'b-' + '1234567890-1234567890123-' + rep('AbCdEfGh', 24),
  slack_user: 'xox' + 'p-' + '1234567890-' + rep('abc123', 20),
  anthropic: 'sk-' + 'ant-api03-' + rep('Ab1_Cd2-', 48),
  openai: 'sk-' + 'proj-' + rep('Ab12Cd34', 40),
  openai_plain: 'sk-' + rep('Ab12Cd34', 32),
  google: 'AI' + 'za' + rep('SyD0aBc_1-xYz', 35),
  jwt:
    'ey' + 'JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ' + '.' +
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  telegram: '1234567890' + ':' + rep('AAH_kJ9-xYz', 35),
  device_key: 'mv' + 'dk_' + rep('a1B2c3', 32),
  bearer: 'Authorization: ' + 'Bearer ' + rep('abcDEF123', 32),
  password_assign: 'password' + '=' + 'hunter2hunter2',
  passwd_assign: 'passwd: ' + 'Sup3rS3cretValue',
  pwd_assign: 'PWD=' + 'correcthorsebattery',
  secret_assign: 'client_secret = "' + 'q8w7e6r5t4y3' + '"',
  token_assign: 'TOKEN=' + 'abcd1234efgh5678',
  api_key_assign: '"api_key": "' + 'k3yk3yk3yk3y' + '"',
  api_dash_key: 'api-key: ' + 'Zz9Yy8Xx7Ww6',
  apikey: 'APIKEY=' + 'Zz9Yy8Xx7Ww6',
  access_key: 'access_key=' + 'AbCdEf123456',
  db_password_env: 'DB_PASSWORD=' + 'pa55w0rdpa55',
}

const PROSE = [
  'the token expired yesterday, so the job failed',
  'password reset flow is broken on staging',
  'we rotate the secret every 90 days',
  'commit a3f5c9e1b2d4f60718293a4b5c6d7e8f90a1b2c3 fixed it',
  'short sha a3f5c9e',
  'request id 123e4567-e89b-12d3-a456-426614174000 failed',
  'use Bearer auth for the dashboard',
  'the api key is configured in the vault',
  'token: see the vault',
  'set password to ${DB_PASSWORD} in .env',
  'task-runner-configuration-service-module restarted',
  'A token lejárt, újra kell generálni a jelszót.',
  'risk-assessment-for-production-rollout done',
  'The JWT starts with eyJ but this one was truncated.',
  'Port 3420, version 1.27.1, issue #1872',
]

const NAMES = new Set(SECRET_PATTERNS.map(p => p.name))

describe('secret scan', () => {
  for (const [label, sample] of Object.entries(SAMPLES)) {
    test(`blocks ${label}`, () => {
      const hits = findSecrets(`Some context before.\n${sample}\nand after.`)
      expect(hits.length).toBeGreaterThan(0)
    })
  }

  test('returns pattern names only, never the matched value', () => {
    for (const sample of Object.values(SAMPLES)) {
      const hits = findSecrets(sample)
      for (const h of hits) expect(NAMES.has(h)).toBe(true)
      expect(hits.join(' ')).not.toContain(sample)
    }
  })

  test('names the right pattern for representative samples', () => {
    expect(findSecrets(SAMPLES.pem_rsa!)).toContain('pem_private_key')
    expect(findSecrets(SAMPLES.aws!)).toContain('aws_access_key_id')
    expect(findSecrets(SAMPLES.ghp!)).toContain('github_token')
    expect(findSecrets(SAMPLES.github_pat!)).toContain('github_token')
    expect(findSecrets(SAMPLES.slack_bot!)).toContain('slack_token')
    expect(findSecrets(SAMPLES.anthropic!)).toContain('anthropic_api_key')
    expect(findSecrets(SAMPLES.openai_plain!)).toContain('openai_api_key')
    expect(findSecrets(SAMPLES.google!)).toContain('google_api_key')
    expect(findSecrets(SAMPLES.jwt!)).toContain('jwt')
    expect(findSecrets(SAMPLES.telegram!)).toContain('telegram_bot_token')
    expect(findSecrets(SAMPLES.device_key!)).toContain('marveen_device_key')
    expect(findSecrets(SAMPLES.bearer!)).toContain('bearer_token')
    expect(findSecrets(SAMPLES.password_assign!)).toContain('generic_secret_assignment')
  })

  for (const p of PROSE) {
    test(`ordinary prose does not trigger: ${JSON.stringify(p).slice(0, 50)}`, () => {
      expect(findSecrets(p)).toEqual([])
    })
  }
})

describe('secret scan on the tool path', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  for (const tool of ['tony_note', 'tony_ask'] as const) {
    test(`${tool} refuses: nothing sent, nothing queued, fetch never called`, async () => {
      h = makeHarness()
      const { link } = makeLink(h, { pid: 4001 })
      const secret = SAMPLES.ghp!
      const arg = tool === 'tony_note' ? { text: `deploy note ${secret}` } : { question: `is ${secret} valid?` }
      const r = await link.callTool(tool, arg)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('github_token')
      expect(r.text).not.toContain(secret)
      expect(h.dash.calls.length).toBe(0)
      expect(link.deps.outbox.count()).toBe(0)
    })
  }

  test('refuses even while the dashboard is unreachable (does not queue the secret)', async () => {
    h = makeHarness()
    h.dash.override = () => 'network'
    const { link } = makeLink(h, { pid: 4002 })
    const r = await link.callTool('tony_note', { text: SAMPLES.password_assign! })
    expect(r.isError).toBe(true)
    expect(link.deps.outbox.count()).toBe(0)
    expect(h.dash.posts().length).toBe(0)
  })
})
