#!/usr/bin/env tsx
// Voice relay key administration (VOICEPROV1022).
//
//   npm run voice-relay-key -- mint --out <path> [--days N] [--name <name>]
//   npm run voice-relay-key -- list
//
// Mints the ONE credential that may write agent_messages rows as the voice
// channel (VOICE_CHANNEL_AGENT_ID): a 'messages' scoped device key bound to
// that id, which the hang-front relay carries. The provenance gate
// (scripts/hooks/provenance-gate.py) reads such a row back as proof that the
// relay sent the prompt, so whoever can mint this key can speak "as the owner"
// to the fleet.
//
// THIS IS WHY IT IS A CLI AND NOT A ROUTE. POST /api/auth/device-keys refuses
// this binding for every HTTP principal: every HTTP lane traces back to the
// shared dashboard token, which every sub-agent can read -- the token can
// create a dashboard user (POST /api/auth/users), log in as it and mint keys
// from that session (security review of PR #4). Like scripts/dashboard-user.ts, this
// talks to SQLite directly through the app's own modules, no HTTP and no auth
// gate: RUNNING THIS ON THE HOST IS THE ROOT CREDENTIAL. That is the same
// ceiling as the residual the gate documents (direct writes to
// store/claudeclaw.db by the same Unix user); nothing on the HTTP side reaches it.
//
// A relative --out is resolved against INIT_CWD (where `npm run` was typed, not
// the package root it switches to), and a target inside the install root is
// refused. The raw key is written ONLY to --out, created exclusively (O_EXCL, never
// overwriting) with mode 0600; it is never printed. Every mint is audited
// (logConfigChange) and announced to the owner (notifySecurityEvent), so a mint
// nobody asked for is visible. Revocation stays where it was: DELETE
// /api/auth/device-keys/<id>, or `npm run dashboard-user -- security:reset`.

import { initDatabase } from '../src/db.js'
import { runVoiceRelayKey } from '../src/web/voice-relay-key.js'

// The command logic lives in src/web/voice-relay-key.ts so the tests can run it
// in-process on an in-memory DB; this file is only the entry point.
initDatabase()
runVoiceRelayKey(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
