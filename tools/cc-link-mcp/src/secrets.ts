/**
 * Pure secret scanner. Runs on every <prefix>_message text BEFORE
 * anything is queued or sent. Returns pattern NAMES only, never the matched
 * value, so the error message itself cannot leak the secret.
 *
 * Judgment calls (documented, deliberately conservative on false positives):
 * - 40-hex git SHAs never trigger.
 * - A bare 64-hex string triggers when it stands alone on a line (optionally
 *   quoted) or follows `=` / `:`, except after a hash label such as
 *   `sha256:` / `digest=` / `checksum:`. A sha256 inside a prose sentence does
 *   not trigger; a sha256 alone on a line DOES (indistinguishable from a
 *   64-hex API token, which is exactly the fleet dashboard token format).
 */

export interface SecretPattern {
  name: string
  re: RegExp
  /** Optional post-filter on the captured value (last capture group) to cut false positives. */
  reject?: (value: string) => boolean
}

/**
 * Placeholder WORDS: exempt only when they are the WHOLE value. The my-/your-
 * forms are a closed list (`your-api-key`, `my_token_here`, ...), never an
 * open `my-<anything>`: a diceware passphrase like `my-horse-battery-staple`
 * must not pass as a placeholder.
 */
const PLACEHOLDER_WORD = new RegExp(
  '^(?:changeme|change[_-]?me|null|none|nil|undefined|true|false|redacted|placeholder|example|sample|dummy|todo|tbd|' +
    'secret|password|xxx+|\\*+|\\.{3}|…|' +
    '(?:your|my)[_-]?(?:api[_-]?)?(?:key|token|password|passwd|secret|pass)(?:[_-]?here)?)$',
  'i',
)

/**
 * Reference SYNTAX: exempt only when the reference is the WHOLE value, so
 * `${TOKEN}` passes but `${TOKEN}abc123XYZ` or `<x>Secr3tValue` does not.
 */
const REFERENCE_WHOLE: readonly RegExp[] = [
  /^\$[A-Z_][A-Z0-9_]*$/, // $ENV_NAME (upper-case env style only)
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/, // ${NAME} (with a default: see SHELL_DEFAULT below)
  // Dotted / bracket references: ${var.db_password} (Terraform),
  // ${secrets.API_TOKEN} (CI), ${data["x"]}, ${local.a[0]}. (A dotted part is
  // not checked for randomness: ${var.<random>} passes; see README.)
  /^\$\{[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[(?:"[^"\]]*"|'[^'\]]*'|\d+)\])+\}$/,
  // The only colon form that is a pure reference: ${env:NAME}. Any other
  // ${X:Y} is a default (Spring style) and Y is scanned, see COLON_DEFAULT.
  /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^\$\{\{[^{}]*\}\}$/, // ${{ ... }} (CI expressions without spaces)
  /^\$\([^()]*\)$/, // $(cmd)
  // <...> only when placeholder-shaped: letters-only words in UPPER
  // (<YOUR_API_KEY>, <API KEY>), lower (<your-token>, <api key>) or Title case
  // (<Your API Key>), with digits ONLY as a separate trailing segment
  // (<YOUR_API_KEY_2>, <api-key-2>). Letter+digit mixes (<hunter2>,
  // <ABC123XYZ789>), hex runs and CamelCase blobs (<HunterSecretValue>) are values.
  /^<[A-Z]+(?:[ _-][A-Z]+)*(?:[ _-][0-9]+)?>$/,
  /^<[a-z]+(?:[ _-][a-z]+)*(?:[ _-][0-9]+)?>$/,
  /^<[A-Z][a-z]+(?:[ _-](?:[A-Z][a-z]+|[A-Z]+|[a-z]+))*(?:[ _-][0-9]+)?>$/,
  /^\{\{[^{}]*\}\}$/, // {{ template }}
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %NAME%
  /^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/, // process.env.NAME
  /^process\.env\[['"][A-Za-z_][A-Za-z0-9_]*['"]\]$/,
  /^os\.environ(?:\[['"][A-Za-z_][A-Za-z0-9_]*['"]\]|\.get\(['"][A-Za-z_][A-Za-z0-9_]*['"]\))$/,
  /^env\.[A-Z_][A-Z0-9_]*$/, // env.NAME (upper-case env style only: `env.XSecr3t` is a value)
]

/**
 * `${NAME:-default}`, `${NAME:=default}`, `${NAME-default}`, `${NAME=default}`
 * (and the `+` / `?` forms): the default is a literal value, so it is judged by
 * the normal value rules. An empty or harmless default (`changeme`,
 * `localhost`) keeps the whole reference exempt; a credential-looking default
 * (`${DB_PASS:-Hunter2Prod42xQ}`) does not.
 */
const SHELL_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=+?]([^{}]*)\}$/

/** `${NAME:default}` (Spring style, NAME may be dotted), `${env:<not an identifier>}`: the part after ':' is a value. */
const COLON_DEFAULT = /^\$\{[A-Za-z_][\w.-]*:(?![-=+?])([^{}]*)\}$/

/** True for a placeholder word or a variable reference, either one being the whole value. */
export function isPlaceholder(v: string): boolean {
  if (PLACEHOLDER_WORD.test(v) || REFERENCE_WHOLE.some(re => re.test(v))) return true
  const d = SHELL_DEFAULT.exec(v) ?? COLON_DEFAULT.exec(v)
  if (d) {
    const def = d[1]!
    return def.length === 0 || isPlaceholder(def) || !looksLikeSecretValue(def)
  }
  return false
}

/**
 * An UNQUOTED (or phrase) value counts only if it looks like a credential:
 * not a placeholder, not a path, and it has a digit, mixed case, or is long (16+).
 * ("Token: frissítés" never reaches here: the value charset is printable ASCII.)
 */
export function looksLikeSecretValue(v: string): boolean {
  if (isPlaceholder(v)) return false
  if (/^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(v)) return false // filesystem path
  const hasDigit = /[0-9]/.test(v)
  const mixedCase = /[a-z]/.test(v) && /[A-Z]/.test(v)
  return hasDigit || mixedCase || v.length >= 16
}

/** sk- keys: the long segment must mix letters and digits (rules out CSS-ish word chains). */
function looksLikeSkKey(v: string): boolean {
  return /[0-9]/.test(v) && /[A-Za-z]/.test(v)
}

/** AWS secret access keys are 40 base64-ish chars with upper, lower and digits (a 40-hex git SHA has no upper case). */
function looksLikeAwsSecret(v: string): boolean {
  return /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v)
}

const ASSIGN_KEY = String.raw`(?:\b|_)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b['"]?\s*[:=]\s*`
// Printable ASCII without space and quotes.
const VALUE = String.raw`[!#-&(-~]`

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'pem_private_key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'aws_secret_access_key',
    re: /aws_secret_access_key['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
  },
  {
    name: 'aws_secret_access_key',
    // a 40-char base64-ish run within 40 chars after "aws" or "secret" on the same line
    re: /(?:aws|secret)[^\n]{0,40}?(?<![A-Za-z0-9/+=])([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/i,
    reject: v => !looksLikeAwsSecret(v),
  },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  { name: 'stripe_live_key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    name: 'openai_api_key',
    // optional short prefix segments (sk-proj-...), then one 20+ alphanumeric run
    re: /\bsk-(?!ant-)(?:[A-Za-z0-9_]{1,12}-){0,2}([A-Za-z0-9]{20,})/,
    reject: v => !looksLikeSkKey(v),
  },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'telegram_bot_token', re: /(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/ },
  { name: 'marveen_device_key', re: /\bmvdk_[A-Za-z0-9_-]{8,}/ },
  {
    name: 'hex_token_64',
    // alone on a line (optionally quoted), or right after "=" / ":", but not after a hash label
    re: /(?:^[ \t]*["'`]?|(?<!(?:sha-?256|sha-?512|digest|checksum|hash|sum)['"]?\s*)[:=][ \t]*["'`]?)([0-9a-fA-F]{64})(?![0-9a-fA-F])(?=["'`]?[ \t]*(?:$|[,;\s]))/m,
  },
  { name: 'bearer_token', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/i, reject: v => isPlaceholder(v) },
  {
    name: 'url_credentials',
    // scheme://user:password@host
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@[^\s/@]+/i,
    reject: v => isPlaceholder(v),
  },
  {
    name: 'generic_secret_assignment',
    // quoted value: may contain spaces
    re: new RegExp(ASSIGN_KEY + String.raw`(["'])((?:(?!\1)[^\n]){8,200})\1`, 'i'),
    reject: v => isPlaceholder(v),
  },
  {
    name: 'generic_secret_assignment',
    // unquoted value: printable ASCII run that looks like a credential
    re: new RegExp(ASSIGN_KEY + `(${VALUE}{8,})`, 'i'),
    reject: v => !looksLikeSecretValue(v),
  },
  {
    name: 'password_phrase',
    // "the password is X", "password was: X", Hungarian "jelszó: X" / "a jelszó az X"
    re: new RegExp(
      String.raw`\b(?:password|passphrase|passwd)\s+(?:is|was)\s*:?\s*["']?(${VALUE}{6,})` +
        String.raw`|(?<![A-Za-z])jelsz[oó](?:m|t)?\s*(?::|=|\s+(?:az|a|pedig|:))\s*["']?(${VALUE}{6,})`,
      'i',
    ),
    reject: v => !looksLikeSecretValue(v),
  },
]

/** Names of every secret pattern found in `text` (deduplicated, in pattern order). */
export function findSecrets(text: string, patterns: readonly SecretPattern[] = SECRET_PATTERNS): string[] {
  const hits: string[] = []
  for (const p of patterns) {
    if (hits.includes(p.name)) continue
    const flags = p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g'
    const re = new RegExp(p.re.source, flags)
    for (const m of text.matchAll(re)) {
      // The value is the LAST defined capture group (quoted patterns capture the quote first).
      const groups = m.slice(1).filter((g): g is string => g !== undefined)
      const value = groups.at(-1) ?? m[0]
      if (p.reject && p.reject(value)) continue
      hits.push(p.name)
      break
    }
  }
  return hits
}
