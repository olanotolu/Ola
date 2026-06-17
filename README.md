# Ola — Paperclip

Local Paperclip instance for managing AI agent companies.

## Live demo (temporary)

While your Mac is running Paperclip + the Cloudflare tunnel:

- **Dashboard:** https://famous-webs-enter.loca.lt
- **Health:** https://famous-webs-enter.loca.lt/api/health

This is a quick tunnel URL — it stops when the tunnel process stops. For a permanent public URL, deploy to [Railway](https://railway.com/deploy/paperclip-ai) or [Render](render.yaml) (see below).

> **Vercel cannot host Paperclip** — it needs a long-running Node server + PostgreSQL, not serverless functions. This repo uses Vercel only as a redirect landing page to your live Paperclip URL.

## Quick start

```bash
npm run setup   # first-time install (already done)
npm run start   # start the server
```

Open **http://localhost:3100** in your browser.

## Data location

Paperclip stores all instance data under:

```
~/.paperclip/instances/default/
```

- Config: `config.json`
- Database: `db/` (embedded PostgreSQL on port 54329)
- Storage: `data/storage/`
- Secrets: `secrets/master.key`

## Create your first company

1. Open http://localhost:3100
2. Click **Create Company**
3. Enter a name and optional mission/goal
4. Repeat for each venture — one instance supports many companies

Check via API:

```bash
curl http://localhost:3100/api/companies
```

## Day-to-day commands

| Action | Command |
|---|---|
| Start server | `npm run start` |
| Reconfigure | `npm run configure` |
| Diagnostics | `npm run doctor` |
| Reset everything | `rm -rf ~/.paperclip/instances/default/db` then `npm run start` |

## Notes

- `npm run start` runs in the foreground — keep the terminal open, or use `tmux`/`screen` for always-on.
- No LLM provider is configured yet. Add one later with `npm run configure` → LLM section.
- Agents, budgets, and approvals are configured after you create companies.
