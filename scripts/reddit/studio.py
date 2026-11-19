"""Run with python3 studio.py. Open localhost:8765 through an SSH tunnel."""
import html
import json
import os
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.getenv("REDDIT_DB", "reddit-studio.sqlite3")
HOST = "127.0.0.1:8765"
QUERY = '("GTA 6" OR "GTA VI" OR "Grand Theft Auto VI")'


def connect():
    return sqlite3.connect(DB, timeout=15)


def initialize():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, enabled INTEGER, minutes INTEGER);
        INSERT OR IGNORE INTO settings VALUES(1,0,30);
        CREATE TABLE IF NOT EXISTS stories(id TEXT PRIMARY KEY, community TEXT, title TEXT, url TEXT, seen INTEGER);
        CREATE TABLE IF NOT EXISTS events(at INTEGER, message TEXT);
        """)


def collect():
    token = os.getenv("REDDIT_ACCESS_TOKEN")
    if not token:
        raise ValueError("Нужен действующий OAuth-токен Reddit")
    params = urllib.parse.urlencode(dict(q=QUERY, sort="new", limit=100, type="link"))
    request = urllib.request.Request("https://oauth.reddit.com/search?" + params, headers={
        "Authorization": "Bearer " + token, "User-Agent": os.environ["REDDIT_USER_AGENT"]})
    with urllib.request.urlopen(request, timeout=25) as response:
        items = json.load(response)["data"]["children"]
    with connect() as db:
        for item in items:
            post = item["data"]
            if post.get("removed_by_category") or post.get("over_18"):
                continue
            db.execute("INSERT OR IGNORE INTO stories VALUES(?,?,?,?,?)", (
                post["name"], post["subreddit"], post["title"], "https://www.reddit.com" + post["permalink"], int(time.time())))
        return db.total_changes


def worker():
    while True:
        with connect() as db:
            enabled, minutes = db.execute("SELECT enabled,minutes FROM settings").fetchone()
            last = db.execute("SELECT coalesce(max(at),0) FROM events").fetchone()[0]
        if enabled and time.time() >= last + minutes * 60:
            try:
                message = f"Новых тем: {collect()}"
            except Exception as exc:
                message = f"Сбор остановился на этом проходе: {exc}"
            with connect() as db:
                db.execute("INSERT INTO events VALUES(?,?)", (int(time.time()), message))
        time.sleep(5)


class Panel(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/" or self.headers.get("Host") not in (HOST, "localhost:8765"):
            return self.send_error(404)
        with connect() as db:
            enabled, minutes = db.execute("SELECT enabled,minutes FROM settings").fetchone()
            rows = db.execute("SELECT community,title FROM stories ORDER BY seen DESC,rowid DESC LIMIT 50").fetchall()
            events = db.execute("SELECT datetime(at,'unixepoch'),message FROM events ORDER BY rowid DESC LIMIT 10").fetchall()
        def listing(items):
            return "".join("<li>" + html.escape(" · ".join(row)) + "</li>" for row in items)
        page = f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>Reddit · Inverk Clips</title>
        <style>body{{font:16px system-ui;max-width:840px;margin:4vh auto;padding:1em;background:#fafaf6;color:#152b22}}li{{margin:.65em 0}}input,button{{padding:.5em}}</style>
        <h1>Reddit · GTA VI</h1><form method=post><label><input name=enabled type=checkbox {'checked' if enabled else ''}> Сбор включён</label>
        <label>Интервал, мин <input name=minutes type=number min=5 max=1440 value={minutes} required></label>
        <button>Сохранить</button></form><h2>Последние действия (UTC)</h2><ul>{listing(events)}</ul><h2>Темы и сообщества</h2><ul>{listing(rows)}</ul>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(page.encode())

    def do_POST(self):
        host = self.headers.get("Host")
        if self.path != "/" or host not in (HOST, "localhost:8765") or self.headers.get("Origin") != "http://" + host:
            return self.send_error(403)
        try:
            length = int(self.headers["Content-Length"])
            if not 0 < length < 512:
                raise ValueError()
            data = urllib.parse.parse_qs(self.rfile.read(length).decode())
            minutes = int(data["minutes"][0])
            if not 5 <= minutes <= 1440:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            return self.send_error(400)
        with connect() as db:
            db.execute("UPDATE settings SET enabled=?, minutes=? WHERE id=1", ("enabled" in data, minutes))
        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()


if __name__ == "__main__":
    initialize()
    threading.Thread(target=worker, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8765), Panel).serve_forever()
