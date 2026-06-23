# Deployment Guide

Both **team-phoenix** and **team-hellfire-rollers** run on the same Oracle Cloud VM from separate clones of this repo.

## Server

- **Provider:** Oracle Cloud Always Free (VM.Standard.E2.1.Micro, Ubuntu 22.04)
- **Public IP:** 129.80.178.227
- **SSH:** `ssh -i C:\Users\kato8\.ssh\ssh-key-2026-06-16.key ubuntu@129.80.178.227`

## Ports

| Bot | Port |
|-----|------|
| team-phoenix | 3000 |
| team-hellfire-rollers | 3001 |

Both ports are open in the Oracle VCN security list ingress rules and Ubuntu iptables.

## Process manager

Bots are managed by pm2 and auto-start on reboot.

| Command | Description |
|---------|-------------|
| `pm2 list` | Check status of all bots |
| `pm2 logs <name>` | View logs |
| `pm2 restart <name>` | Restart a bot |
| `pm2 stop <name>` | Stop a bot |

## Repo locations on server

- team-phoenix: `~/team-phoenix/`
- team-hellfire-rollers: `~/team-hellfire-rollers/`

## Deploying an update

```bash
cd ~/team-phoenix   # or ~/team-hellfire-rollers
git pull
npm run build
pm2 restart team-phoenix   # or team-hellfire-rollers
```

## Environment variables

Each clone has its own `.env` file. Key differences between the two:

- `DISCORD_BOT_TOKEN` — different bot token per server
- `DISCORD_CHANNEL_ID` — different channel per server
- `DISCORD_GUILD_ID` — team-phoenix: `1333287434473177109`, team-hellfire-rollers: `1329669121733951581`
- `APPS_SCRIPT_URL` — different Apps Script deployment per server (M+ Exclusion Form script, used by /resend)
- `ROSTER_SCRIPT_URL` — URL of the deployed WGA Raid Hub Apps Script web app (used by roster slash commands)
- `PORT` — team-phoenix omitted (defaults to 3000), team-hellfire-rollers: `3001`
