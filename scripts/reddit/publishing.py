"""Schedule finished Reddit episodes for profiles connected through Upload-Post."""
import json
import os
import time
from pathlib import Path


def initialize(db):
    db.executescript("""
    CREATE TABLE IF NOT EXISTS channels(profile TEXT PRIMARY KEY, enabled INTEGER, hours INTEGER, next_at INTEGER);
    CREATE TABLE IF NOT EXISTS deliveries(profile TEXT, episode TEXT, status TEXT, updated INTEGER,
        PRIMARY KEY(profile,episode));
    """)


def tick(db):
    key = os.environ.get("UPLOAD_POST_API_KEY")
    if not key:
        return
    now = int(time.time())
    folders = sorted(Path(os.getenv("REDDIT_READY_DIR", "reddit-ready")).glob("*/ready.json"))
    for profile, hours in db.execute("SELECT profile,hours FROM channels WHERE enabled=1 AND next_at<=? ORDER BY next_at", (now,)).fetchall():
        for manifest in folders:
            episode = manifest.parent.name
            video = manifest.parent / "video.mp4"
            if not video.is_file():
                continue
            title = json.loads(manifest.read_text()).get("caption")
            if not isinstance(title, str) or not title.strip():
                continue
            with db:
                if not db.execute("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?)",
                                  (profile, episode, "Отправка начата", now)).rowcount:
                    continue
                db.execute("UPDATE channels SET next_at=? WHERE profile=?", (now+hours*3600, profile))
            try:
                import requests
                with video.open("rb") as stream:
                    response = requests.post("https://api.upload-post.com/api/upload",
                        headers={"Authorization": "Apikey " + key},
                        data={"user": profile, "platform[]": "tiktok", "title": title},
                        files={"video": ("episode.mp4", stream, "video/mp4")}, timeout=(10,180))
                result = response.json()
                status = "Принято сервисом" if response.ok and result.get("success") else "Проверить у провайдера"
            except Exception:
                status = "Проверить у провайдера"
            with db:
                db.execute("UPDATE deliveries SET status=?,updated=? WHERE profile=? AND episode=?",
                           (status,int(time.time()),profile,episode))
            break
