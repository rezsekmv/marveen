// Install-local, config-driven exceptions to the self-pace gate (self-pace-gate.mjs).
//
// Kept in its own module so the gate itself carries only a small, marked hook point:
// an upstream update of the gate then conflicts in a few lines, not in this logic.
//
// ONE exception exists: a named agent may restart (kickstart) one of the owner's own
// launchd services, e.g. an ops agent restarting a service it operates. Everything about
// it is deliberately narrow:
//
//   - The agent must be listed in store/self-pace-exceptions.json:
//       { "launchctlKickstart": { "<agent>": ["<label prefix>", ...] } }
//     The path is fixed next to the gate. No environment variable moves it (an agent can
//     set env in its own settings). A different path can only be passed in-process, as
//     opts.exceptionsPath to gateDecision() / launchctlKickstartExempt() or as the second
//     argument of kickstartPrefixesFor() (tests); the hook entry never passes one.
//   - This module is loaded defensively by the gate: if it is missing or broken, the gate
//     runs without any exception.
//   - The file is a protected store file in the gate, with the same (casual-route, not
//     sandbox) protection as the others: direct writes by a sub-agent are denied.
//   - Missing, unreadable, symlinked or malformed config => no exception (fail closed).
//   - The ENTIRE raw command must be exactly one of
//       launchctl kickstart gui/<uid>/<label>
//       launchctl kickstart -k gui/<uid>/<label>
//     optionally spelled /bin/launchctl, separated by plain spaces. Any other character
//     (quotes, backslash, $, backtick, ;, &, |, <, >, (, ), glob characters, newline,
//     tab ...), any env or sudo prefix, any other flag or subcommand fails the match.
//   - <uid> is the numeric uid of the user running the hook (process.getuid()), and
//     <label> is a configured prefix followed by [a-z0-9][a-z0-9.-]*.
//
// The exception only neutralises the launchctl scheduler deny for that exact command.
// Every other check in the gate still runs first and still denies on its own.

import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_EXCEPTIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'self-pace-exceptions.json')

// Whole command, nothing else. Only [a-z0-9/.-] and single-space separated tokens can
// match, so no shell metacharacter, quote, expansion or redirect can be present.
const KICKSTART_RX = /^ *(?:\/bin\/)?launchctl +kickstart +(?:-k +)?gui\/([0-9]+)\/([a-z0-9.-]+) *$/
// A prefix is TWO or more dot-terminated label components: `hu.example.`, `com.acme-ops.`.
// A single component (`com.`, `hu.`) would cover far more than one owner's services.
const PREFIX_RX = /^(?:[a-z0-9][a-z0-9-]*\.){2,}$/
const LABEL_REST_RX = /^[a-z0-9][a-z0-9.-]*$/
const AGENT_RX = /^[A-Za-z0-9_-]+$/
const MAX_CONFIG_BYTES = 64 * 1024

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The label prefixes this agent may kickstart, or [] on any problem (fail closed).
export function kickstartPrefixesFor(agent, exceptionsPath = DEFAULT_EXCEPTIONS_PATH) {
  try {
    if (typeof agent !== 'string' || !AGENT_RX.test(agent)) return []
    const st = lstatSync(exceptionsPath)
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return [] // a symlink is not followed
    const cfg = JSON.parse(readFileSync(exceptionsPath, 'utf-8'))
    if (!isPlainObject(cfg) || !isPlainObject(cfg.launchctlKickstart)) return []
    if (!Object.hasOwn(cfg.launchctlKickstart, agent)) return []
    const list = cfg.launchctlKickstart[agent]
    if (!Array.isArray(list)) return []
    return list.filter((p) => typeof p === 'string' && PREFIX_RX.test(p))
  } catch {
    return []
  }
}

// Does this exact raw Bash command qualify for the kickstart exception for opts.selfAgent?
// opts.exceptionsPath is honoured for tests only (the hook entry never sets it).
export function launchctlKickstartExempt(command, opts = {}) {
  try {
    if (typeof command !== 'string') return false
    const m = KICKSTART_RX.exec(command)
    if (!m) return false
    const [, uid, label] = m
    if (typeof process.getuid !== 'function') return false
    if (uid !== String(process.getuid())) return false
    const prefixes = kickstartPrefixesFor(opts.selfAgent, opts.exceptionsPath ?? DEFAULT_EXCEPTIONS_PATH)
    return prefixes.some((p) => label.startsWith(p) && LABEL_REST_RX.test(label.slice(p.length)))
  } catch {
    return false
  }
}
