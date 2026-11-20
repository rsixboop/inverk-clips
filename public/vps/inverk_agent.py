#!/usr/bin/env python3
"""Inverk VPS agent: outbound-only link between this Debian VPS and the Inverk Clips app.

- Pairs once with a one-time code from the app; token kept in /etc/inverk-agent/token (0600), never sent anywhere but the app.
- Heartbeat every 30 s with the last server timestamp it received and systemd service states.
- Mirrors the existing reddit-studio SQLite (opened read-only) and Buffer channels/drafts/queue (key read from local buffer.key, never uploaded).
- Executes only allowlisted operations; each command id runs at most once (local state). It never publishes anything.
Stdlib only.
"""
import json, os, re, sqlite3, subprocess, sys, time, urllib.request, urllib.error, urllib.parse

VERSION = "1.0"
CONF_DIR = os.environ.get("INVERK_AGENT_CONF", "/etc/inverk-agent")
STATE_DIR = os.environ.get("INVERK_AGENT_STATE", "/var/lib/inverk-agent")
DEFAULTS = {"server": "https://inverk-clips.lovable.app", "db": "/var/lib/inverk-studio/reddit-studio.sqlite3",
            "buffer_key": "/var/lib/inverk-studio/buffer.key", "units": [], "unit_glob": "inverk*",
            "reddit_table": "", "settings_table": "settings", "interval_key": "collect_interval_minutes", "rows_per_table": 500}
OPS = {"reddit.add", "collect.set_interval", "service.restart", "sync.now", "buffer.refresh"}

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

# ---------- sqlite ----------
def ro(c): return sqlite3.connect(f"file:{c['db']}?mode=ro", uri=True, timeout=10)
def tables(con): return [r[0] for r in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
def cols(con, t): return [r[1] for r in con.execute(f'pragma table_info("{t}")')]
def safe(t): return re.fullmatch(r"[A-Za-z0-9_]{1,64}", t) is not None

def mirror_db(c, tok):
    if not os.path.exists(c["db"]): return {"db": "missing"}
    con = ro(c); schema = []
    try:
        for t in tables(con):
            if not safe(t): continue
            cs = cols(con, t); schema.append({"key": t, "data": {"columns": cs, "rows": con.execute(f'select count(*) from "{t}"').fetchone()[0]}})
            order = "rowid desc"
            rows = con.execute(f'select rowid, * from "{t}" order by {order} limit ?', (int(c["rows_per_table"]),)).fetchall()
            recs = [{"key": r[0], "data": {k: (v if not isinstance(v, bytes) else None) for k, v in zip(cs, r[1:])}} for r in rows]
            call(c, {"action": "mirror", "kind": "table:" + t, "rows": recs, "full": True}, tok)
        call(c, {"action": "mirror", "kind": "schema", "rows": schema, "full": True}, tok)
    finally: con.close()
    return {"db": "ok", "tables": len(schema), "mtime": os.path.getmtime(c["db"])}

def reddit_table(con, c):
    if c["reddit_table"]: return c["reddit_table"]
    for t in tables(con):
        if safe(t) and "url" in cols(con, t) and re.search(r"reddit|post|stor", t, re.I): return t
    raise RuntimeError("no reddit table with a url column; set reddit_table in /etc/inverk-agent/config.json")

def op_reddit_add(c, a):
    con = sqlite3.connect(c["db"], timeout=15)
    try:
        t = reddit_table(con, c); cs = cols(con, t)
        hit = con.execute(f'select rowid from "{t}" where url = ?', (a["url"],)).fetchone()
        if hit: return {"table": t, "rowid": hit[0], "existing": True}
        vals = {"url": a["url"], "title": a.get("title"), "note": a.get("note"), "source": "manual", "status": "new",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        vals = {k: v for k, v in vals.items() if k in cs and v is not None}
        q = f'insert into "{t}" ({",".join(chr(34)+k+chr(34) for k in vals)}) values ({",".join("?"*len(vals))})'
        with con: cur = con.execute(q, list(vals.values()))
        return {"table": t, "rowid": cur.lastrowid, "existing": False, "columns": list(vals)}
    finally: con.close()

def op_set_interval(c, a):
    con = sqlite3.connect(c["db"], timeout=15); t = c["settings_table"]
    try:
        if not safe(t) or t not in tables(con): raise RuntimeError(f"settings table '{t}' not found in sqlite; set settings_table in config")
        cs = cols(con, t)
        if not {"key", "value"} <= set(cs): raise RuntimeError(f"table {t} has no key/value columns")
        with con:
            if con.execute(f'update "{t}" set value=? where key=?', (str(a["minutes"]), c["interval_key"])).rowcount == 0:
                con.execute(f'insert into "{t}" (key,value) values (?,?)', (c["interval_key"], str(a["minutes"])))
        return {"key": c["interval_key"], "minutes": a["minutes"]}
    finally: con.close()

# ---------- systemd ----------
def units(c):
    us = list(c["units"])
    try:
        out = subprocess.run(["systemctl", "list-units", c["unit_glob"], "--all", "--plain", "--no-legend", "--type=service,timer"], capture_output=True, text=True, timeout=10).stdout
        us += [l.split()[0] for l in out.splitlines() if l.strip()]
    except Exception: pass
    return sorted({u for u in us if u != "inverk-agent.service"})

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

# ---------- Buffer (read only) ----------
def buffer_key(c):
    with open(c["buffer_key"]) as f: return f.read().strip()

def http_json(url, key=None, body=None):
    h = {"user-agent": "inverk-agent/" + VERSION, "content-type": "application/json"}
    if key and body is not None: h["authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h)
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read())

def mirror_buffer(c, tok):
    try: key = buffer_key(c)
    except Exception as e:
        call(c, {"action": "mirror", "kind": "buffer:error", "rows": [{"key": "last", "data": {"error": f"buffer.key: {type(e).__name__}"}}], "full": True}, tok); return
    try:
        q = "https://api.bufferapp.com/1/"; tq = "access_token=" + urllib.parse.quote(key)
        profiles = http_json(f"{q}profiles.json?{tq}")
        chans = [{"key": p["id"], "data": {"name": p.get("formatted_username") or p.get("service_username"), "service": p.get("service"), "paused": p.get("paused")}} for p in profiles]
        posts = []
        for p in profiles[:20]:
            for status in ("pending", "drafts"):
                try: ups = http_json(f"{q}profiles/{p['id']}/updates/{status}.json?{tq}&count=50").get("updates", [])
                except urllib.error.HTTPError: continue
                for u in ups:
                    posts.append({"key": u["id"], "data": {"channel": p["id"], "status": "draft" if status == "drafts" else "queued", "text": (u.get("text") or "")[:500], "due_at": u.get("due_at"), "media": bool(u.get("media"))}})
        call(c, {"action": "mirror", "kind": "buffer:channels", "rows": chans, "full": True}, tok)
        call(c, {"action": "mirror", "kind": "buffer:posts", "rows": posts, "full": True}, tok)
        call(c, {"action": "mirror", "kind": "buffer:error", "rows": [], "full": True}, tok)
    except Exception as e:
        msg = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else type(e).__name__
        call(c, {"action": "mirror", "kind": "buffer:error", "rows": [{"key": "last", "data": {"error": "Buffer API: " + msg}}], "full": True}, tok)

# ---------- loop ----------
def run_op(c, tok, cmd, st):
    if cmd["id"] in st["done"]: return st["done"][cmd["id"]]  # already executed: report the same outcome again
    op, a = cmd["op"], cmd.get("args") or {}
    try:
        if op not in OPS: raise RuntimeError("op not allowlisted")
        if op == "reddit.add": r = op_reddit_add(c, a); mirror_db(c, tok)
        elif op == "collect.set_interval": r = op_set_interval(c, a); mirror_db(c, tok)
        elif op == "service.restart": r = op_restart(c, a)
        elif op == "sync.now": r = mirror_db(c, tok)
        elif op == "buffer.refresh": mirror_buffer(c, tok); r = {"ok": True}
        out = {"status": "done", "result": r}
    except Exception as e: out = {"status": "failed", "error": f"{type(e).__name__}: {e}"[:400]}
    st["done"][cmd["id"]] = out; save_state(st); return out

def main_loop():
    c = conf(); tok = token()
    if not tok: sys.exit("not paired: run  inverk-agent pair <CODE>")
    st = load_state(); last_ts = st.get("last_server_ts"); next_db = 0; next_buf = 0; mtime = None
    log("agent", VERSION, "->", c["server"])
    while True:
        t0 = time.time()
        try:
            info = {"db": os.path.exists(c["db"]), "buffer_key": os.path.exists(c["buffer_key"]), "host": os.uname().nodename}
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
