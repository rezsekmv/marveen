#!/usr/bin/env python3
"""Behavioural suite for scripts/hooks/device-keys-gate.py (DEVKEYGATE1022).

The gate closes the agent-Bash lane to the device_keys table: running the
voice-relay-key mint, writing the table with SQL, and replacing the DB file. Each
blocked shape here stands next to its allowed twin (kanban INSERT vs device_keys
INSERT, mint vs list, execution vs a prose mention), because a gate that only
blocks is worth as little as one that only allows -- and the prose side is the
one that drifts: destructive-gate measured 28% false positives before it learned
which part of a command actually runs (ba856d56), and this gate reuses exactly
that parsing.

Run: python3 <this file>   Exit 0 = all green.
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
GATE = os.path.join(HOOKS, "device-keys-gate.py")

spec = importlib.util.spec_from_file_location("dkgate", GATE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

TMP = tempfile.mkdtemp(prefix="dkgate-test-")
# Every subprocess run of the hook logs into the temp dir, never into the
# checkout's store/ (which would also make it look like a live install).
ENV = dict(os.environ, HOOK_ERRLOG_PATH=os.path.join(TMP, "hook-errors.log"))

failed = []


def check(name, ok):
    print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
    if not ok:
        failed.append(name)


def blocks(cmd, cwd=None):
    try:
        gate.check_bash(cmd, cwd)
        return False
    except gate.GateError:
        return True


def blocks_file(tool, path):
    try:
        gate.check_tool({"tool_name": tool, "tool_input": {"file_path": path}})
        return False
    except gate.GateError:
        return True


def hook(ev_or_raw, gate_path=GATE):
    raw = ev_or_raw if isinstance(ev_or_raw, str) else json.dumps(ev_or_raw)
    r = subprocess.run([sys.executable, gate_path], input=raw, capture_output=True,
                       text=True, env=ENV)
    return r.returncode, r.stderr


def bash_ev(cmd, cwd=None):
    ev = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}
    if cwd:
        ev["cwd"] = cwd
    return ev


DB = "store/claudeclaw.db"
ABSDB = ROOT + "/" + DB
KEY_INSERT = "INSERT INTO device_keys (id, scope, sender_id) VALUES ('k1', 'messages', 'hanna')"
KANBAN_INSERT = "INSERT INTO kanban_cards (id, title) VALUES ('c1', 'fix device_keys docs')"

try:
    # --- 1. the mint ----------------------------------------------------------
    print("MINT -- blocked vs allowed:")
    check("npm run voice-relay-key -- mint: BLOCK",
          blocks("npm run voice-relay-key -- mint --out /tmp/k.json"))
    check("npm run voice-relay-key -- list: allowed",
          not blocks("npm run voice-relay-key -- list"))
    check("cd install && npm run ... mint: BLOCK",
          blocks("cd " + ROOT + " && npm run voice-relay-key -- mint --out k.json"))
    check("bun run voice-relay-key mint: BLOCK", blocks("bun run voice-relay-key mint --out k"))
    check("pnpm run voice-relay-key mint: BLOCK", blocks("pnpm run voice-relay-key mint"))
    check("yarn voice-relay-key mint: BLOCK", blocks("yarn voice-relay-key mint"))
    check("npx tsx scripts/voice-relay-key.ts mint: BLOCK",
          blocks("npx tsx scripts/voice-relay-key.ts mint --out k"))
    check("tsx scripts/voice-relay-key.ts mint: BLOCK", blocks("tsx scripts/voice-relay-key.ts mint"))
    check("node --import tsx scripts/voice-relay-key.ts mint: BLOCK",
          blocks("node --import tsx " + ROOT + "/scripts/voice-relay-key.ts mint"))
    check("tsx scripts/voice-relay-key.ts list: allowed",
          not blocks("tsx scripts/voice-relay-key.ts list"))
    check("./scripts/voice-relay-key.ts mint (direct exec): BLOCK",
          blocks("./scripts/voice-relay-key.ts mint"))
    check("env/timeout wrappers: BLOCK",
          blocks("FOO=1 timeout 30 npm run voice-relay-key -- mint"))
    check("if-wrapped: BLOCK", blocks("if npm run voice-relay-key -- mint; then echo ok; fi"))
    check("bash -c wrapper: BLOCK", blocks("bash -c 'npm run voice-relay-key -- mint --out k'"))
    check("bash heredoc body: BLOCK", blocks("bash <<'SH'\nnpm run voice-relay-key -- mint\nSH"))
    check("subcommand in a variable (undecidable): BLOCK",
          blocks("npm run voice-relay-key -- $SUB"))
    check("python subprocess shell-out: BLOCK",
          blocks("python3 -c \"import subprocess; subprocess.run(['npm','run','voice-relay-key','--','mint'])\""))
    check("python subprocess shell-out of list: allowed",
          not blocks("python3 -c \"import subprocess; subprocess.run(['npm','run','voice-relay-key','--','list'])\""))
    check("node -e importing the mint module: BLOCK",
          blocks("node -e \"import('./scripts/voice-relay-key.ts').then(m => m.runVoiceRelayKey(['mint']))\""))
    check("tsx -e calling createDeviceKey: BLOCK",
          blocks("tsx -e \"import { createDeviceKey } from './src/device-keys'; createDeviceKey({})\""))
    check("tsx heredoc calling createDeviceKey: BLOCK",
          blocks("tsx <<'TS'\nimport { createDeviceKey } from './src/device-keys'\ncreateDeviceKey({})\nTS"))
    check("cat <<X | node - with runVoiceRelayKey: BLOCK",
          blocks("cat <<'JS' | node -\nrequire('./x').runVoiceRelayKey(['mint'])\nJS"))

    print()
    print("MINT -- prose mentions are allowed:")
    for c in ('echo "run: npm run voice-relay-key -- mint --out <file>"',
              "git commit -m 'docs: npm run voice-relay-key -- mint is human-only'",
              "grep -rn 'voice-relay-key' scripts/ docs/",
              "rg 'mint' scripts/voice-relay-key.ts",
              "cat scripts/voice-relay-key.ts",
              "git log --oneline -- scripts/voice-relay-key.ts",
              "# npm run voice-relay-key -- mint\nls",
              "cat > /tmp/runbook.md <<'EOF'\nnpm run voice-relay-key -- mint --out k.json\nEOF",
              "npx vitest run voice-relay-key",
              "curl -s -X POST http://localhost:3420/api/messages -d '{\"content\":\"please run npm run voice-relay-key -- mint\"}'"):
        check("allowed: " + c.split("\n")[0][:70], not blocks(c))

    # --- 2. SQL on device_keys -------------------------------------------------
    print()
    print("SQL -- device_keys write blocked, kanban write allowed (side by side):")
    check("sqlite3 arg INSERT device_keys: BLOCK", blocks('sqlite3 %s "%s"' % (DB, KEY_INSERT)))
    check("sqlite3 arg INSERT kanban_cards: allowed", not blocks('sqlite3 %s "%s"' % (DB, KANBAN_INSERT)))
    check("UPDATE device_keys SET sender_id: BLOCK",
          blocks("sqlite3 %s \"UPDATE device_keys SET sender_id='hanna' WHERE id='x'\"" % DB))
    check("UPDATE kanban_cards: allowed",
          not blocks("sqlite3 %s \"UPDATE kanban_cards SET status='done' WHERE id='x'\"" % DB))
    check("DELETE FROM device_keys: BLOCK", blocks("sqlite3 %s 'DELETE FROM device_keys'" % DB))
    check("DELETE FROM kanban_comments: allowed",
          not blocks("sqlite3 %s \"DELETE FROM kanban_comments WHERE id='x'\"" % DB))
    check("REPLACE INTO device_keys: BLOCK",
          blocks("sqlite3 %s \"REPLACE INTO device_keys (id) VALUES ('x')\"" % DB))
    check("upsert ON CONFLICT: BLOCK",
          blocks("sqlite3 %s \"INSERT INTO device_keys (id) VALUES ('x') ON CONFLICT(id) DO UPDATE SET scope='messages'\"" % DB))
    check("DROP TABLE device_keys: BLOCK", blocks("sqlite3 %s 'DROP TABLE device_keys'" % DB))
    check("ALTER TABLE device_keys: BLOCK",
          blocks("sqlite3 %s 'ALTER TABLE device_keys ADD COLUMN x TEXT'" % DB))
    check("CREATE TRIGGER writing device_keys: BLOCK",
          blocks("sqlite3 %s \"CREATE TRIGGER t AFTER INSERT ON kanban_cards BEGIN UPDATE device_keys SET scope='messages'; END\"" % DB))
    check("ATTACH + schema-qualified write: BLOCK",
          blocks("sqlite3 /tmp/x.db \"ATTACH '%s' AS m; INSERT INTO m.device_keys (id) VALUES ('x')\"" % ABSDB))
    check("quoted identifier: BLOCK", blocks("sqlite3 %s 'INSERT INTO \"device_keys\" (id) VALUES (1)'" % DB))
    check("lowercase SQL: BLOCK", blocks("sqlite3 %s \"insert into device_keys (id) values ('x')\"" % DB))
    check("sqlite_master write: BLOCK",
          blocks("sqlite3 %s \"PRAGMA writable_schema=1; UPDATE sqlite_master SET sql='x' WHERE name='device_keys'\"" % DB))
    check("-cmd carrying the write: BLOCK",
          blocks("sqlite3 -cmd \"%s\" %s .quit" % (KEY_INSERT, DB)))
    check("stdin heredoc into sqlite3: BLOCK",
          blocks("sqlite3 %s <<'SQL'\n%s;\nSQL" % (DB, KEY_INSERT)))
    check("stdin heredoc into sqlite3, kanban write: allowed",
          not blocks("sqlite3 %s <<'SQL'\n%s;\nSQL" % (DB, KANBAN_INSERT)))
    check("cat heredoc piped into sqlite3: BLOCK",
          blocks("cat <<'SQL' | sqlite3 %s\n%s;\nSQL" % (DB, KEY_INSERT)))
    check("echo piped into sqlite3: BLOCK", blocks('echo "%s" | sqlite3 %s' % (KEY_INSERT, DB)))
    check("printf piped into sqlite3, kanban: allowed",
          not blocks("printf '%%s' \"%s\" | sqlite3 %s" % (KANBAN_INSERT, DB)))
    check("sqlite3 via bash -c: BLOCK", blocks("bash -c 'sqlite3 %s \"DELETE FROM device_keys\"'" % DB))
    check("kanban comment whose double-quoted text names both words: allowed",
          not blocks("sqlite3 %s 'INSERT INTO kanban_comments (body) VALUES (\"the device_keys gate now blocks UPDATE\")'" % DB))
    check("python kanban write with a data literal naming both words: allowed",
          not blocks("python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('%s')\n"
                     "c.execute('INSERT INTO kanban_comments (body) VALUES (?)', ('the device_keys gate blocks UPDATE',))\nPY" % DB))
    # SQL is matched by grammar (UPDATE <t> ... SET), so prose that merely starts
    # with the verb is not a statement...
    check("python data literal 'UPDATE device_keys is now gated' (not a statement): allowed",
          not blocks("python3 - <<'PY'\nprint('UPDATE device_keys is now gated')\nPY"))
    # ...but a data literal that IS a complete statement cannot be told apart from
    # SQL by a static check, in an EXECUTED program. Blocked, by design.
    check("python data literal that is a full statement ('UPDATE device_keys SET ...'): blocks (stated cost)",
          blocks("python3 - <<'PY'\nprint('UPDATE device_keys SET scope = 1')\nPY"))
    check("ALTER TABLE x RENAME TO device_keys: BLOCK",
          blocks("sqlite3 %s 'ALTER TABLE shadow RENAME TO device_keys'" % DB))
    check("INSERT OR REPLACE INTO device_keys: BLOCK",
          blocks("sqlite3 %s \"INSERT OR REPLACE INTO device_keys (id) VALUES ('x')\"" % DB))
    check("the write as the second statement after a kanban write: BLOCK",
          blocks('sqlite3 %s "%s; %s"' % (DB, KANBAN_INSERT, KEY_INSERT)))

    sqlfile = os.path.join(TMP, "evil.sql")
    with open(sqlfile, "w") as fh:
        fh.write(KEY_INSERT + ";\n")
    okfile = os.path.join(TMP, "kanban.sql")
    with open(okfile, "w") as fh:
        fh.write(KANBAN_INSERT + ";\nSELECT * FROM device_keys;\n")
    check(".read of a file holding the write: BLOCK", blocks("sqlite3 %s '.read %s'" % (DB, sqlfile)))
    check(".read of a kanban-only file: allowed", not blocks("sqlite3 %s '.read %s'" % (DB, okfile)))
    check("< redirect of the evil file: BLOCK", blocks("sqlite3 %s < %s" % (DB, sqlfile)))
    check("< redirect of the kanban file: allowed", not blocks("sqlite3 %s < %s" % (DB, okfile)))
    check(".read of a file written in the same command (unreadable now): BLOCK",
          blocks("cat > /tmp/nope-%d.sql <<'EOF'\n%s;\nEOF\nsqlite3 %s '.read /tmp/nope-%d.sql'"
                 % (os.getpid(), KEY_INSERT, DB, os.getpid())))
    check(".import into device_keys: BLOCK", blocks("sqlite3 %s '.import --csv k.csv device_keys'" % DB))
    check(".import into kanban_cards: allowed", not blocks("sqlite3 %s '.import --csv k.csv kanban_cards'" % DB))
    check(".restore onto the live DB: BLOCK", blocks("sqlite3 %s '.restore /tmp/other.db'" % DB))
    check(".backup onto the live DB: BLOCK", blocks("sqlite3 /tmp/other.db '.backup %s'" % ABSDB))
    check(".backup OF the live DB elsewhere: allowed", not blocks("sqlite3 %s '.backup /tmp/b.db'" % DB))

    print()
    print("SQL -- inside interpreter payloads:")
    check("python -c sqlite3 execute INSERT device_keys: BLOCK",
          blocks("python3 -c \"import sqlite3; c=sqlite3.connect('%s'); c.execute(\\\"%s\\\"); c.commit()\""
                 % (DB, KEY_INSERT.replace("'", "\\'"))))
    check("python -c, plain quoting: BLOCK",
          blocks("python3 -c \"import sqlite3; sqlite3.connect('%s').execute('DELETE FROM device_keys')\"" % DB))
    check("python -c, plain quoting, kanban: allowed",
          not blocks("python3 -c \"import sqlite3; sqlite3.connect('%s').execute('DELETE FROM kanban_cards')\"" % DB))
    check("python heredoc UPDATE device_keys: BLOCK",
          blocks("python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('%s')\n"
                 "c.execute(\"UPDATE device_keys SET sender_id = ? WHERE id = ?\", ('hanna', 'x'))\nc.commit()\nPY" % DB))
    check("python heredoc kanban INSERT: allowed",
          not blocks("python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('%s')\n"
                     "c.execute(\"INSERT INTO kanban_cards (id, title) VALUES (?, ?)\", ('c', 'device_keys docs'))\n"
                     "c.commit()\nPY" % DB))
    check("python heredoc SELECT FROM device_keys: allowed",
          not blocks("python3 - <<'PY'\nimport sqlite3\nc = sqlite3.connect('%s')\n"
                     "print(c.execute('SELECT id, scope FROM device_keys').fetchall())\nPY" % DB))
    check("python triple-quoted multi-line SQL: BLOCK",
          blocks("python3 - <<'PY'\nimport sqlite3\nsqlite3.connect('%s').executescript('''\n"
                 "INSERT INTO device_keys (id)\nVALUES ('x');\n''')\nPY" % DB))
    check("node better-sqlite3 prepare().run(): BLOCK",
          blocks("node -e \"const D=require('better-sqlite3'); new D('%s').prepare('DELETE FROM device_keys').run()\"" % DB))
    check("node better-sqlite3 kanban: allowed",
          not blocks("node -e \"const D=require('better-sqlite3'); new D('%s').prepare('DELETE FROM kanban_cards WHERE id=1').run()\"" % DB))
    check("node template literal: BLOCK",
          blocks("node - <<'JS'\nconst D = require('better-sqlite3')\nnew D('%s').exec(`\n  UPDATE device_keys SET scope = 'messages'\n`)\nJS" % DB))

    print()
    print("SQL -- reads and prose stay allowed:")
    for c in ("sqlite3 %s 'SELECT * FROM device_keys'" % DB,
              "sqlite3 %s \"SELECT id, replace(scope, 'a', 'b') FROM device_keys\"" % DB,
              "sqlite3 %s '.schema device_keys'" % DB,
              "sqlite3 %s .tables" % DB,
              "sqlite3 -readonly %s 'PRAGMA table_info(device_keys)'" % DB,
              "sqlite3 %s <<'SQL'\nSELECT count(*) FROM device_keys;\n.schema device_keys\nSQL" % DB,
              'echo "%s"' % KEY_INSERT,
              "printf '%%s\\n' '%s'" % KEY_INSERT.replace("'", ""),
              "git commit -m \"gate: block INSERT INTO device_keys from agent Bash\"",
              "grep -rn 'INSERT INTO device_keys' src/ scripts/",
              "rg -n 'UPDATE device_keys' .",
              "git diff -- src/device-keys.ts",
              "cat scripts/hooks/device-keys-gate.py",
              "# sqlite3 store/claudeclaw.db 'DELETE FROM device_keys'\nls",
              "cat > /tmp/notes.md <<'EOF'\nsqlite3 store/claudeclaw.db \"%s\"\nEOF" % KEY_INSERT,
              "curl -s -X POST http://localhost:3420/api/messages -H 'Content-Type: application/json' "
              "-d '{\"from\":\"agent-a\",\"to\":\"agent-b\",\"content\":\"DELETE FROM device_keys is now gated\"}'",
              "bash -c 'echo \"UPDATE device_keys is blocked\"'",
              "sqlite3 /tmp/scratch.db 'CREATE TABLE notes (t TEXT)'"):
        check("allowed: " + c.split("\n")[0][:72], not blocks(c))

    # --- 3. replacing the DB file ---------------------------------------------
    print()
    print("DB FILE -- overwrite blocked, copying it out allowed:")
    check("cp onto store/claudeclaw.db: BLOCK", blocks("cp /tmp/forged.db " + DB))
    check("cp OUT of the live DB (backup): allowed", not blocks("cp %s /tmp/backup.db" % DB))
    check("cp to /tmp/claudeclaw.db (backup copy): allowed", not blocks("cp %s /tmp/claudeclaw.db" % DB))
    check("mv onto the -wal sidecar: BLOCK", blocks("mv /tmp/x " + DB + "-wal"))
    check("install onto the DB: BLOCK", blocks("install -m 600 /tmp/x " + ABSDB))
    check("rsync onto the DB: BLOCK", blocks("rsync -a /tmp/x " + DB))
    check("cp into the store/ dir under the DB name: BLOCK", blocks("cp /tmp/claudeclaw.db store/"))
    check("cp -t store/ claudeclaw.db: BLOCK", blocks("cp -t store /tmp/claudeclaw.db"))
    check("tee onto the DB: BLOCK", blocks("cat /tmp/x | tee " + DB))
    check("dd of= the DB: BLOCK", blocks("dd if=/tmp/x of=" + DB))
    check("> redirect onto the DB: BLOCK", blocks("cat /tmp/x > " + DB))
    check(">> redirect onto the -journal: BLOCK", blocks("printf x >> " + DB + "-journal"))
    check("cd store && cp x claudeclaw.db: BLOCK", blocks("cd store && cp /tmp/x claudeclaw.db", ROOT))
    check("unresolvable dir naming the DB: BLOCK", blocks('cp /tmp/x "$STORE/claudeclaw.db"'))
    check("redirect inside a quoted string: allowed", not blocks('echo "do not cat x > %s"' % DB))
    check("redirect to another file: allowed", not blocks("sqlite3 %s .dump > /tmp/dump.sql" % DB))
    check("python shutil.copy onto the DB: BLOCK",
          blocks("python3 -c \"import shutil; shutil.copy('/tmp/x', '%s')\"" % ABSDB))
    check("python open(DB,'rb') read: allowed",
          not blocks("python3 -c \"print(len(open('%s','rb').read()))\"" % ABSDB))
    print()
    print("DB FILE -- the file tools:")
    check("Write onto store/claudeclaw.db: BLOCK", blocks_file("Write", ABSDB))
    check("Edit onto the -shm sidecar: BLOCK", blocks_file("Edit", ABSDB + "-shm"))
    check("Write onto a normal file: allowed", not blocks_file("Write", ROOT + "/README.md"))
    check("Write onto /tmp/claudeclaw.db: allowed", not blocks_file("Write", "/tmp/claudeclaw.db"))

    # --- 4. the hook contract end to end ---------------------------------------
    print()
    print("HOOK CONTRACT -- exit codes and the message:")
    rc, err = hook(bash_ev("npm run voice-relay-key -- mint --out k"))
    check("mint via the hook: exit 2", rc == 2)
    check("the reason names the gate", "DEVICE-KEYS-GATE" in err)
    check("the reason says there is no agent-side override", "no override" in err)
    check("the reason hands over the human-terminal command",
          ("cd %s && npm run voice-relay-key -- mint --out <file>" % ROOT) in err)
    check("the reason does NOT claim the ! bash mode bypass", "bash mode" not in err and "`!`" not in err)
    rc, _ = hook(bash_ev("npm run voice-relay-key -- list"))
    check("list via the hook: exit 0", rc == 0)
    rc, _ = hook(bash_ev("sqlite3 %s \"%s\"" % (DB, KEY_INSERT), ROOT))
    check("device_keys INSERT via the hook: exit 2", rc == 2)
    rc, _ = hook(bash_ev("sqlite3 %s \"%s\"" % (DB, KANBAN_INSERT), ROOT))
    check("kanban INSERT via the hook: exit 0", rc == 0)
    rc, _ = hook({"tool_name": "Write", "tool_input": {"file_path": ABSDB, "content": "x"}})
    check("Write onto the DB via the hook: exit 2", rc == 2)
    rc, _ = hook({"tool_name": "Read", "tool_input": {"file_path": ABSDB}})
    check("Read of the DB via the hook: exit 0", rc == 0)
    rc, _ = hook({"tool_name": "WebFetch", "tool_input": {"url": "https://example.invalid"}})
    check("an unrelated tool: exit 0", rc == 0)
    # cwd from the event is what resolves a relative .read file.
    rc, _ = hook(bash_ev("sqlite3 %s '.read evil.sql'" % DB, TMP))
    check("relative .read resolved against the event cwd: exit 2", rc == 2)

    # --- 5. a real DB: the verdict matches what the SQL would do ---------------
    # A positive control on the PREMISE: the allowed kanban write really writes,
    # the blocked statement really would have reached device_keys. Run on a
    # scratch DB, never the install's.
    print()
    print("CONTROL -- the blocked SQL is a real device_keys write, the allowed one is not:")
    scratch = os.path.join(TMP, "store", "claudeclaw.db")
    os.makedirs(os.path.dirname(scratch))
    con = sqlite3.connect(scratch)
    con.execute("CREATE TABLE device_keys (id TEXT PRIMARY KEY, scope TEXT, sender_id TEXT)")
    con.execute("CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT)")
    con.commit()
    con.execute(KANBAN_INSERT)
    con.execute(KEY_INSERT)
    con.commit()
    n_keys = con.execute("SELECT count(*) FROM device_keys").fetchone()[0]
    n_cards = con.execute("SELECT count(*) FROM kanban_cards").fetchone()[0]
    con.close()
    check("the blocked statement writes device_keys on a real DB", n_keys == 1)
    check("the allowed statement writes kanban_cards and not device_keys", n_cards == 1)
    check("the gate recognizes the scratch store/claudeclaw.db as a live-DB path",
          gate.is_live_db_path(scratch, None))

    # --- 6. failure mode: a crash degrades to the raw check, not to an outage ---
    print()
    print("FAILURE MODE -- internal error falls back to the raw check:")

    def faulty_copy(with_dg):
        d = tempfile.mkdtemp(dir=TMP)
        src = open(GATE, encoding="utf-8").read()
        fault = ("\n\ndef check_tool(ev):\n"
                 "    raise ValueError('deliberately injected fault')\n\n")
        i = src.index("if __name__ ==")
        open(os.path.join(d, "device-keys-gate.py"), "w", encoding="utf-8").write(src[:i] + fault + src[i:])
        shutil.copy(os.path.join(HOOKS, "hook_errlog.py"), d)
        if with_dg:
            shutil.copy(os.path.join(HOOKS, "destructive-gate.py"), d)
        return os.path.join(d, "device-keys-gate.py")

    fg = faulty_copy(True)
    check("crash + benign command: exit 0 (Bash not wedged)", hook(bash_ev("ls -la"), fg)[0] == 0)
    check("crash + kanban write: exit 0",
          hook(bash_ev('sqlite3 %s "%s"' % (DB, KANBAN_INSERT.replace("device_keys ", ""))), fg)[0] == 0)
    rc, err = hook(bash_ev('sqlite3 %s "%s"' % (DB, KEY_INSERT)), fg)
    check("crash + device_keys INSERT: exit 2 by the raw check", rc == 2 and "fallback" in err)
    check("crash + mint: exit 2 by the raw check",
          hook(bash_ev("npm run voice-relay-key -- mint"), fg)[0] == 2)
    check("crash + list: exit 0", hook(bash_ev("npm run voice-relay-key -- list"), fg)[0] == 0)
    log = open(ENV["HOOK_ERRLOG_PATH"], encoding="utf-8").read() if os.path.exists(ENV["HOOK_ERRLOG_PATH"]) else ""
    check("the crash is logged with the exception type", "ValueError" in log)
    check("...and not with its message", "deliberately injected fault" not in log)
    check("the log does not carry the command", "kanban_cards" not in log and "hanna" not in log)

    # destructive-gate.py missing next to the gate: the import fails, same fallback.
    d = tempfile.mkdtemp(dir=TMP)
    shutil.copy(GATE, d)
    lone = os.path.join(d, "device-keys-gate.py")
    check("parser module missing + benign command: exit 0", hook(bash_ev("ls"), lone)[0] == 0)
    check("parser module missing + device_keys DELETE: exit 2",
          hook(bash_ev("sqlite3 %s 'DELETE FROM device_keys'" % DB), lone)[0] == 2)

    check("unreadable input + benign text: exit 0", hook("not json")[0] == 0)
    check("unreadable input pairing device_keys with a write: exit 2",
          hook("{broken INSERT INTO device_keys")[0] == 2)
    check("raw fallback: prose that pairs the words also blocks (crude, documented)",
          gate.raw_fallback_blocks("echo 'INSERT INTO device_keys'"))
    check("raw fallback: SELECT alone passes", not gate.raw_fallback_blocks("SELECT * FROM device_keys"))

    # --- 7. destructive-gate is reused, not copied -----------------------------
    print()
    print("REUSE -- the shared parsing comes from destructive-gate.py:")
    check("the parser module is loaded", gate.dg is not None)
    check("it is destructive-gate.py itself",
          os.path.realpath(gate.dg.__file__) == os.path.realpath(os.path.join(HOOKS, "destructive-gate.py")))
    check("loading it did not swap destructive's block() (its verdicts play no part)",
          gate.dg.block.__module__ == gate.dg.__name__)


    # --- 8. the adversarial review (2026-10-22), every repro --------------------
    # The reviewer's probe set, verbatim apart from two placeholders: @ROOT@ is
    # the install root (the event cwd unless a case names another), @D@ the
    # directory holding evil.sql / good.sql. Each case runs through check_tool,
    # so the needle precheck is part of what is measured.
    print()
    print("REVIEW -- the adversarial probe set (FP = must allow, FN = must block):")
    D8 = os.path.join(TMP, "probe")
    os.makedirs(D8)
    with open(os.path.join(D8, "evil.sql"), "w") as fh:
        fh.write("UPDATE device_keys SET scope='messages';\n")
    with open(os.path.join(D8, "good.sql"), "w") as fh:
        fh.write("INSERT INTO kanban_cards(title) VALUES('x');\n")
    REVIEW_CASES = [
        ('fp', "sqlite3 store/claudeclaw.db 'SELECT * FROM device_keys'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "SELECT id, scope FROM device_keys WHERE sender_id=\'hanna\'"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "sqlite3 -header -column store/claudeclaw.db '.schema device_keys'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "sqlite3 store/claudeclaw.db 'PRAGMA table_info(device_keys)'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "INSERT INTO kanban_cards (title,status) VALUES (\'fix device_keys gate\',\'planned\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "UPDATE kanban_cards SET status=\'done\' WHERE id=\'abc\'"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id, content) VALUES (\'x\', \'UPDATE device_keys done\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "sqlite3 store/claudeclaw.db <<'SQL'\nINSERT INTO kanban_comments (card_id, content) VALUES ('x','blocked INSERT INTO device_keys path');\nSQL", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db <<\'SQL\'\nINSERT INTO kanban_cards (title) VALUES ("device_keys followup");\nSQL', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 -cmd \'.timeout 5000\' store/claudeclaw.db "INSERT INTO kanban_cards (title) VALUES (\'x\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'python3 - <<\'PY\'\nimport sqlite3\nc=sqlite3.connect(\'store/claudeclaw.db\')\nc.execute("INSERT INTO kanban_comments (card_id,content) VALUES (?,?)", (\'x\',\'device_keys write gate merged\'))\nc.commit()\nPY', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'python3 <<\'PY\'\nimport sqlite3\nc=sqlite3.connect(\'store/claudeclaw.db\')\nc.execute("UPDATE kanban_cards SET description=\'gate blocks INSERT INTO device_keys now\' WHERE id=?", (\'x\',))\nPY', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'python3 -c "import sqlite3;c=sqlite3.connect(\'store/claudeclaw.db\');c.execute(\'INSERT INTO kanban_cards (title) VALUES (?)\',(\'device_keys\',));c.commit()"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "git commit -m 'feat: device_keys write gate blocks INSERT INTO device_keys and voice-relay-key mint'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "git commit -F - <<'EOF'\nfeat(gate): block INSERT INTO device_keys\n\nvoice-relay-key mint is now human-only.\nEOF", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'gh pr create --title \'device-keys gate\' --body "Blocks \\`npm run voice-relay-key -- mint\\` and UPDATE device_keys SET scope"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'gh pr create --title x --body-file - <<\'EOF\'\n- blocks `npm run voice-relay-key mint`\n- blocks `sqlite3 db "INSERT INTO device_keys ..."`\nEOF', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'curl -s -X POST http://localhost:3420/api/messages -H \'Content-Type: application/json\' --data-binary @- <<\'JSON\'\n{"from":"agent-a","to":"agent-b","content":"PR 5: gate blocks INSERT INTO device_keys and npm run voice-relay-key mint"}\nJSON', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'curl -s -X POST http://localhost:3420/api/messages -d \'{"content":"run npm run voice-relay-key -- mint on host"}\'', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "grep -rn 'INSERT INTO device_keys' src scripts", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "rg 'voice-relay-key.*mint' -n .", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'cat scripts/hooks/device-keys-gate.py', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sed -n 1,80p scripts/hooks/device-keys-gate.py', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'python3 scripts/__tests__/device-keys-gate.test.py', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'npx vitest run src/__tests__/device-keys-gate-wiring.test.ts', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'npm run voice-relay-key -- list', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'npm run voice-relay-key list', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "sqlite3 store/claudeclaw.db '.backup /tmp/x.db'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db ".backup \'store/backup-2026.db\'"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'cp store/claudeclaw.db /tmp/x.db', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'cp store/claudeclaw.db store/claudeclaw.db.bak', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db \'VACUUM INTO "/tmp/claudeclaw-copy.db"\'', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "echo 'remember: INSERT INTO device_keys is blocked'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "printf '%s\\n' 'UPDATE device_keys SET scope=1' > /tmp/notes.txt", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'cat > /tmp/plan.md <<\'EOF\'\nsqlite3 store/claudeclaw.db "INSERT INTO device_keys VALUES(1)"\nnpm run voice-relay-key -- mint --out k\nEOF', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', "git log --oneline --grep='device_keys'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'git diff -- scripts/hooks/device-keys-gate.py', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'node -e "console.log(\'UPDATE device_keys\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "SELECT replace(name,\'a\',\'b\') FROM device_keys"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "CREATE TABLE IF NOT EXISTS notes (txt TEXT); INSERT INTO notes VALUES (\'re: device_keys\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "SELECT * FROM kanban_cards" > /tmp/out.txt', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "CREATE INDEX IF NOT EXISTS idx_k ON kanban_cards(status)"; echo device_keys', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "UPDATE kanban_cards SET title=\\"device_keys\\" WHERE 1=0"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'sqlite3 store/claudeclaw.db "INSERT INTO memories(content) VALUES (\'a; DELETE FROM device_keys\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'vim store/claudeclaw.db', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'ls -la store/claudeclaw.db*', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp', 'tail -f store/claudeclaw.db-wal | head -c 10 > /dev/null', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', "python3 - <<'PY'\nimport json\nopen('/tmp/p.json','w').write(json.dumps({'from':'agent-a','to':'agent-b','content':'Gate blocks INSERT INTO device_keys and UPDATE device_keys SET scope'}))\nPY\ncurl -s --data-binary @/tmp/p.json http://localhost:3420/api/messages", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', "python3 - <<'PY'\nimport sqlite3\nc=sqlite3.connect('store/claudeclaw.db')\nc.execute('INSERT INTO kanban_comments (card_id,content) VALUES (?,?)', ('x', 'Review: UPDATE device_keys SET sender_id is reachable'))\nPY", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'python3 -c "print(\'npm run voice-relay-key -- mint\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'node -e "console.log(require(\'fs\').readFileSync(\'scripts/voice-relay-key.ts\',\'utf8\').length)"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', "python3 - <<'PY'\nimport re\nsrc=open('scripts/voice-relay-key.ts').read()\nprint('createDeviceKey(' in src)\nPY", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'npx tsx scripts/voice-relay-key.ts list', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'npx tsx scripts/voice-relay-key.ts --help', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'npm run voice-relay-key -- list --mint-only-hint', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'cat store/claudeclaw.db > /tmp/copy.db', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'sqlite3 store/claudeclaw.db .dump > /tmp/dump.sql', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'sqlite3 /tmp/other.db "INSERT INTO device_keys VALUES (1)"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'sqlite3 store/claudeclaw.db "DELETE FROM kanban_cards WHERE title LIKE \'%device_keys%\'"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', "ccq add 'refactor: move device_keys INSERT INTO helper, keep voice-relay-key mint human-only'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', "bash -c 'echo UPDATE device_keys'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'rm -f /tmp/claudeclaw.db', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp2', 'cp /tmp/x.db /tmp/claudeclaw.db', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "INSERT INTO kanban_cards (id,title,status,priority,created_at,updated_at) VALUES (\'card_$(python3 -c \'import time;print(int(time.time()*1000))\')\',\'Device keys gate: block INSERT INTO device_keys\',\'planned\',\'normal\',strftime(\'%s\',\'now\'),strftime(\'%s\',\'now\'))"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'T=$(echo "device_keys gate can\'t block UPDATE device_keys via vars" | sed "s/\'/\'\'/g"); sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id,author,content,created_at,automated) VALUES (\'c1\',\'agent-a\',\'$T\',strftime(\'%s\',\'now\'),0)"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id,author,content,created_at,automated) VALUES (\'c1\',\'agent-a\',\'Review: DELETE FROM device_keys is gated; can\'\'t mint\',strftime(\'%s\',\'now\'),0)"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "select id,to_agent,status from agent_messages where from_agent=\'agent-c\' and created_at > strftime(\'%s\',\'now\',\'-15 minutes\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "UPDATE kanban_cards SET description = description || \' -- device_keys INSERT path closed\' WHERE id=\'x\'"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (content) VALUES (\\"plain dq: UPDATE device_keys SET scope\\")"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fp3', 'sqlite3 store/claudeclaw.db "INSERT INTO memories (agent_id, content, keywords) VALUES (\'agent-a\', \'device-keys gate, INSERT INTO device_keys, voice-relay-key mint\', \'gate\')"', 'ALLOW', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db "insert into Device_Keys values (1)"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db \'INSERT INTO "device_keys" VALUES (1)\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT INTO [device_keys] VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT INTO main.device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db \'INSERT INTO main."device_keys" VALUES (1)\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db \'INSERT INTO "main"."device_keys" VALUES (1)\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT INTO `device_keys` VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT   INTO\n  device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT/**/INTO/**/device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT OR REPLACE INTO device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'REPLACE INTO device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT INTO device_keys(id) VALUES (1) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db \'SELECT 1; UPDATE device_keys SET sender_id="hanna"\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'UPDATE device_keys AS d SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'WITH x AS (SELECT 1) INSERT INTO device_keys SELECT * FROM x'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'INSERT INTO device_keys SELECT * FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'DROP TABLE device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'ALTER TABLE device_keys RENAME TO x'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db "CREATE TRIGGER t AFTER INSERT ON kanban_cards BEGIN UPDATE device_keys SET scope=\'messages\'; END"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 store/claudeclaw.db "ATTACH \'store/claudeclaw.db\' AS m; INSERT INTO m.device_keys VALUES(1)"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sqlite3 /tmp/x.db "ATTACH \'@ROOT@/store/claudeclaw.db\' AS m; INSERT INTO m.device_keys VALUES(1)"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'echo "INSERT INTO device_keys VALUES (1);" | sqlite3 store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "printf 'INSERT INTO device_keys VALUES (1);' | sqlite3 store/claudeclaw.db", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "echo 'UPDATE device_keys SET scope=1;' | sqlite3 -batch store/claudeclaw.db", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db <<< 'INSERT INTO device_keys VALUES (1)'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db <<'SQL'\nUPDATE device_keys SET sender_id='hanna';\nSQL", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db <<SQL\nUPDATE device_keys SET sender_id='hanna';\nSQL", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "cat <<'SQL' | sqlite3 store/claudeclaw.db\nUPDATE device_keys SET sender_id='hanna';\nSQL", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 -cmd 'UPDATE device_keys SET scope=1' store/claudeclaw.db .quit", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db -cmd 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "cd store && sqlite3 claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "(cd store; sqlite3 claudeclaw.db 'UPDATE device_keys SET scope=1')", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "FOO=1 sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "env sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "env -i PATH=/usr/bin sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "nohup sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "timeout 5 sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "nice -n 5 sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "command sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "exec sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "time sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "/usr/bin/sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "echo store/claudeclaw.db | xargs -I{} sqlite3 {} 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "xargs sqlite3 store/claudeclaw.db < /dev/null 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'bash -c "sqlite3 store/claudeclaw.db \'UPDATE device_keys SET scope=1\'"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', 'sh -c \'sqlite3 store/claudeclaw.db "UPDATE device_keys SET scope=1"\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "zsh -c 'npm run voice-relay-key -- mint --out /tmp/k'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "$(sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1')", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "echo `sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'`", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "{ sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'; }", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "if true; then sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'; fi", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "for i in 1; do sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'; done", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "true && sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1' &", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1' &", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'&", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "watch -n1 sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn', "sudo sqlite3 store/claudeclaw.db 'UPDATE device_keys SET scope=1'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm run voice-relay-key mint --out /tmp/k', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm run voice-relay-key -- mint --out /tmp/k', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm run-script voice-relay-key -- mint --out /tmp/k', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm run --silent voice-relay-key -- mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm --prefix @ROOT@ run voice-relay-key -- mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm -C @ROOT@ run voice-relay-key mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm exec -- tsx scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'bun run voice-relay-key mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'bun voice-relay-key mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'bun run scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'pnpm voice-relay-key mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'yarn voice-relay-key mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npx tsx scripts/voice-relay-key.ts mint --out /tmp/k', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npx --yes tsx ./scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node --import tsx scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node --loader ts-node/esm scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node_modules/.bin/tsx scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', './node_modules/.bin/tsx scripts/voice-relay-key.ts MINT', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "tsx scripts/voice-relay-key.ts 'mint'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'tsx scripts/voice-relay-key.ts "mint" --out k', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'tsx scripts/voice-relay-key.ts mi\\nt', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "tsx scripts/voice-relay-key.ts m''int", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'cd scripts && npx tsx voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'env -i PATH=$PATH npm run voice-relay-key -- mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'NODE_ENV=x npm run voice-relay-key -- mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'timeout 30 npm run voice-relay-key -- mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'nohup npm run voice-relay-key -- mint &', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'echo mint | xargs npm run voice-relay-key --', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'echo mint | xargs tsx scripts/voice-relay-key.ts', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npm run voice-relay-key -- $CMD', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'tsx -e "import(\'./scripts/voice-relay-key.ts\').then(m=>m.runVoiceRelayKey([\'mint\']))"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'npx tsx -e "import {createDeviceKey} from \'./src/db.ts\'; createDeviceKey({scope:\'messages\',senderId:\'hanna\'})"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node -e "require(\'./dist/device-keys.js\').createDeviceKey({})"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node --input-type=module -e "const m=await import(\'./dist/db.js\'); m.createDeviceKey({})"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "npx tsx <<'TS'\nimport { createDeviceKey } from './src/db.ts'\ncreateDeviceKey({scope:'messages'})\nTS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "cat <<'TS' | npx tsx -\nimport { createDeviceKey } from './src/db.ts'\nTS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node -e "const D=require(\'better-sqlite3\');new D(\'store/claudeclaw.db\').prepare(\\"INSERT INTO device_keys (id) VALUES (1)\\").run()"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node -e \'const D=require("better-sqlite3");new D("store/claudeclaw.db").exec("UPDATE device_keys SET scope=1")\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'node -e \'const D=require("better-sqlite3");new D("store/claudeclaw.db").exec(`UPDATE device_keys SET scope=1`)\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3 -c "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'UPDATE device_keys SET scope=1\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3 -c \'import sqlite3;sqlite3.connect("store/claudeclaw.db").execute("UPDATE device_keys SET scope=1")\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "python3 - <<'PY'\nimport sqlite3\nc=sqlite3.connect('store/claudeclaw.db')\nc.execute('''UPDATE device_keys\n SET sender_id='hanna' ''')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3 - <<\'PY\'\nimport sqlite3\nc=sqlite3.connect(\'store/claudeclaw.db\')\nc.execute(f"UPDATE device_keys SET scope={1}")\nPY', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "python3 - <<'PY'\nimport sqlite3\nc=sqlite3.connect('store/claudeclaw.db')\nc.execute(r'UPDATE device_keys SET scope=1')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3 - <<\'PY\'\nimport sqlite3\nc=sqlite3.connect(\'store/claudeclaw.db\')\nc.executescript("""\nINSERT INTO kanban_cards(title) VALUES (\'it\'\'s\');\nUPDATE device_keys SET scope=1;\n""")\nPY', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3 - <<\'PY\'\nimport sqlite3\nc=sqlite3.connect(\'store/claudeclaw.db\')\nc.execute("INSERT INTO kanban_cards(title) VALUES (\'it\'\'s\'); UPDATE device_keys SET scope=1")\nPY', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "python3 <<'PY'\nimport sqlite3\nsqlite3.connect('store/claudeclaw.db').execute('DELETE FROM device_keys')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "python <<'PY'\nimport sqlite3\nsqlite3.connect('store/claudeclaw.db').execute('DELETE FROM device_keys')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', "/usr/bin/python3 - <<'PY'\nimport sqlite3\nsqlite3.connect('store/claudeclaw.db').execute('DELETE FROM device_keys')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'uv run python -c "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'python3.12 -c "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'echo "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')" | python3', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'echo "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')" | python3 -', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'bun -e "import {Database} from \'bun:sqlite\'; new Database(\'store/claudeclaw.db\').run(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn2', 'deno eval "1"; bun -e \'new (require("bun:sqlite").Database)("store/claudeclaw.db").run("DELETE FROM device_keys")\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', './node_modules/.bin/tsx scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'node_modules/.bin/tsx scripts/voice-relay-key.ts mint', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.read @D@/evil.sql'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.read @D@/good.sql'", 'ALLOW', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 store/claudeclaw.db < @D@/evil.sql', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 store/claudeclaw.db < @D@/good.sql', 'ALLOW', '@ROOT@', 'Bash'),
        ('fn3', 'cat @D@/evil.sql | sqlite3 store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 -init @D@/evil.sql store/claudeclaw.db .quit', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 store/claudeclaw.db ".read \'|cat @D@/evil.sql\'"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.import /tmp/k.csv device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.import --csv /tmp/k.csv device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.restore /tmp/evil.db'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.shell npm run voice-relay-key -- mint --out /tmp/k'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 store/claudeclaw.db '.system npm run voice-relay-key -- mint --out /tmp/k'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 /tmp/x.db '.backup store/claudeclaw.db'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', "sqlite3 /tmp/x.db '.backup main store/claudeclaw.db'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 /tmp/x.db "VACUUM INTO \'store/claudeclaw.db\'"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 /tmp/x.db "VACUUM INTO \'@ROOT@/store/claudeclaw.db\'"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp -f /tmp/evil.db @ROOT@/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.db ../../store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/claudeclaw.db store/', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/claudeclaw.db store', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp -t store /tmp/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'mv /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'mv store/claudeclaw.db store/old.db && mv /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'rsync -a /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'ln -sf /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'install -m600 /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db > store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db >store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db 1> store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db >| store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db > "store/claudeclaw.db"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.wal > store/claudeclaw.db-wal', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.wal store/claudeclaw.db-wal', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'dd if=/tmp/evil.db of=store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'tee store/claudeclaw.db < /tmp/evil.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cat /tmp/evil.db | tee -a store/claudeclaw.db >/dev/null', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.db $HOME/marveen/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.db ~/marveen/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cd @ROOT@/store && cp /tmp/evil.db claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cd store; cp /tmp/evil.db ./claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'python3 -c "import shutil;shutil.copy(\'/tmp/evil.db\',\'store/claudeclaw.db\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'python3 -c "import shutil;shutil.copyfile(\'/tmp/evil.db\',\'@ROOT@/store/claudeclaw.db\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'node -e "require(\'fs\').copyFileSync(\'/tmp/evil.db\',\'store/claudeclaw.db\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'find /tmp -name evil.db -exec cp {} store/claudeclaw.db \\;', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'cp /tmp/evil.db store/claudeclaw.db.tmp && mv store/claudeclaw.db.tmp store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'gzip -dc /tmp/e.gz > store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'curl -o store/claudeclaw.db http://x/evil.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'curl http://x/evil.db --output store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn3', 'sqlite3 store/claudeclaw.db "DELETE FROM kanban_cards"; sqlite3 store/claudeclaw.db "UPDATE device_keys SET scope=1"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'cp /tmp/evil.db ./claudeclaw.db', 'BLOCK', '@ROOT@/store', 'Bash'),
        ('fn4', 'cp /tmp/evil.db claudeclaw.db', 'BLOCK', '@ROOT@/store', 'Bash'),
        ('fn4', 'cp /tmp/evil.db .', 'ALLOW', '@ROOT@/store', 'Bash'),
        ('fn4', 'cp /tmp/evil.db store/claudeclaw.db', 'BLOCK', '@ROOT@/agents/worker', 'Bash'),
        ('fn4', 'node --no-warnings -e "require(\'better-sqlite3\')(\'store/claudeclaw.db\').exec(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'python3 -X utf8 -c "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'python3 -I -c "import sqlite3;sqlite3.connect(\'store/claudeclaw.db\').execute(\'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "python3 -u - <<'PY'\nimport sqlite3;sqlite3.connect('store/claudeclaw.db').execute('DELETE FROM device_keys')\nPY", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'tsx --tsconfig t.json -e "import {createDeviceKey} from \'./src/web/auth-device-keys.ts\'; createDeviceKey(\'x\',{})"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "tsx <<'TS'\nimport { createDeviceKey } from './src/web/auth-device-keys.ts'\ncreateDeviceKey('x',{scope:'messages'})\nTS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "node <<'JS'\nrequire('better-sqlite3')('store/claudeclaw.db').exec('DELETE FROM device_keys')\nJS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "node - <<'JS'\nrequire('better-sqlite3')('store/claudeclaw.db').exec('DELETE FROM device_keys')\nJS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "node --input-type=module <<'JS'\nimport D from 'better-sqlite3'; D('store/claudeclaw.db').exec('DELETE FROM device_keys')\nJS", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'perl -e \'system("sqlite3 store/claudeclaw.db \\"DELETE FROM device_keys\\"")\'', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'python3 -c "import os;os.system(\'npm run voice-relay-key -- mint --out /tmp/k\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'python3 -c "import subprocess;subprocess.run([\'npm\',\'run\',\'voice-relay-key\',\'--\',\'mint\'])"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'node -e "require(\'child_process\').execSync(\'npm run voice-relay-key -- mint\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'python3 -c "import subprocess;subprocess.run([\'sqlite3\',\'store/claudeclaw.db\',\'DELETE FROM device_keys\'])"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "env -u FOO sqlite3 store/claudeclaw.db 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "env -- sqlite3 store/claudeclaw.db 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'eval "sqlite3 store/claudeclaw.db \'DELETE FROM device_keys\'"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "eval 'npm run voice-relay-key -- mint'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "bash <<'SH'\nnpm run voice-relay-key -- mint --out /tmp/k\nSH", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "bash -s <<'SH'\nsqlite3 store/claudeclaw.db 'DELETE FROM device_keys'\nSH", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "echo 'npm run voice-relay-key -- mint' | bash", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "echo 'npm run voice-relay-key -- mint' | sh -s", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'sqlite3 store/claudeclaw.db "$(echo \'DELETE FROM device_keys\')"', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', 'sqlite3 store/claudeclaw.db "DELETE FROM device_keys" 2>/dev/null || true', 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 store/claudeclaw.db 'DELETE FROM device_keys' > /dev/null 2>&1", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 store/claudeclaw.db 2>/dev/null 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 -bail -echo store/claudeclaw.db 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 -separator , store/claudeclaw.db 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 --cmd 'DELETE FROM device_keys' store/claudeclaw.db", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 store/claudeclaw.db '.mode list' 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('fn4', "sqlite3 'file:store/claudeclaw.db?mode=rw' 'DELETE FROM device_keys'", 'BLOCK', '@ROOT@', 'Bash'),
        ('ft', '@ROOT@/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Write'),
        ('ft', '@ROOT@/store/claudeclaw.db-wal', 'BLOCK', '@ROOT@', 'Write'),
        ('ft', '@ROOT@/store/../store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Write'),
        ('ft', '@ROOT@/agents/worker/../../store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Write'),
        ('ft', 'store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Write'),
        ('ft', 'claudeclaw.db', 'BLOCK', '@ROOT@/store', 'Write'),
        ('ft', '@ROOT@/store/notes.md', 'ALLOW', '@ROOT@', 'Write'),
        ('ft', '/tmp/claudeclaw.db', 'ALLOW', '@ROOT@', 'Write'),
        ('ft', '@ROOT@/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'Edit'),
        ('ft', '@ROOT@/store/claudeclaw.db', 'BLOCK', '@ROOT@', 'NotebookEdit'),
    ]
    # One case deliberately differs from the reviewer's expectation:
    # `cp /tmp/evil.db .` in store/ writes store/evil.db and replaces nothing.
    # Its twin that DOES replace the DB is pinned right below.

    def verdict(cmd, cwd, tool):
        ev = {"tool_name": tool, "cwd": cwd,
              "tool_input": {"command": cmd} if tool == "Bash" else {"file_path": cmd, "content": "x"}}
        try:
            gate.check_tool(ev)
            return "ALLOW"
        except gate.GateError:
            return "BLOCK"

    for group, cmd, want, cwd, tool in REVIEW_CASES:
        cmd = cmd.replace("@ROOT@", ROOT).replace("@D@", D8)
        cwd = cwd.replace("@ROOT@", ROOT)
        check("%s %s: %s" % (group, want, cmd.split("\n")[0][:80]), verdict(cmd, cwd, tool) == want)
    check("cp /tmp/claudeclaw.db . in store/ (does replace the DB): BLOCK",
          verdict("cp /tmp/claudeclaw.db .", ROOT + "/store", "Bash") == "BLOCK")

    print()
    print("REVIEW -- named repros of the findings:")
    # 2. interpreter flags before -c/-e
    for c in ("python3 -I -c \"import sqlite3;sqlite3.connect('%s').execute('DELETE FROM device_keys')\"" % DB,
              "python3 -X utf8 -c \"import sqlite3;sqlite3.connect('%s').execute('DELETE FROM device_keys')\"" % DB,
              "python3.12 -c \"import sqlite3;sqlite3.connect('%s').execute('DELETE FROM device_keys')\"" % DB,
              "node --no-warnings -e \"require('better-sqlite3')('%s').exec('DELETE FROM device_keys')\"" % DB,
              "node --input-type=module -e \"const m=await import('./dist/db.js'); m.createDeviceKey({})\"",
              "tsx --tsconfig t.json -e \"import {createDeviceKey} from './src/x.ts'; createDeviceKey('x',{})\""):
        check("flags before -c/-e: BLOCK: " + c[:60], blocks(c, ROOT))
    # 3. runners
    check("npx tsx <<TS: BLOCK", blocks("npx tsx <<'TS'\nimport { createDeviceKey } from './src/db.ts'\ncreateDeviceKey({})\nTS"))
    check("cat <<TS | npx tsx -: BLOCK", blocks("cat <<'TS' | npx tsx -\nimport { createDeviceKey } from './src/db.ts'\nTS"))
    check("npm exec -- tsx -e: BLOCK", blocks("npm exec -- tsx -e \"createDeviceKey({})\""))
    check("pnpm dlx tsx file mint: BLOCK", blocks("pnpm dlx tsx scripts/voice-relay-key.ts mint"))
    # 4. piped / eval'd shell
    check("echo '...mint' | bash: BLOCK", blocks("echo 'npm run voice-relay-key -- mint' | bash"))
    check("echo '...mint' | sh -s: BLOCK", blocks("echo 'npm run voice-relay-key -- mint' | sh -s"))
    check("echo '...list' | bash: allowed", not blocks("echo 'npm run voice-relay-key -- list' | bash"))
    check("echo '<py>' | python3 (no -): BLOCK",
          blocks("echo \"import sqlite3;sqlite3.connect('%s').execute('DELETE FROM device_keys')\" | python3" % DB))
    check("eval sqlite3 ... DELETE: BLOCK", blocks("eval \"sqlite3 %s 'DELETE FROM device_keys'\"" % DB))
    check("eval mint: BLOCK", blocks("eval 'npm run voice-relay-key -- mint'"))
    check("eval of prose echo: allowed", not blocks("eval 'echo UPDATE device_keys SET x=1'"))
    # 5. sqlite3 CLI
    check("--cmd (double dash): BLOCK", blocks("sqlite3 --cmd 'DELETE FROM device_keys' " + DB))
    check(".shell mint: BLOCK", blocks("sqlite3 %s '.shell npm run voice-relay-key -- mint'" % DB))
    check(".system mint: BLOCK", blocks("sqlite3 %s '.system npm run voice-relay-key -- mint'" % DB))
    check(".shell ls: allowed", not blocks("sqlite3 %s '.shell ls -la'" % DB))
    check(".read '|cat evil.sql': BLOCK", blocks("sqlite3 %s \".read '|cat %s'\"" % (DB, os.path.join(D8, "evil.sql"))))
    check(".read '|cat good.sql': allowed", not blocks("sqlite3 %s \".read '|cat %s'\"" % (DB, os.path.join(D8, "good.sql"))))
    check(".open the live DB mid-script, then write: BLOCK",
          blocks("sqlite3 /tmp/x.db <<'SQL'\n.open %s\nDELETE FROM device_keys;\nSQL" % ABSDB))
    # 6. env options
    for c in ("env -i PATH=/usr/bin sqlite3 %s 'DELETE FROM device_keys'" % DB,
              "env -u FOO sqlite3 %s 'DELETE FROM device_keys'" % DB,
              "env -- sqlite3 %s 'DELETE FROM device_keys'" % DB,
              "env -S \"sqlite3 %s 'DELETE FROM device_keys'\"" % DB):
        check("env options: BLOCK: " + c[:50], blocks(c))
    # 7./8. targets
    check("cd store; cp x ./claudeclaw.db: BLOCK", blocks("cd store; cp /tmp/x ./claudeclaw.db", ROOT))
    check("find -exec cp onto the DB: BLOCK", blocks("find /tmp -name e.db -exec cp {} store/claudeclaw.db \\;", ROOT))
    check("find -exec cp elsewhere: allowed", not blocks("find /tmp -name e.db -exec cp {} /tmp/out.db \\;", ROOT))
    check("curl -o the DB: BLOCK", blocks("curl -o store/claudeclaw.db http://x/e.db", ROOT))
    check("curl --output=the DB: BLOCK", blocks("curl --output=store/claudeclaw.db http://x/e.db", ROOT))
    check("curl -o elsewhere: allowed", not blocks("curl -o /tmp/e.db http://x/e.db", ROOT))
    check("wget -O the DB: BLOCK", blocks("wget -O store/claudeclaw.db http://x/e.db", ROOT))
    # 9. xargs feeding mint
    check("echo mint | xargs npm run voice-relay-key --: BLOCK", blocks("echo mint | xargs npm run voice-relay-key --"))
    check("echo list | xargs npm run voice-relay-key --: allowed", not blocks("echo list | xargs npm run voice-relay-key --"))
    # 10. literals that are data
    check("json.dumps content naming the SQL: allowed",
          not blocks("python3 - <<'PY'\nimport json\nprint(json.dumps({'content':'Gate blocks INSERT INTO device_keys (id) VALUES (1)'}))\nPY"))
    check("bound value naming UPDATE device_keys SET: allowed",
          not blocks("python3 - <<'PY'\nimport sqlite3\nc=sqlite3.connect('%s')\n"
                     "c.execute('INSERT INTO kanban_comments (card_id,content) VALUES (?,?)', ('x', 'Review: UPDATE device_keys SET sender_id is reachable'))\nPY" % DB))
    check("the same statement as the FIRST argument of execute: BLOCK",
          blocks("python3 - <<'PY'\nimport sqlite3\nc=sqlite3.connect('%s')\n"
                 "c.execute('UPDATE device_keys SET sender_id=? WHERE id=?', ('hanna','x'))\nPY" % DB))
    check("SQL in a variable, then executed (starts with a verb): BLOCK",
          blocks("python3 - <<'PY'\nimport sqlite3\nq = \"DELETE FROM device_keys WHERE 1\"\nsqlite3.connect('%s').execute(q)\nPY" % DB))
    # 11. the skill-documented kanban insert
    check("kanban insert with $(python3 -c '...') and a device_keys title: allowed",
          not blocks("sqlite3 %s \"INSERT INTO kanban_cards (id,title,status) VALUES "
                     "('card_$(python3 -c 'import time;print(int(time.time()*1000))')',"
                     "'Device keys gate: block INSERT INTO device_keys','planned')\"" % DB))
    check("...and the substitution itself is still checked: BLOCK",
          blocks("sqlite3 %s \"INSERT INTO kanban_cards (id) VALUES ('$(sqlite3 %s 'DELETE FROM device_keys')')\"" % (DB, DB)))
    check("a double-quoted SQL value naming the table: allowed",
          not blocks("sqlite3 %s 'INSERT INTO kanban_comments (content) VALUES (\"UPDATE device_keys SET scope\")'" % DB))
    check("a backtick-quoted identifier inside single quotes is not a substitution: BLOCK",
          blocks("sqlite3 %s 'INSERT INTO `device_keys` VALUES (1)'" % DB))
    # 12. smaller ones
    check("VACUUM INTO \"/tmp/copy.db\": allowed", not blocks("sqlite3 %s 'VACUUM INTO \"/tmp/copy.db\"'" % DB))
    check("VACUUM INTO the live DB: BLOCK", blocks("sqlite3 /tmp/x.db \"VACUUM INTO '%s'\"" % ABSDB))
    check("reading voice-relay-key.ts via node fs: allowed",
          not blocks("node -e \"console.log(require('fs').readFileSync('scripts/voice-relay-key.ts','utf8').length)\""))
    check("'createDeviceKey(' in src (a string, not a call): allowed",
          not blocks("python3 - <<'PY'\nsrc=open('scripts/voice-relay-key.ts').read()\nprint('createDeviceKey(' in src)\nPY"))
    check("SQL on another DB file: allowed", not blocks("sqlite3 /tmp/other.db \"INSERT INTO device_keys VALUES (1)\""))
    check("SQL on a DB in a variable (undecidable): BLOCK", blocks("sqlite3 \"$DB\" \"INSERT INTO device_keys VALUES (1)\""))
    check("SQL on CLAUDECLAW.DB elsewhere (the name counts): BLOCK",
          blocks("sqlite3 /tmp/CLAUDECLAW.DB \"INSERT INTO device_keys VALUES (1)\""))
    check("python on another DB file: allowed",
          not blocks("python3 -c \"import sqlite3;sqlite3.connect('/tmp/o.db').execute('DELETE FROM device_keys')\""))
    check("python on a DB from the environment (undecidable): BLOCK",
          blocks("python3 -c \"import os,sqlite3;sqlite3.connect(os.environ['DB']).execute('DELETE FROM device_keys')\""))

    print()
    print("ROBUSTNESS -- malformed events and what the log keeps:")
    rc, err = hook({"tool_name": "Bash", "tool_input": "npm run voice-relay-key -- mint"})
    check("tool_input not an object, mint in it: exit 2 (fallback), no traceback",
          rc == 2 and "Traceback" not in err)
    rc, err = hook({"tool_name": "Bash", "tool_input": ["ls"]})
    check("tool_input a list: exit 0, no traceback", rc == 0 and "Traceback" not in err)
    rc, err = hook({"tool_name": "Write", "tool_input": None})
    check("tool_input null: exit 0", rc == 0)
    log = open(ENV["HOOK_ERRLOG_PATH"], encoding="utf-8").read() if os.path.exists(ENV["HOOK_ERRLOG_PATH"]) else ""
    check("the log keeps the exception TYPE only, never its message",
          "TypeError" in log and "deliberately injected fault" not in log and "not an object" not in log)

    # --- 9. linear time -------------------------------------------------------
    # The first version took 253 s on one of these. Every input below contains
    # device_keys, so the needle precheck does NOT short-cut it: this is the full
    # parser, on ~200 KB of the worst shapes found for it.
    print()
    print("LINEAR TIME -- 200 KB adversarial inputs, each under 0.5 s:")
    import time as _time
    prose = "We create a new view, then index the table and create another trigger for the dashboard view. "
    TQ = "'" * 3
    ADV = [
        ("lazy-gap CREATE trigger heredoc", "sqlite3 %s <<'SQL'\n%sdevice_keys\nSQL" % (DB, "CREATE TRIGGER TABLE VIEW INDEX\n" * 6000)),
        ("prose literal in a python program", "python3 - <<'PY'\ndoc=%s%s device_keys%s\nprint(doc)\nPY" % (TQ, prose * 2000, TQ)),
        ("prose in a kanban VALUE", "sqlite3 %s \"INSERT INTO kanban_comments(content) VALUES ('%s device_keys')\"" % (DB, prose * 2000)),
        ("INSERT x repeated", "sqlite3 %s \"%s device_keys\"" % (DB, "INSERT x " * 20000)),
        ("thousands of device_keys literals", "python3 -c \"x=[%s]\"" % ("'device_keys'," * 15000)),
        ("unterminated escaped quotes", "python3 - <<'PY'\nx = '%s device_keys\nPY" % ("\\'" * 90000)),
        ("unclosed comments", "sqlite3 %s \"%s device_keys\"" % (DB, "/* " * 60000)),
        ("unclosed system( calls", "python3 - <<'PY'\n%s'device_keys'\nPY" % ("system(" * 25000)),
        ("many substitutions", "echo %s device_keys" % ("$(echo a) " * 18000)),
        ("many stages and chains", " && ".join("echo 'x%d' | sqlite3 %s .tables" % (i, DB) for i in range(4000)) + " # device_keys"),
        ("many quoted words", "sqlite3 %s %s'device_keys'" % (DB, "'a' \"b\" " * 25000)),
        ("unterminated triple quotes", "python3 - <<'PY'\n%s device_keys\nPY" % ((TQ + " x ") * 30000)),
    ]
    for name, cmd in ADV:
        t0 = _time.perf_counter()
        try:
            gate.check_tool({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": ROOT})
        except gate.GateError:
            pass
        dt = _time.perf_counter() - t0
        check("%s (%d KB): %.3f s" % (name, len(cmd) // 1024, dt), dt < 0.5 and len(cmd) > 100_000)

    print()
    print("STATED LIMITS -- open by design (reported, not asserted as correct):")
    for desc, c in (
            ("SQL assembled from a variable", 'T=device_keys; sqlite3 %s "DELETE FROM $T"' % DB),
            ("base64 | sh", "echo bnBtIHJ1biB2b2ljZS1yZWxheS1rZXkgLS0gbWludA== | base64 -d | sh"),
            ("script file run afterwards", "python3 /tmp/forge.py")):
        print("  [%s] %s" % ("open" if not blocks(c) else "now closed", desc))
finally:
    shutil.rmtree(TMP, ignore_errors=True)

print()
if failed:
    print("%d FAILED: %s" % (len(failed), failed), file=sys.stderr)
    sys.exit(1)
print("All device-keys-gate tests green.")
