#!/usr/bin/env python3
"""Session sync: summarize idle Claude Code sessions to the main agent and
answer its follow-up questions, through the cc-link MCP server.

Meant to run from launchd (or cron) every hour. Each run:
  1. finds sessions whose transcript has new entries since the last summary
     and no new entry for IDLE_MIN minutes,
  2. has `claude -p` summarize the new part and send it with <prefix>_message,
  3. answers folder messages the main agent sent to the sync folder
     (questions about a `session:<id8>`), from the referenced transcripts.

State lives in CC_LINK_SYNC_DIR (default ~/.cc-link/sync):
  sent.tsv      one row per summary: session id, date, category, sent|skipped,
                message id, transcript line count covered so far
  answered.txt  ids of main-agent messages already handled
  run/          cwd of every `claude -p` call; its cc-link folder key is the
                address for questions (folder:<key>)

Configuration (environment):
  CC_LINK_AGENT_NAME       tool prefix, as in the MCP server env (default agent)
  CC_LINK_SYNC_DIR         state directory (default ~/.cc-link/sync)
  CC_LINK_SYNC_LANG        language of the summaries (default English)
  CC_LINK_SYNC_MODEL       model for summaries and answers (default sonnet)
  CC_LINK_SYNC_SINCE       YYYY-MM-DD; ignore transcript entries before this date
                           (avoids summarizing the whole history on the first run)
  CC_LINK_SYNC_CATEGORIES  LABEL=path pairs, comma separated, e.g.
                           WORK=~/code/work,HOME=~/code/home (default: none, OTHER)
  CC_LINK_SYNC_IDLE_MIN    minutes without new entries before a session is
                           summarized (default 30)

The dashboard URL and device key are read from the cc-link entry in
~/.claude.json (user-scope registration), never from this script's env.
"""
import glob, hashlib, json, os, re, subprocess, sys, time, urllib.request
from datetime import datetime

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.realpath(__file__))
PREFIX = re.sub(r'[^a-z0-9]+', '_', os.environ.get('CC_LINK_AGENT_NAME', 'agent').lower()).strip('_') or 'agent'
SYNC = os.path.expanduser(os.environ.get('CC_LINK_SYNC_DIR', '~/.cc-link/sync'))
LANG = os.environ.get('CC_LINK_SYNC_LANG', 'English')
MODEL = os.environ.get('CC_LINK_SYNC_MODEL', 'sonnet')
SINCE = os.environ.get('CC_LINK_SYNC_SINCE', '')
IDLE_SEC = int(os.environ.get('CC_LINK_SYNC_IDLE_MIN', '30')) * 60
CATEGORIES = [(label.strip(), os.path.expanduser(path.strip()))
              for label, _, path in (p.partition('=') for p in os.environ.get('CC_LINK_SYNC_CATEGORIES', '').split(',') if '=' in p)]
LOG = f'{SYNC}/sent.tsv'
ANSWERED = f'{SYNC}/answered.txt'
RUN_DIR = f'{SYNC}/run'
MAX_CHARS = 400_000  # keep the tail of huge transcripts; chunk if summaries get too shallow
MESSAGE_TOOL = f'mcp__cc-link__{PREFIX}_message'
INBOX_TOOL = f'mcp__cc-link__{PREFIX}_inbox'


def folder_key(path):
    """Same as the MCP server: first 8 hex chars of sha256(realpath(folder))."""
    return hashlib.sha256(os.path.realpath(path).encode()).hexdigest()[:8]


def category(cwd):
    for label, root in CATEGORIES:
        if cwd and (cwd == root or cwd.startswith(root.rstrip('/') + '/')):
            return label
    return 'OTHER'


def covered():
    """session id -> transcript line count already summarized (0 for rows without a count)."""
    out = {}
    if not os.path.exists(LOG):
        return out
    for line in open(LOG, errors='replace'):
        f = line.rstrip('\n').split('\t')
        if len(f) < 4 or not re.fullmatch(r'[0-9a-f-]{36}', f[0]):
            continue
        n = int(f[5]) if len(f) > 5 and f[5].isdigit() else 0
        out[f[0]] = max(out.get(f[0], 0), n)
    return out


def first_line_since(lines, day):
    """Index of the first entry dated `day` (YYYY-MM-DD) or later."""
    for i, line in enumerate(lines):
        m = re.search(r'"timestamp":\s*"(\d{4}-\d\d-\d\d)', line)
        if m and m.group(1) >= day:
            return i
    return len(lines)


def start_line(lines, done):
    """Where the next summary of a transcript starts."""
    if done:
        return done
    return first_line_since(lines, SINCE) if SINCE else 0


def last_activity(lines):
    """Epoch of the newest transcript entry (file mtime gets bumped without new entries)."""
    for line in reversed(lines):
        m = re.search(r'"timestamp":\s*"([^"]+)"', line)
        if m:
            return datetime.fromisoformat(m.group(1).replace('Z', '+00:00')).timestamp()
    return 0


def extract(lines, start):
    """User prompts and assistant prose from line `start` on; tool calls and results dropped."""
    buf, cwd, first_ts = [], None, None
    for i, line in enumerate(lines):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        cwd = cwd or d.get('cwd')
        if i < start or d.get('isMeta') or d.get('isSidechain'):
            continue
        first_ts = first_ts or d.get('timestamp')
        c = d.get('message', {}).get('content')
        if d.get('type') == 'user' and isinstance(c, str) and not c.startswith('<'):
            buf.append('\n## U: ' + c[:1500])
        elif d.get('type') == 'assistant' and isinstance(c, list):
            buf += ['A: ' + b['text'][:800] for b in c if b.get('type') == 'text' and b['text'].strip()]
    return '\n'.join(buf)[-MAX_CHARS:], cwd, first_ts


def brief(name):
    return (open(f'{HERE}/{name}').read()
            .replace('{{TOOL}}', f'{PREFIX}_message').replace('{{LANG}}', LANG))


def claude(prompt, model, *tools):
    r = subprocess.run(['claude', '-p', '--model', model, '--allowedTools', *tools],
                       input=prompt, capture_output=True, text=True, cwd=RUN_DIR, timeout=900)
    return r.stdout.strip()


def server_env():
    """The cc-link MCP server's env from its user-scope registration."""
    return json.load(open(f'{HOME}/.claude.json'))['mcpServers']['cc-link']['env']


def api_get(path):
    env = server_env()
    req = urllib.request.Request(env['MARVEEN_URL'].rstrip('/') + path,
                                 headers={'Authorization': 'Bearer ' + env['MARVEEN_DEVICE_KEY']})
    return json.load(urllib.request.urlopen(req, timeout=10))


def whoami():
    """The call the MCP server needs before sending; None when the dashboard is unreachable."""
    try:
        return api_get('/api/auth/whoami')
    except (OSError, ValueError):  # HTTPError included: whoami must answer 200
        return None


def summarize(sid, cat, cwd, date, text, partial):
    header = f'[SYNC] [{cat}] {os.path.basename(cwd or "?")} · {date} · session:{sid[:8]}'
    if partial:
        header += ' · continued'
    prompt = (brief('summary-brief.md') + f'\n\nHeader (first line of the message): {header}\n'
              + ('This is a CONTINUATION: only the part since the previous summary is below; summarize only that.\n' if partial else '')
              + '\n--- TRANSCRIPT START ---\n' + text + '\n--- TRANSCRIPT END ---\n')
    out = claude(prompt, MODEL, MESSAGE_TOOL)
    m = re.search(r'SENT\s+(\d+)', out)
    if m:
        return 'sent', m.group(1)
    if 'SKIP' in out:
        return 'skipped', '-'
    raise RuntimeError(f'unexpected claude output: {out[-300:]}')


def sync_session(f, done, now, dry):
    sid = os.path.basename(f)[:-6]
    lines = open(f, errors='replace').read().splitlines()
    start = start_line(lines, done.get(sid))
    if start >= len(lines) or now - last_activity(lines) < IDLE_SEC:
        return
    text, cwd, ts = extract(lines, start)
    cat = category(cwd)
    if dry:
        print(f'would send {sid[:8]} {cat} lines {start}-{len(lines)} chars={len(text)}')
        return
    row = summarize(sid, cat, cwd, (ts or '')[:10], text, start > 0) if text.strip() else ('skipped', '-')
    with open(LOG, 'a') as fh:
        fh.write('\t'.join([sid, time.strftime('%Y-%m-%d'), cat, row[0], row[1], str(len(lines))]) + '\n')
    print(f'{time.strftime("%F %T")} {sid[:8]} {cat} {row[0]} {row[1]}')


def sync_sessions(dry):
    done = covered()
    now = time.time()
    run_project = re.sub(r'[^A-Za-z0-9]', '-', os.path.realpath(RUN_DIR))
    for f in sorted(glob.glob(f'{HOME}/.claude/projects/*/*.jsonl'), key=os.path.getmtime):
        if os.path.basename(os.path.dirname(f)) == run_project:  # our own claude -p calls
            continue
        try:  # one bad transcript must not block the others
            sync_session(f, done, now, dry)
        except Exception as e:
            print(f'{os.path.basename(f)[:8]} failed: {e}', file=sys.stderr)


def answer_questions(who):
    """Answer the main agent's folder messages to RUN_DIR from the referenced transcripts."""
    key = folder_key(RUN_DIR)
    pending = api_get(f'/api/messages?agent={who["sender_id"]}&status=pending')
    if any(f'folder:{key}' in (row.get('origin_note') or '') for row in pending):
        claude(f'Call {PREFIX}_inbox once, then reply OK.', 'haiku', INBOX_TOOL)  # a starting session claims them
    state_dir = os.path.expanduser(server_env().get('CC_LINK_STATE_DIR') or '~/.cc-link')
    received = f'{state_dir}/folders/{key}/received.jsonl'
    if not os.path.exists(received):
        return
    answered = set(open(ANSWERED).read().split()) if os.path.exists(ANSWERED) else set()
    for line in open(received):
        try:
            msg = json.loads(line)
        except ValueError:  # blank or partially written line
            continue
        mid = str(msg['id'])
        if mid in answered or msg.get('from') != who.get('mainAgentId'):
            continue
        transcripts = ''
        for sid8 in sorted(set(re.findall(r'session:([0-9a-f]{8})', msg['text']))):
            for f in glob.glob(f'{HOME}/.claude/projects/*/{sid8}*.jsonl'):
                text, cwd, _ = extract(open(f, errors='replace').read().splitlines(), 0)
                transcripts += f'\n--- TRANSCRIPT session:{sid8} ({cwd}) ---\n{text}\n'
        out = claude(brief('answer-brief.md') + f'\n\nMessage id: {mid}\n--- MESSAGE ---\n{msg["text"]}\n'
                     + (transcripts or '\n(no transcript referenced or found)\n'), MODEL, MESSAGE_TOOL)
        m = re.search(r'(SENT\s+\d+|NOOP)', out)
        if not m:
            print(f'answer {mid} failed: {out[-300:]}', file=sys.stderr)
            continue
        with open(ANSWERED, 'a') as fh:
            fh.write(mid + '\n')
        print(f'{time.strftime("%F %T")} answer to {mid}: {m.group(1)}')


def main(dry):
    os.makedirs(RUN_DIR, exist_ok=True)
    if dry:
        print(f'questions go to folder:{folder_key(RUN_DIR)}')
        sync_sessions(True)
        return
    who = whoami()
    if not who:
        print(f'{time.strftime("%F %T")} dashboard unreachable, skipping')
        return
    sync_sessions(False)
    try:
        answer_questions(who)
    except Exception as e:
        print(f'answer step failed: {e}', file=sys.stderr)


if __name__ == '__main__':
    os.makedirs(SYNC, exist_ok=True)
    lock = f'{SYNC}/.lock'
    try:
        os.mkdir(lock)
    except FileExistsError:
        if time.time() - os.path.getmtime(lock) < 3 * 3600:
            sys.exit('already running')
    try:
        main('--dry-run' in sys.argv)
    finally:
        os.rmdir(lock)
