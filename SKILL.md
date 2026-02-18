---
name: discord-voice-bridge
description: Bridge Discord voice input to OpenClaw responses and speak replies back in-channel. Use when you want hands-free voice interaction in a Discord server.
---

# Discord Voice Bridge

Run a Discord bot that:
- joins voice channels,
- transcribes the command invoker's speech (local Whisper via `faster-whisper`),
- sends transcript to OpenClaw Responses API,
- speaks the model reply in voice chat.

## When to use
- You need live voice chat with your OpenClaw agent in Discord.
- You want local STT (no cloud STT dependency).

## Required secrets (local `.env` only)
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

Optional:
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_RESPONSES_URL`
- `OPENCLAW_GATEWAY_PORT`
- `STT_MODEL` (default `tiny.en`)
- `STT_COMPUTE` (default `int8`)

Never commit `.env` or tokens.

## Install (OpenClaw container-aware)

```bash
# if running from host, enter gateway container first
docker exec -it clawdbot-openclaw-gateway-1 sh

cd /home/node/.openclaw/workspace/skills/discord-voice-bridge

# Node 22+
source ~/.nvm/nvm.sh
nvm use 22 || nvm install 22

# Configure secrets
cp .env.example .env
# edit .env with real values

# Install dependencies
./scripts/install.sh
```

## Run

```bash
cd /home/node/.openclaw/workspace/skills/discord-voice-bridge
./scripts/run.sh
```

## Verify setup

```bash
cd /home/node/.openclaw/workspace/skills/discord-voice-bridge
./scripts/verify.sh
```

In Discord, check slash commands:
- `/join`
- `/say text:"hello"`
- `/voicechat state:on`
- `/voicechat state:status`
- `/leave`

## Notes
- This skill listens to the user who enabled `/voicechat state:on`.
- English-first STT defaults (`tiny.en`).
- Google TTS is used (simple, limited voice customization).
