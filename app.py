#!/usr/bin/env python3
"""gore.kreatix.dev — LiveLeak-style media platform.

FastAPI + SQLite. Chunked uploads (bypasses the Cloudflare 100MB request cap),
range-aware media serving, ffmpeg thumbnails, feed/votes/comments/reports,
token-gated admin moderation.
"""

import hashlib
import json
import os
import re
import secrets
import sqlite3
import string
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import (FileResponse, JSONResponse, Response,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent
MEDIA_DIR = Path(os.environ.get("GORE_MEDIA_DIR", BASE_DIR / "media"))
THUMB_DIR = MEDIA_DIR / "thumbs"
TMP_DIR = MEDIA_DIR / "tmp"
DB_PATH = Path(os.environ.get("GORE_DB", BASE_DIR / "gore.db"))
ADMIN_TOKEN = os.environ.get("GORE_ADMIN_TOKEN", "")
MAX_UPLOAD = 4 * 1024 * 1024 * 1024  # 4 GB hard ceiling
CHUNK_READ = 1024 * 1024

for d in (MEDIA_DIR, THUMB_DIR, TMP_DIR):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="gore", docs_url=None, redoc_url=None, openapi_url=None)


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    nick TEXT DEFAULT 'anonymous',
    media_file TEXT NOT NULL,
    media_mime TEXT NOT NULL,
    media_kind TEXT NOT NULL,          -- video | image
    thumb TEXT DEFAULT '',
    duration REAL DEFAULT 0,
    views INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',      -- active | removed
    uploader TEXT DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    nick TEXT DEFAULT 'anonymous',
    body TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    voter TEXT NOT NULL,
    dir INTEGER NOT NULL,
    PRIMARY KEY (post_id, voter)
);
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reason TEXT DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_reports_post ON reports(post_id);
"""

with db() as c:
    c.executescript(SCHEMA)


def slug(n: int = 8) -> str:
    return "".join(secrets.choice(string.ascii_lowercase + string.digits)
                   for _ in range(n))


def clean(s: str, limit: int) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", (s or "")).strip()[:limit]


def clean_tags(s: str) -> str:
    tags = [t.lstrip("#").strip().lower() for t in re.split(r"[,\s]+", s or "")]
    tags = [t for t in tags if re.fullmatch(r"[a-z0-9_\-]{1,24}", t)]
    seen, out = set(), []
    for t in tags:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return ",".join(out[:12])


def voter_id(req: Request) -> str:
    raw = f"{req.client.host}|{req.headers.get('user-agent','')}|gore"
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


def check_admin(x_admin_token: str = ""):
    if not ADMIN_TOKEN or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(401, "bad admin token")


def post_row(p: sqlite3.Row) -> dict:
    d = dict(p)
    d["media_url"] = f"/media/{d['media_file']}"
    d["thumb_url"] = f"/media/thumbs/{d['thumb']}" if d["thumb"] else d["media_url"] if d["media_kind"] == "image" else ""
    d["tags"] = [t for t in d["tags"].split(",") if t]
    return d


def probe_duration(path: Path) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", str(path)],
            capture_output=True, text=True, timeout=30).stdout
        return float(json.loads(out or "{}").get("format", {})
                     .get("duration", 0) or 0)
    except Exception:
        return 0.0


def make_thumb(src: Path, kind: str, dur: float) -> str:
    name = src.stem + ".jpg"
    dst = THUMB_DIR / name
    try:
        if kind == "video":
            at = max(0.0, min(dur * 0.15, 30))
            cmd = ["ffmpeg", "-y", "-ss", f"{at:.1f}", "-i", str(src),
                   "-frames:v", "1", "-vf",
                   "scale=640:-2:flags=lanczos", "-q:v", "4", str(dst)]
        else:
            cmd = ["ffmpeg", "-y", "-i", str(src), "-frames:v", "1", "-vf",
                   "scale=640:-2:flags=lanczos", "-q:v", "4", str(dst)]
        subprocess.run(cmd, capture_output=True, timeout=120)
        return name if dst.exists() else ""
    except Exception:
        return ""


# ---------------- media serving (range aware) ----------------

def serve_range(path: Path, req: Request):
    size = path.stat().st_size
    ctype = _mime(path)
    rng = req.headers.get("range")
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            if m.group(1) == "" and m.group(2):  # suffix range
                start = max(0, size - int(m.group(2)))
            if start > end:
                return Response(status_code=416,
                                headers={"Content-Range": f"bytes */{size}"})
            length = end - start + 1

            def gen():
                with open(path, "rb") as f:
                    f.seek(start)
                    left = length
                    while left > 0:
                        chunk = f.read(min(CHUNK_READ, left))
                        if not chunk:
                            break
                        left -= len(chunk)
                        yield chunk

            return StreamingResponse(gen(), status_code=206, headers={
                "Content-Type": ctype,
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=86400",
            })
    return FileResponse(path, media_type=ctype, headers={
        "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400"})


def _mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
        ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
        ".m4v": "video/mp4", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
        ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
    }.get(ext, "application/octet-stream")


def safe_media(name: str) -> Path:
    p = (MEDIA_DIR / name).resolve()
    if not str(p).startswith(str(MEDIA_DIR.resolve())) or not p.is_file():
        raise HTTPException(404)
    return p


@app.get("/media/thumbs/{name}")
def thumb(name: str, request: Request):
    return serve_range(safe_media(f"thumbs/{name}"), request)


@app.get("/media/{name}")
def media(name: str, request: Request):
    return serve_range(safe_media(name), request)


# ---------------- chunked upload ----------------

@app.post("/api/uploads")
def new_upload(body: dict):
    fname = clean(body.get("filename", "file"), 120)
    size = int(body.get("size") or 0)
    if size <= 0 or size > MAX_UPLOAD:
        raise HTTPException(400, "bad size")
    uid = slug(16)
    (TMP_DIR / uid).write_bytes(b"")
    meta = {"filename": fname, "size": size, "received": 0,
            "created": time.time()}
    (TMP_DIR / f"{uid}.json").write_text(json.dumps(meta))
    return {"upload_id": uid}


@app.put("/api/uploads/{uid}/chunk")
async def chunk(uid: str, request: Request, offset: int = Query(0)):
    f = TMP_DIR / uid
    meta_f = TMP_DIR / f"{uid}.json"
    if not f.exists() or not meta_f.exists() or not re.fullmatch(r"[a-z0-9]+", uid):
        raise HTTPException(404, "no such upload")
    meta = json.loads(meta_f.read_text())
    if offset != meta["received"]:
        raise HTTPException(409, f"offset mismatch, expected {meta['received']}")
    written = 0
    with open(f, "r+b") as out:
        out.seek(offset)
        async for data in request.stream():
            out.write(data)
            written += len(data)
    meta["received"] += written
    meta_f.write_text(json.dumps(meta))
    return {"received": meta["received"], "size": meta["size"]}


@app.post("/api/uploads/{uid}/complete")
def complete(uid: str):
    f = TMP_DIR / uid
    meta_f = TMP_DIR / f"{uid}.json"
    if not f.exists() or not meta_f.exists():
        raise HTTPException(404)
    meta = json.loads(meta_f.read_text())
    if meta["received"] < meta["size"]:
        raise HTTPException(400, "incomplete")
    ext = Path(meta["filename"]).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext or ""):
        ext = ""
    name = slug(12) + ext
    dst = MEDIA_DIR / name
    f.rename(dst)
    meta_f.unlink(missing_ok=True)
    if ext in (".mp4", ".m4v", ".mov"):
        # move moov atom up front so playback starts instantly
        fast = MEDIA_DIR / (name + ".fast.mp4")
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(dst), "-c", "copy",
             "-movflags", "+faststart", str(fast)],
            capture_output=True, timeout=300)
        if r.returncode == 0 and fast.exists():
            fast.replace(dst)
        else:
            fast.unlink(missing_ok=True)
    return {"file": name, "mime": _mime(Path(name))}


# ---------------- posts / feed ----------------

@app.post("/api/posts")
def create_post(body: dict, request: Request):
    media_file = body.get("file", "")
    src = safe_media(media_file)
    mime = _mime(src)
    kind = "video" if mime.startswith("video") else \
        "image" if mime.startswith("image") else None
    if kind is None:
        raise HTTPException(400, "unsupported media type")
    title = clean(body.get("title"), 140)
    if not title:
        raise HTTPException(400, "title required")
    dur = probe_duration(src) if kind == "video" else 0.0
    thumb = make_thumb(src, kind, dur)
    s = slug()
    with db() as c:
        c.execute(
            """INSERT INTO posts
               (slug,title,description,tags,nick,media_file,media_mime,
                media_kind,thumb,duration,uploader,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (s, title, clean(body.get("description"), 4000),
             clean_tags(body.get("tags", "")),
             clean(body.get("nick"), 40) or "anonymous",
             media_file, mime, kind, thumb, dur,
             voter_id(request), time.time()))
    return {"slug": s, "url": f"/p/{s}"}


@app.get("/api/feed")
def feed(sort: str = "new", tag: str = "", q: str = "",
         page: int = 1, per: int = 24):
    per = max(1, min(per, 60))
    page = max(1, page)
    order = {"new": "created_at DESC", "top": "score DESC",
             "views": "views DESC"}.get(sort, "created_at DESC")
    where, args = ["status='active'"], []
    if tag:
        where.append("(','||tags||',') LIKE ?")
        args.append(f"%,{clean(tag,24).lower()},%")
    if q:
        where.append("(title LIKE ? OR description LIKE ? OR tags LIKE ?)")
        qq = f"%{clean(q,60)}%"
        args += [qq, qq, qq]
    w = " AND ".join(where)
    with db() as c:
        total = c.execute(f"SELECT COUNT(*) n FROM posts WHERE {w}",
                          args).fetchone()["n"]
        rows = c.execute(
            f"""SELECT p.*,
                 (SELECT COUNT(*) FROM comments cm WHERE cm.post_id=p.id
                    AND cm.status='active') comments_count,
                 (SELECT body FROM comments cm WHERE cm.post_id=p.id
                    AND cm.status='active' ORDER BY id DESC LIMIT 1) latest_body,
                 (SELECT nick FROM comments cm WHERE cm.post_id=p.id
                    AND cm.status='active' ORDER BY id DESC LIMIT 1) latest_nick,
                 (SELECT created_at FROM comments cm WHERE cm.post_id=p.id
                    AND cm.status='active' ORDER BY id DESC LIMIT 1) latest_at
               FROM posts p WHERE {w} ORDER BY {order}, p.id DESC
               LIMIT ? OFFSET ?""",
            args + [per, (page - 1) * per]).fetchall()
        tags = c.execute(
            "SELECT tags FROM posts WHERE status='active' AND tags!='' "
            "ORDER BY created_at DESC LIMIT 400").fetchall()
    counts = {}
    for r in tags:
        for t in r["tags"].split(","):
            if t:
                counts[t] = counts.get(t, 0) + 1
    top_tags = sorted(counts, key=counts.get, reverse=True)[:20]
    return {"posts": [post_row(r) for r in rows], "total": total,
            "page": page, "per": per, "tags": top_tags}


@app.get("/api/post/{s}")
def get_post(s: str):
    with db() as c:
        p = c.execute("SELECT * FROM posts WHERE slug=?", (s,)).fetchone()
        if not p or p["status"] != "active":
            raise HTTPException(404)
        comments = c.execute(
            "SELECT id,nick,body,created_at FROM comments "
            "WHERE post_id=? AND status='active' ORDER BY id DESC LIMIT 300",
            (p["id"],)).fetchall()
    return {"post": post_row(p), "comments": [dict(x) for x in comments]}


@app.post("/api/post/{s}/view")
def view(s: str):
    with db() as c:
        c.execute("UPDATE posts SET views=views+1 WHERE slug=? AND "
                  "status='active'", (s,))
    return {"ok": True}


@app.post("/api/post/{s}/vote")
def vote(s: str, body: dict, request: Request):
    d = 1 if (body.get("dir") or 0) > 0 else -1
    v = voter_id(request)
    with db() as c:
        p = c.execute("SELECT id FROM posts WHERE slug=? AND status='active'",
                      (s,)).fetchone()
        if not p:
            raise HTTPException(404)
        old = c.execute("SELECT dir FROM votes WHERE post_id=? AND voter=?",
                        (p["id"], v)).fetchone()
        if old and old["dir"] == d:  # toggle off
            c.execute("DELETE FROM votes WHERE post_id=? AND voter=?",
                      (p["id"], v))
            c.execute("UPDATE posts SET score=score-? WHERE id=?",
                      (d, p["id"]))
        elif old:  # flip
            c.execute("UPDATE votes SET dir=? WHERE post_id=? AND voter=?",
                      (d, p["id"], v))
            c.execute("UPDATE posts SET score=score+? WHERE id=?",
                      (2 * d, p["id"]))
        else:
            c.execute("INSERT INTO votes(post_id,voter,dir) VALUES(?,?,?)",
                      (p["id"], v, d))
            c.execute("UPDATE posts SET score=score+? WHERE id=?",
                      (d, p["id"]))
        score = c.execute("SELECT score FROM posts WHERE id=?",
                          (p["id"],)).fetchone()["score"]
    return {"score": score}


@app.post("/api/post/{s}/comment")
def comment(s: str, body: dict):
    text = clean(body.get("body"), 2000)
    if not text:
        raise HTTPException(400, "empty")
    nick = clean(body.get("nick"), 40) or "anonymous"
    with db() as c:
        p = c.execute("SELECT id FROM posts WHERE slug=? AND status='active'",
                      (s,)).fetchone()
        if not p:
            raise HTTPException(404)
        c.execute("INSERT INTO comments(post_id,nick,body,created_at) "
                  "VALUES(?,?,?,?)", (p["id"], nick, text, time.time()))
    return {"ok": True}


@app.post("/api/post/{s}/report")
def report(s: str, body: dict):
    reason = clean(body.get("reason"), 300)
    with db() as c:
        p = c.execute("SELECT id FROM posts WHERE slug=? AND status='active'",
                      (s,)).fetchone()
        if not p:
            raise HTTPException(404)
        c.execute("INSERT INTO reports(post_id,reason,created_at) "
                  "VALUES(?,?,?)", (p["id"], reason, time.time()))
    return {"ok": True}


# ---------------- admin ----------------

@app.get("/api/admin/posts")
def admin_posts(x_admin_token: str = Header(""), status: str = ""):
    check_admin(x_admin_token)
    w = "WHERE status=?" if status in ("active", "removed") else ""
    args = [status] if w else []
    with db() as c:
        rows = c.execute(
            f"""SELECT p.*, (SELECT COUNT(*) FROM reports r
                 WHERE r.post_id=p.id) reports FROM posts p {w}
                ORDER BY created_at DESC LIMIT 500""", args).fetchall()
    return {"posts": [post_row(r) for r in rows]}


@app.get("/api/admin/reports")
def admin_reports(x_admin_token: str = Header("")):
    check_admin(x_admin_token)
    with db() as c:
        rows = c.execute(
            """SELECT r.id rid, r.reason, r.created_at, p.slug, p.title,
                      p.status, p.thumb, p.media_kind, p.media_file,
                      p.media_mime, p.views, p.score, p.nick, p.duration,
                      p.description, p.tags, p.id
               FROM reports r JOIN posts p ON p.id=r.post_id
               ORDER BY r.id DESC LIMIT 500""").fetchall()
    return {"reports": [post_row(r) | {"rid": r["rid"],
                                       "reason": r["reason"]} for r in rows]}


@app.post("/api/admin/post/{s}/status")
def admin_status(s: str, body: dict, x_admin_token: str = Header("")):
    check_admin(x_admin_token)
    st = body.get("status")
    if st not in ("active", "removed"):
        raise HTTPException(400)
    with db() as c:
        c.execute("UPDATE posts SET status=? WHERE slug=?", (st, s))
    return {"ok": True}


@app.post("/api/admin/comment/{cid}/status")
def admin_comment(cid: int, body: dict, x_admin_token: str = Header("")):
    check_admin(x_admin_token)
    st = body.get("status")
    if st not in ("active", "removed"):
        raise HTTPException(400)
    with db() as c:
        c.execute("UPDATE comments SET status=? WHERE id=?", (st, cid))
    return {"ok": True}


@app.get("/api/stats")
def stats():
    with db() as c:
        p = c.execute("SELECT COUNT(*) n, COALESCE(SUM(views),0) v FROM posts "
                      "WHERE status='active'").fetchone()
        cm = c.execute("SELECT COUNT(*) n FROM comments WHERE status='active'"
                       ).fetchone()
    return {"posts": p["n"], "views": p["v"], "comments": cm["n"]}


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path == "/api/feed":
        resp.headers["Cache-Control"] = "public, s-maxage=8, max-age=0"
    elif path.startswith(("/app.js", "/admin.js", "/style.css")) or \
            path.endswith((".css", ".js", ".png", ".ico", ".woff2")):
        resp.headers.setdefault("Cache-Control", "public, max-age=3600")
    return resp


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True),
          name="static")
