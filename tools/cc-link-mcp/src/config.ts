/**
 * The ONE place that reads the environment. Everything else receives a Config.
 *
 * Missing or invalid required values never throw: they are collected in
 * `errors`, the server still starts (so Claude Code shows it connected), and
 * every tool answers with those errors instead of doing anything.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  /** Dashboard base URL without a trailing slash, or undefined if missing/invalid. */
  url?: string
  /** Bearer device key. Never logged, never echoed. */
  deviceKey?: string
  /** This machine's system sender id. */
  senderId?: string
  /** Fallback main-agent id used when GET /api/team/graph fails. */
  mainAgentFallback?: string
  stateDir: string
  dryRun: boolean
  askWaitSec: number
  pollSec: number
  flushSec: number
  /** Human-readable problems that block every tool (each names the env variable). */
  errors: string[]
  /** Non-blocking problems (e.g. an unparsable interval that fell back to its default). */
  warnings: string[]
  /** One-time startup notices for stderr (e.g. the insecure-http opt-in). Not repeated in tool results. */
  notices: string[]
  /** MARVEEN_URL is plain http to a non-loopback host, allowed by CC_LINK_ALLOW_INSECURE_HTTP=1. */
  insecureHttp: boolean
}

/** A header-safe token: printable ASCII, no spaces or control characters. */
export const DEVICE_KEY_CHARSET = /^[\x21-\x7e]+$/

export const DEFAULT_ASK_WAIT_SEC = 60
export const DEFAULT_POLL_SEC = 15
export const DEFAULT_FLUSH_SEC = 300

/** localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Validate an http(s) URL and strip trailing slashes. Returns undefined when invalid. */
export function normalizeBaseUrl(raw: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.search || parsed.hash) return undefined
  return parsed.toString().replace(/\/+$/, '')
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  warnings: string[],
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    warnings.push(`${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`)
    return fallback
  }
  return n
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
  home: string = homedir(),
): Config {
  const errors: string[] = []
  const warnings: string[] = []
  const notices: string[] = []
  let insecureHttp = false
  const dryRun = env.CC_LINK_DRY_RUN?.trim() === '1' || argv.includes('--dry-run')

  let url: string | undefined
  const rawUrl = env.MARVEEN_URL?.trim()
  if (!rawUrl) {
    errors.push('MARVEEN_URL is not set (expected e.g. https://<mini-host>:3420)')
  } else {
    url = normalizeBaseUrl(rawUrl)
    if (!url) {
      errors.push('MARVEEN_URL is not a valid http(s) base URL')
    } else {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
        if (env.CC_LINK_ALLOW_INSECURE_HTTP?.trim() === '1') {
          insecureHttp = true
          notices.push(
            'WARNING: MARVEEN_URL is plain http to a non-loopback host; the device key travels in cleartext ' +
              '(allowed by CC_LINK_ALLOW_INSECURE_HTTP=1). Prefer https or a VPN.',
          )
        } else {
          errors.push(
            'MARVEEN_URL uses plain http to a non-loopback host, which would send the device key in cleartext. ' +
              'Use https (or a VPN address with https), or set CC_LINK_ALLOW_INSECURE_HTTP=1 to opt in.',
          )
        }
      }
    }
  }

  let deviceKey = env.MARVEEN_DEVICE_KEY?.trim() || undefined
  if (!deviceKey && !dryRun) errors.push('MARVEEN_DEVICE_KEY is not set')
  if (deviceKey && !DEVICE_KEY_CHARSET.test(deviceKey)) {
    // Never echo the value: it is a credential, even when malformed.
    errors.push('MARVEEN_DEVICE_KEY contains invalid characters (only printable ASCII without spaces is allowed)')
    deviceKey = undefined
  }

  const senderId = env.MARVEEN_SENDER_ID?.trim() || undefined
  if (!senderId) errors.push('MARVEEN_SENDER_ID is not set')

  const mainAgentFallback = env.MARVEEN_MAIN_AGENT?.trim() || undefined
  const stateDir = env.CC_LINK_STATE_DIR?.trim() || join(home, '.cc-link')

  return {
    url,
    deviceKey,
    senderId,
    mainAgentFallback,
    stateDir,
    dryRun,
    askWaitSec: positiveInt(env, 'CC_LINK_ASK_WAIT_SEC', DEFAULT_ASK_WAIT_SEC, warnings),
    pollSec: positiveInt(env, 'CC_LINK_POLL_SEC', DEFAULT_POLL_SEC, warnings),
    flushSec: positiveInt(env, 'CC_LINK_FLUSH_SEC', DEFAULT_FLUSH_SEC, warnings),
    errors,
    warnings,
    notices,
    insecureHttp,
  }
}
