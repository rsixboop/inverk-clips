#!/usr/bin/env python3
"""Inverk VPS agent: outbound-only link between this Debian VPS and the Inverk Clips app.

- Pairs once with a one-time code from the app; token kept in /etc/inverk-agent/token (0600), never sent anywhere but the app.
- Heartbeat every 30 s with the last server timestamp it received and systemd service states.
- Mirrors allowlisted non-secret fields of the reddit-studio SQLite (stories+archive_text, settings id=1) and Buffer channels/drafts/queue (key read from local buffer.key, never uploaded).
- Executes only allowlisted operations; each command id runs at most once (local state). It never publishes anything.
Stdlib only.
"""
import json, os, re, sqlite3, subprocess, sys, time, urllib.request, urllib.error, urllib.parse

from pathlib import Path

VERSION = "1.2"
CONF_DIR = os.environ.get("INVERK_AGENT_CONF", "/etc/inverk-agent")
STATE_DIR = os.environ.get("INVERK_AGENT_STATE", "/var/lib/inverk-agent")
DEFAULTS = {"server": "https://inverk-clips.lovable.app", "db": "/var/lib/inverk-studio/reddit-studio.sqlite3",
            "buffer_key": "/var/lib/inverk-studio/buffer.key", "units": [], "unit_glob": "inverk*",
            "rows_per_table": 500}
OPS = {"reddit.add", "collect.set", "service.restart", "sync.now", "buffer.refresh", "buffer.create_draft"}

def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

def conf():
    c = dict(DEFAULTS)
    try:
        with open(os.path.join(CONF_DIR, "config.json")) as f: c.update(json.load(f))
    except FileNotFoundError: pass
    return c

def token():
    try:
        with open(os.path.join(CONF_DIR, "token")) as f: return f.read().strip()
    except FileNotFoundError: return ""

def call(c, body, tok=None):
    req = urllib.request.Request(c["server"].rstrip("/") + "/api/public/vps/agent", data=json.dumps(body, default=str).encode(),
        headers={"content-type": "application/json", "user-agent": "inverk-agent/" + VERSION, **({"authorization": "Bearer " + tok} if tok else {})}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} {detail}") from None

# ---------- state (idempotency) ----------
def load_state():
    try:
        with open(os.path.join(STATE_DIR, "state.json")) as f: return json.load(f)
    except Exception: return {"done": {}}
def save_state(s):
    os.makedirs(STATE_DIR, exist_ok=True); p = os.path.join(STATE_DIR, "state.json.tmp")
    s["done"] = dict(list(s["done"].items())[-500:])
    with open(p, "w") as f: json.dump(s, f)
    os.replace(p, os.path.join(STATE_DIR, "state.json"))

# ---------- sqlite (studio.py schema: stories, archive_text, settings id=1) ----------
REDDIT = re.compile(r"^https://(?:www\.|old\.|new\.)?reddit\.com/r/([A-Za-z0-9_]{2,21})/comments/([a-z0-9]{3,12})(?:/|$)", re.I)
def parse_reddit(url):
    m = REDDIT.match(url.strip())
    if not m: raise RuntimeError("not a reddit /r/<sub>/comments/<id>/ url")
    return m.group(1), "t3_" + m.group(2).lower()

def ro(c): return sqlite3.connect(f"file:{c['db']}?mode=ro", uri=True, timeout=10)
def rw(c): return sqlite3.connect(c["db"], timeout=15, isolation_level=None)
def fix_owner(c):
    """The studio service owns the db (DynamicUser); keep sidecar files owned by it after our writes."""
    try:
        st = os.stat(c["db"])
        for sfx in ("-wal", "-shm", "-journal"):
            p = c["db"] + sfx
            if os.path.exists(p): os.chown(p, st.st_uid, st.st_gid)
    except OSError: pass

def mirror_db(c, tok):
    if not os.path.exists(c["db"]): return {"db": "missing"}
    con = ro(c)
    try:
        rows = con.execute("""select s.id, s.community, s.title, s.url, s.seen, a.body, a.manual
            from stories s left join archive_text a on a.id = s.id order by s.rowid desc limit ?""", (int(c["rows_per_table"]),)).fetchall()
        stories = [{"key": r[0], "data": {"community": r[1], "title": r[2], "url": r[3], "seen": bool(r[4]),
                    "body": (r[5] or "")[:4000] if r[5] is not None else None, "manual": bool(r[6]) if r[6] is not None else False}} for r in rows]
        srow = con.execute("select enabled, minutes from settings where id = 1").fetchone()
    finally: con.close()
    call(c, {"action": "mirror", "kind": "stories", "rows": stories, "full": True}, tok)
    call(c, {"action": "mirror", "kind": "settings", "rows": [{"key": "1", "data": {"enabled": bool(srow[0]), "minutes": srow[1]}}] if srow else [], "full": True}, tok)
    return {"db": "ok", "stories": len(stories)}

def op_reddit_add(c, a):
    community, sid = parse_reddit(a["url"])
    title = (a.get("title") or "").strip(); body = a.get("body")
    con = rw(c)
    try:
        con.execute("begin immediate")
        try:
            existed = con.execute("select 1 from stories where id = ?", (sid,)).fetchone() is not None
            if not existed:
                con.execute("insert into stories (id, community, title, url, seen) values (?, ?, ?, ?, 0)", (sid, community, title, a["url"].strip()))
            elif title:
                con.execute("update stories set title = ? where id = ?", (title, sid))
            if body is not None and body.strip():
                con.execute("insert into archive_text (id, body, manual) values (?, ?, 1) on conflict(id) do update set body = excluded.body, manual = 1", (sid, body))
            con.execute("commit")
        except Exception:
            con.execute("rollback"); raise
    finally: con.close(); fix_owner(c)
    return {"id": sid, "community": community, "existing": existed, "body": bool(body and body.strip())}

def op_collect_set(c, a):
    con = rw(c)
    try:
        con.execute("begin immediate")
        try:
            if con.execute("update settings set enabled = ?, minutes = ? where id = 1", (1 if a["enabled"] else 0, int(a["minutes"]))).rowcount == 0:
                con.execute("insert into settings (id, enabled, minutes) values (1, ?, ?)", (1 if a["enabled"] else 0, int(a["minutes"])))
            con.execute("commit")
        except Exception:
            con.execute("rollback"); raise
    finally: con.close(); fix_owner(c)
    return {"enabled": a["enabled"], "minutes": a["minutes"]}

# ---------- systemd ----------
def units(c):
    us = list(c["units"])
    try:
        out = subprocess.run(["systemctl", "list-units", c["unit_glob"], "--all", "--plain", "--no-legend", "--type=service,timer"], capture_output=True, text=True, timeout=10).stdout
        us += [l.split()[0] for l in out.splitlines() if l.strip()]
    except Exception: pass
    return sorted({u for u in us if u != "inverk-agent.service"})

def workload_usage(previous, root=Path("/sys/fs/cgroup/system.slice")):
    """Read service cgroups, including their Chromium and FFmpeg children."""
    now = time.monotonic()
    cores = os.cpu_count() or 1
    result = {}
    current = {}
    for label, pattern in (("phil", "phil-*.service"), ("clips", "inverk*.service")):
        try:
            groups = [g for g in root.glob(pattern) if g.name != "inverk-agent.service"]
            if not groups:
                continue
            memory = 0
            cpu = 0.0
            complete = True
            for group in groups:
                key = (group.name, group.stat().st_ino)
                memory += int((group / "memory.current").read_text())
                fields = dict(line.split() for line in (group / "cpu.stat").read_text().splitlines())
                usage = int(fields["usage_usec"])
                current[key] = (now, usage)
                if key in previous:
                    start, last = previous[key]
                    if now > start and usage >= last:
                        cpu += (usage - last) / ((now - start) * 10000 * cores)
                        continue
                complete = False
            result[label] = {"memory_mib": round(memory / 1048576),
                             "cpu_percent": round(cpu, 1) if complete else None}
        except (OSError, ValueError, KeyError):
            continue
    previous.clear()
    previous.update(current)
    return result

def services(c):
    res = {}
    for u in units(c):
        try:
            out = subprocess.run(["systemctl", "show", u, "-p", "ActiveState,SubState,Result,ActiveEnterTimestamp"], capture_output=True, text=True, timeout=10).stdout
            kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
            res[u] = {"active": kv.get("ActiveState", "?"), "sub": kv.get("SubState"), "result": kv.get("Result"), "since": kv.get("ActiveEnterTimestamp")}
        except Exception as e: res[u] = {"active": "unknown", "result": type(e).__name__}
    return res

def op_restart(c, a):
    if a["unit"] not in units(c): raise RuntimeError("unit not in allowlist")
    r = subprocess.run(["systemctl", "restart", a["unit"]], capture_output=True, text=True, timeout=60)
    if r.returncode: raise RuntimeError(r.stderr.strip()[:300] or f"exit {r.returncode}")
    return {"unit": a["unit"], "restarted": True}

# ---------- Buffer (GraphQL only, https://api.buffer.com) ----------
BUFFER_URL = "https://api.buffer.com"
def buffer_key(c):
    with open(c["buffer_key"]) as f: return f.read().strip()

def gql(c, query, variables=None, timeout=30):
    req = urllib.request.Request(BUFFER_URL, data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer " + buffer_key(c), "user-agent": "inverk-agent/" + VERSION}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r: out = json.loads(r.read())
    if out.get("errors"): raise RuntimeError("Buffer GraphQL: " + "; ".join(str(e.get("message", ""))[:120] for e in out["errors"]))
    return out["data"]

Q_ORGS = "query { account { organizations { id } } }"
Q_CHANNELS = "query Ch($id: OrganizationId!) { channels(input: {organizationId: $id}) { id name service } }"
Q_POSTS = """query Posts($id: OrganizationId!) { posts(first: 50, input: {organizationId: $id,
  sort: [{field: dueAt, direction: asc}, {field: createdAt, direction: desc}], filter: {status: [scheduled, draft]}}) {
  edges { node { id text status dueAt channelId } } } }"""
M_DRAFT = """mutation Draft($input: CreatePostInput!) { createPost(input: $input) {
  ... on PostActionSuccess { post { id } } ... on MutationError { message } } }"""

def mirror_buffer(c, tok):
    def fail(msg): call(c, {"action": "mirror", "kind": "buffer:error", "rows": [{"key": "last", "data": {"error": msg[:300]}}], "full": True}, tok)
    try: buffer_key(c)
    except Exception as e: return fail(f"buffer.key: {type(e).__name__}")
    try:
        chans, posts = [], []
        for org in gql(c, Q_ORGS)["account"]["organizations"]:
            for ch in gql(c, Q_CHANNELS, {"id": org["id"]})["channels"]:
                chans.append({"key": ch["id"], "data": {"name": ch.get("name"), "service": ch.get("service")}})
            for e in gql(c, Q_POSTS, {"id": org["id"]})["posts"]["edges"]:
                n = e["node"]; posts.append({"key": n["id"], "data": {"channel": n.get("channelId"), "status": n.get("status"), "text": (n.get("text") or "")[:500], "due_at": n.get("dueAt")}})
        call(c, {"action": "mirror", "kind": "buffer:channels", "rows": chans, "full": True}, tok)
        call(c, {"action": "mirror", "kind": "buffer:posts", "rows": posts, "full": True}, tok)
        call(c, {"action": "mirror", "kind": "buffer:error", "rows": [], "full": True}, tok)
    except urllib.error.HTTPError as e: fail(f"Buffer API: HTTP {e.code}")
    except Exception as e: fail(f"{type(e).__name__}: {e}")

def op_buffer_draft(c, a, cmd_id, st):
    """Pre-submit barrier: persist 'submitting' before the POST. If we crash or time out after that, the outcome is
    unknown and we never resubmit automatically — the user must check Buffer and click again (new command)."""
    if not re.fullmatch(r"[a-f0-9]{24}", a["channel_id"]) or not a["video_url"].startswith("https://"): raise RuntimeError("bad draft args")
    sub = st.setdefault("submitting", {})
    if cmd_id in sub: raise RuntimeError("ambiguous: earlier submit had no confirmed result; check Buffer drafts before retrying")
    sub[cmd_id] = time.time(); save_state(st)
    try: data = gql(c, M_DRAFT, {"input": {"channelId": a["channel_id"], "text": a["text"], "schedulingType": "automatic", "mode": "addToQueue",
                                      "saveToDraft": True, "assets": [{"video": {"url": a["video_url"]}}]}}, timeout=45)
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500: sub.pop(cmd_id, None); save_state(st); raise RuntimeError(f"Buffer rejected: HTTP {e.code}") from None
        raise RuntimeError(f"ambiguous: HTTP {e.code}; check Buffer drafts before retrying") from None
    except RuntimeError as e: sub.pop(cmd_id, None); save_state(st); raise  # GraphQL errors = definite rejection
    except Exception as e: raise RuntimeError(f"ambiguous: {type(e).__name__}; check Buffer drafts before retrying") from None
    r = data["createPost"]
    if r.get("message"): sub.pop(cmd_id, None); save_state(st); raise RuntimeError("Buffer: " + r["message"][:200])  # definite rejection
    return {"post_id": r["post"]["id"], "draft": True}

# ---------- loop ----------
def run_op(c, tok, cmd, st):
    if cmd["id"] in st["done"]: return st["done"][cmd["id"]]  # already executed: report the same outcome again
    op, a = cmd["op"], cmd.get("args") or {}
    try:
        if op not in OPS: raise RuntimeError("op not allowlisted")
        if op == "reddit.add": r = op_reddit_add(c, a); mirror_db(c, tok)
        elif op == "collect.set": r = op_collect_set(c, a); mirror_db(c, tok)
        elif op == "buffer.create_draft": r = op_buffer_draft(c, a, cmd["id"], st); mirror_buffer(c, tok)
        elif op == "service.restart": r = op_restart(c, a)
        elif op == "sync.now": r = mirror_db(c, tok)
        elif op == "buffer.refresh": mirror_buffer(c, tok); r = {"ok": True}
        out = {"status": "done", "result": r}
    except Exception as e: out = {"status": "failed", "error": f"{type(e).__name__}: {e}"[:400]}
    st["done"][cmd["id"]] = out; save_state(st); return out

def main_loop():
    c = conf(); tok = token()
    if not tok: sys.exit("not paired: run  inverk-agent pair <CODE>")
    previous_usage = {}
    st = load_state(); last_ts = st.get("last_server_ts"); next_db = 0; next_buf = 0; mtime = None
    log("agent", VERSION, "->", c["server"])
    while True:
        t0 = time.time()
        try:
            info = {"db": os.path.exists(c["db"]), "buffer_key": os.path.exists(c["buffer_key"]), "host": os.uname().nodename}
            info["workloads"] = workload_usage(previous_usage)
            r = call(c, {"action": "heartbeat", "version": VERSION, "last_server_ts": last_ts, "services": services(c), "info": info}, tok)
            last_ts = r.get("server_ts"); st["last_server_ts"] = last_ts; save_state(st)
            for cmd in r.get("commands", []):
                out = run_op(c, tok, cmd, st); call(c, {"action": "result", "id": cmd["id"], **out}, tok)
            m = os.path.getmtime(c["db"]) if os.path.exists(c["db"]) else None
            if time.time() >= next_db or m != mtime: mirror_db(c, tok); mtime = m; next_db = time.time() + 300
            if time.time() >= next_buf: mirror_buffer(c, tok); next_buf = time.time() + 600
        except RuntimeError as e:
            log("server:", e)
            if str(e).startswith("HTTP 401"): sys.exit("token revoked; pair again")
        except Exception as e: log("error:", type(e).__name__, e)
        time.sleep(max(1, 30 - (time.time() - t0)))

def pair(code):
    c = conf(); r = call(c, {"action": "pair", "code": code, "name": os.uname().nodename, "version": VERSION})
    os.makedirs(CONF_DIR, exist_ok=True); p = os.path.join(CONF_DIR, "token")
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: f.write(r["token"])
    print("paired, agent id", r["agent_id"])

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "pair": pair(sys.argv[2])
    elif len(sys.argv) >= 2 and sys.argv[1] == "status": print(json.dumps(services(conf()), indent=1))
    else: main_loop()
