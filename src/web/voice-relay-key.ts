// Voice relay key administration, the command logic behind
// scripts/voice-relay-key.ts (VOICEPROV1022). Lives under src/ so the tests can
// run it in-process on an in-memory DB; the script is the only entry point and
// carries the full rationale. Do not expose this over HTTP: the whole point is
// that only a shell on the host can mint the voice relay binding.

import { openSync, writeSync, fsyncSync, closeSync, unlinkSync, fchmodSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logConfigChange } from '../db.js'
import {
  createDeviceKey,
  listDeviceKeys,
  revokeDeviceKey,
  MESSAGES_KEY_DEFAULT_EXPIRY_DAYS,
  MESSAGES_KEY_MAX_EXPIRY_DAYS,
  type DeviceKeyInfo,
} from './auth-device-keys.js'
import { isVoiceRelayBinding } from './messages-gate.js'
import { VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { notifySecurityEvent } from '../notify.js'

// Same charset as the HTTP mint's device-name rule (routes/auth.ts DEVICE_KEY_NAME_RE).
const NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u
export const DEFAULT_NAME = 'hang-front voice relay'

export interface VoiceRelayKeyIO {
  out: (s: string) => void
  err: (s: string) => void
}

export interface VoiceRelayKeyDeps {
  notify: (text: string) => Promise<void>
  now: () => number
  /** Base for a relative --out. Default: INIT_CWD (where the operator ran `npm run`), else process.cwd(). */
  cwd?: () => string
  /** The install root a key file must never land in. Default: this checkout. */
  repoRoot?: string
}

// src/web/ -> install root. `npm run` changes the working directory to the
// package root, so without INIT_CWD a relative --out silently landed in the
// repo (security re-review of PR #4).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The absolute --out path, or the reason it is refused. A relative path is
 * resolved against the directory the operator ran the command from; the target
 * must not be inside the install root (a key file in the checkout is one
 * `git add -A` away from a commit, and the tree is readable by every agent's
 * tooling). The PARENT is resolved through realpath so a symlinked directory
 * cannot route it back in; the file itself is created with O_EXCL below.
 */
export function resolveOutPath(raw: string, cwd: string, repoRoot: string): { path: string } | { error: string } {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw)
  let parent: string
  try {
    parent = realpathSync(dirname(abs))
  } catch {
    return { error: `Cannot create ${abs}: its directory does not exist (create it first, e.g. mkdir -p -m 700 ${dirname(abs)}).` }
  }
  let root = repoRoot
  try { root = realpathSync(repoRoot) } catch { /* compare unresolved */ }
  const rel = relative(root, parent)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { error: `Refused: ${abs} is inside the install root (${root}). Write the key outside the checkout, e.g. ~/.config/hang-front/hanna.key.` }
  }
  return { path: join(parent, basename(abs)) }
}

const defaultIO: VoiceRelayKeyIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
}

const defaultDeps: VoiceRelayKeyDeps = {
  notify: notifySecurityEvent,
  now: () => Math.floor(Date.now() / 1000),
}

const USAGE =
  'Usage:\n' +
  `  voice-relay-key mint --out <path> [--days N] [--name <name>]   # N: 1-${MESSAGES_KEY_MAX_EXPIRY_DAYS}, default ${MESSAGES_KEY_DEFAULT_EXPIRY_DAYS}\n` +
  '  voice-relay-key list\n'

function iso(sec: number | null): string {
  return sec == null ? '-' : new Date(sec * 1000).toISOString()
}

/** The unrevoked voice relay keys (any expiry state), newest first. */
export function voiceRelayKeys(): DeviceKeyInfo[] {
  return listDeviceKeys().filter(k => k.scope === 'messages' && k.senderId === VOICE_CHANNEL_AGENT_ID)
}

function parseFlags(args: string[], allowed: string[]): Record<string, string> | string {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!allowed.includes(a)) return `unknown argument: ${a}`
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) return `${a} needs a value`
    if (flags[a] !== undefined) return `${a} given twice`
    flags[a] = v
    i++
  }
  return flags
}

/**
 * Run one command against an ALREADY initialised database. Returns the exit
 * code. Exported for the tests, which run it in-process on an in-memory DB.
 */
export async function runVoiceRelayKey(argv: string[], io: VoiceRelayKeyIO = defaultIO, deps: VoiceRelayKeyDeps = defaultDeps): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === 'list') {
    if (rest.length) { io.err(USAGE); return 2 }
    const keys = voiceRelayKeys()
    if (keys.length === 0) {
      io.out(`No voice relay keys (sender '${VOICE_CHANNEL_AGENT_ID}').\n`)
      return 0
    }
    const now = deps.now()
    for (const k of keys) {
      const expired = k.expiresAt != null && k.expiresAt <= now ? ' (EXPIRED)' : ''
      io.out(`#${k.id}  ${k.name}  created ${iso(k.createdAt)}  expires ${iso(k.expiresAt)}${expired}  last used ${iso(k.lastUsedAt)}\n`)
    }
    return 0
  }
  if (cmd !== 'mint') { io.err(USAGE); return 2 }

  const parsed = parseFlags(rest, ['--out', '--days', '--name'])
  if (typeof parsed === 'string') { io.err(`${parsed}\n${USAGE}`); return 2 }
  const rawOut = parsed['--out']
  if (!rawOut) { io.err(`--out <path> is required: the key is written only to that file, never printed.\n${USAGE}`); return 2 }
  const cwd = deps.cwd ? deps.cwd() : (process.env.INIT_CWD || process.cwd())
  const resolvedOut = resolveOutPath(rawOut, cwd, deps.repoRoot ?? REPO_ROOT)
  if ('error' in resolvedOut) { io.err(`${resolvedOut.error}\n`); return 1 }
  const outPath = resolvedOut.path
  let days = MESSAGES_KEY_DEFAULT_EXPIRY_DAYS
  if (parsed['--days'] !== undefined) {
    const raw = parsed['--days']
    const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(n) || n < 1 || n > MESSAGES_KEY_MAX_EXPIRY_DAYS) {
      io.err(`Invalid --days (1-${MESSAGES_KEY_MAX_EXPIRY_DAYS}; a voice relay key must expire).\n`)
      return 1
    }
    days = n
  }
  const name = (parsed['--name'] ?? DEFAULT_NAME).trim()
  if (!NAME_RE.test(name)) {
    io.err('Invalid --name (1-64 chars: letters, digits, space, . _ -).\n')
    return 1
  }
  // Same rule the gate and the routes apply on every use: void when a real
  // fleet agent (or another reserved identity) holds the voice id.
  if (!isVoiceRelayBinding(VOICE_CHANNEL_AGENT_ID)) {
    io.err(`Refused: '${VOICE_CHANNEL_AGENT_ID}' is not available as the voice relay binding (a fleet agent or another reserved identity holds that id).\n`)
    return 1
  }

  // Open the output FIRST, exclusively and owner-only: an existing file is a
  // refusal before any key exists, so no orphan credential is ever minted.
  let fd: number
  try {
    fd = openSync(outPath, 'wx', 0o600)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    io.err(code === 'EEXIST'
      ? `Refused: ${outPath} already exists (never overwritten). Choose a new path or remove it first.\n`
      : `Cannot create ${outPath}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }

  const now = deps.now()
  const live = voiceRelayKeys().filter(k => k.expiresAt == null || k.expiresAt > now)
  if (live.length) {
    io.err(`WARNING: ${live.length} other unrevoked, unexpired voice relay key(s) exist: ${live.map(k => `#${k.id} ${k.name}`).join(', ')}. Revoke the old one once the relay uses the new key.\n`)
  }

  let minted: ReturnType<typeof createDeviceKey> | null = null
  try {
    fchmodSync(fd, 0o600) // the umask can only narrow it; make it exact anyway
    minted = createDeviceKey(name, { scope: 'messages', senderId: VOICE_CHANNEL_AGENT_ID, expiresInDays: days })
    writeSync(fd, `${minted.key}\n`)
    fsyncSync(fd)
    closeSync(fd)
  } catch (e) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(outPath) } catch { /* nothing to remove */ }
    if (minted) revokeDeviceKey(minted.id)
    io.err(`Mint failed, nothing kept: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }

  logConfigChange('security.voice_relay_key_minted', null, `id=${minted.id} name=${minted.name} expires=${iso(minted.expiresAt)}`, 'cli')
  await deps.notify(`🎙️ Új hang-relay kulcs (from=${VOICE_CHANNEL_AGENT_ID}) készült a gépen, CLI-ből: #${minted.id} "${minted.name}", lejár ${iso(minted.expiresAt)}. Ezzel a kulccsal a flotta felé "a tulajdonos beszél" üzenet írható. Ha nem te voltál, vond vissza (DELETE /api/auth/device-keys/${minted.id}), és nézd meg, mi fut a gépen a nevedben.`)
  io.out(`Minted voice relay key #${minted.id} "${minted.name}" (scope messages, sender ${VOICE_CHANNEL_AGENT_ID}), expires ${iso(minted.expiresAt)}.\n` +
    `The key was written to ${outPath} (mode 0600); it is not shown here.\n`)
  return 0
}
