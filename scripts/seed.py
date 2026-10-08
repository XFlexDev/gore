#!/usr/bin/env python3
"""Light seeder for gore — pulls a handful of items from a public source
and posts them through the HTTP API. Not a crawler: one listing page,
N items, one request at a time.

Usage:
  python3 seed.py --base https://gore.kreatix.dev --source itemfix --limit 10
  python3 seed.py --base http://127.0.0.1:8450 --source itemfix --limit 5
"""

import argparse
import html
import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urljoin

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MAX_FILE = 90 * 1024 * 1024  # keep under CF's 100MB request cap


def fetch(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------- sources ----------------

def itemfix_items(limit: int):
    """itemfix.com (LiveLeak successor). Parses the most-viewed listing."""
    out = []
    url = "https://www.itemfix.com/vc?t=rm"
    page = fetch(url).decode("utf-8", "replace")
    # each card: link to /v?t=XXX with a title; video mp4 resolved on the page
    links = re.findall(r'href="(/v\?t=[a-z0-9_]+)"[^>]*>', page, re.I)
    seen = []
    for l in links:
        if l not in seen:
            seen.append(l)
    for l in seen[: limit * 3]:
        try:
            sub = fetch(urljoin(url, l)).decode("utf-8", "replace")
            title = html.unescape(
                re.search(r"<title>(.*?)</title>", sub, re.S).group(1)
            ).split(" - ")[0].strip()
            mp4 = re.search(r'(https://[^"\']+\.mp4[^"\']*)', sub)
            if not mp4:
                continue
            out.append({"title": title, "media_url": html.unescape(mp4.group(1)),
                        "tags": "itemfix", "desc": f"via itemfix.com"})
            if len(out) >= limit:
                break
            time.sleep(1)
        except Exception:
            continue
    return out


def kaotic_items(limit: int):
    """kaotic.com — front-page video links, og:video mp4 from each page."""
    out = []
    page = fetch("https://www.kaotic.com/").decode("utf-8", "replace")
    links = []
    for l in re.findall(r'href="(https://kaotic\.com/video/[^"]+)"', page):
        if l not in links:
            links.append(l)
    for l in links:
        if len(out) >= limit:
            break
        try:
            sub = fetch(l).decode("utf-8", "replace")
            t = re.search(r"<title>(.*?)</title>", sub, re.S)
            title = html.unescape(t.group(1)).strip() if t else "untitled"
            if not re.search(r'og:video[^>]*content="([^"]+)"', sub):
                continue
            out.append({"title": title[:140], "page_url": l,
                        "tags": "kaotic", "desc": f"via {l}",
                        "nick": "kaotic"})
        except Exception:
            continue
    return out


def wikimedia_items(limit: int):
    """Safe fallback: graphic historical/medical stills from Wikimedia
    Commons categories — public domain, real, unglamorous."""
    cats = [
        "Category:War injuries", "Category:Crime scene photographs",
        "Category:Autopsies", "Category:World War II casualties",
        "Category:Executions", "Category:Traffic collisions",
    ]
    out = []
    for cat in cats:
        if len(out) >= limit:
            break
        api = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
               f"&list=categorymembers&cmtitle={urllib.parse.quote(cat)}"
               "&cmtype=file&cmlimit=10")
        try:
            data = json.loads(fetch(api))
        except Exception:
            continue
        for m in data.get("query", {}).get("categorymembers", []):
            if len(out) >= limit:
                break
            title = m["title"].replace("File:", "")
            ext = Path(title).suffix.lower()
            if ext not in (".jpg", ".jpeg", ".png", ".webp"):
                continue
            file_url = ("https://commons.wikimedia.org/wiki/Special:FilePath/"
                        + urllib.parse.quote(title.replace(" ", "_")))
            out.append({
                "title": re.sub(r"\.[a-z]+$", "", title)[:140],
                "media_url": file_url, "tags": "history archive",
                "desc": f"Wikimedia Commons — {cat.split(':')[1]}",
                "nick": "archive"})
    return out


SOURCES = {"kaotic": kaotic_items, "itemfix": itemfix_items,
           "wikimedia": wikimedia_items}


# ---------------- upload via API ----------------

def post_item(base: str, item: dict) -> bool:
    media_url = item.get("media_url")
    if not media_url and item.get("page_url"):
        # resolve signed CDN URL right before download (it expires fast)
        sub = fetch(item["page_url"]).decode("utf-8", "replace")
        m = re.search(r'og:video[^>]*content="([^"]+)"', sub)
        if not m:
            return False
        media_url = html.unescape(m.group(1))
    if not media_url:
        return False
    data = fetch(media_url, timeout=300)
    if len(data) > MAX_FILE:
        return False
    fname = media_url.split("?")[0].rstrip("/").split("/")[-1] or "media"
    if not re.search(r"\.(mp4|webm|jpg|jpeg|png|gif|webp|mov)$", fname, re.I):
        fname += ".bin"
    r = urllib.request.Request(
        base + "/api/uploads",
        data=json.dumps({"filename": fname, "size": len(data)}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA})
    uid = json.loads(urllib.request.urlopen(r, timeout=30).read())["upload_id"]
    r = urllib.request.Request(
        f"{base}/api/uploads/{uid}/chunk?offset=0", data=data, method="PUT",
        headers={"User-Agent": UA})
    urllib.request.urlopen(r, timeout=120).read()
    fin = json.loads(urllib.request.urlopen(
        urllib.request.Request(f"{base}/api/uploads/{uid}/complete",
                               data=b"", method="POST",
                               headers={"User-Agent": UA}), timeout=30).read())
    body = {"file": fin["file"], "title": item["title"][:140] or "untitled",
            "description": item.get("desc", ""), "tags": item.get("tags", ""),
            "nick": item.get("nick", "bot")}
    r = urllib.request.Request(base + "/api/posts",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA})
    urllib.request.urlopen(r, timeout=30).read()
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8450")
    ap.add_argument("--source", choices=list(SOURCES), default="wikimedia")
    ap.add_argument("--limit", type=int, default=10)
    a = ap.parse_args()
    items = SOURCES[a.source](a.limit)
    print(f"{len(items)} candidate items from {a.source}", file=sys.stderr)
    ok = 0
    for it in items:
        try:
            if post_item(a.base, it):
                ok += 1
                print(f"+ {it['title'][:60]}", file=sys.stderr)
        except Exception as e:
            print(f"- {it['title'][:60]}: {e}", file=sys.stderr)
        time.sleep(0.5)
    print(f"seeded {ok}/{len(items)}", file=sys.stderr)


if __name__ == "__main__":
    import urllib.parse  # noqa
    main()
