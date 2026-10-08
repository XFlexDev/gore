# GORE

Uncensored, LiveLeak-style media platform. User uploads, anonymous by default,
18+ age gate, tags, votes, comments, reports, admin moderation.

Stack: FastAPI + SQLite + ffmpeg thumbnails + vanilla JS SPA.

## Run

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
GORE_ADMIN_TOKEN=changeme .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8450
```

- Feed: `http://127.0.0.1:8450/`
- Admin: `http://127.0.0.1:8450/admin.html` (token = `GORE_ADMIN_TOKEN`)
- Media stored in `media/`, DB in `gore.db`.

Uploads are chunked client-side (32MB) so they pass Cloudflare's 100MB
request cap. Media is range-served so video seeking works.

## Deploy on .245

Lives at `/opt/gore`, unit `gore.service`, Caddy reverse-proxies
`gore.kreatix.dev` → `127.0.0.1:8450`. Admin token in `/etc/gore.env`.

## Seed

```sh
python3 scripts/seed.py --base https://gore.kreatix.dev --source wikimedia --limit 12
python3 scripts/seed.py --base https://gore.kreatix.dev --source itemfix --limit 10
```
