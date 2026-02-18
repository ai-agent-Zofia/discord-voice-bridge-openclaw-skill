# Discord Voice Bridge

A Discord voice bot that bridges spoken input in a voice channel to an OpenClaw agent response, then plays the reply back as speech.

## What it does

- Registers and serves slash commands:
  - `/join` — joins your current voice channel
  - `/say text:"..."` — speaks a short text snippet
  - `/voicechat state:on|off|status` — turn conversational loop on/off or inspect status
  - `/leave` — leaves voice and stops voicechat workers
- Captures the command invoker's voice from Discord voice packets
- Runs local speech-to-text (Whisper via `faster-whisper`)
- Sends transcript to OpenClaw Responses API
- Converts reply to audio (Google TTS) and plays it in-channel

---

## Internal architecture (detailed)

### 1) Command + control plane (`src/bot.mjs`)

- Uses `discord.js` for gateway events and slash commands.
- Uses `@discordjs/voice` for voice connection, audio receive, decode, and playback.
- On startup:
  1. Loads env vars (`dotenv`)
  2. Falls back to `/home/node/.openclaw/openclaw.json` for missing config values
  3. Registers guild commands through Discord REST API
  4. Logs in bot and starts listening for interactions

### 2) Voice input pipeline

When `/voicechat state:on` is called:

1. Bot joins the invoker's current voice channel.
2. It subscribes to Discord receiver speaking events.
3. For the target user only (invoker), it receives Opus frames.
4. Opus is decoded with `prism-media` to PCM (48kHz, stereo).
5. PCM chunks for one utterance are collected until silence timeout.
6. Collected PCM is wrapped into a WAV buffer with generated header.
7. WAV file is sent to a long-lived Python STT worker process.

### 3) Local STT worker (`scripts/stt_worker.py`)

- Loads `WhisperModel` once at process start (CPU mode).
- Receives JSON lines over stdin (`{"id":"...","path":"...wav"}`).
- Transcribes with low-latency settings:
  - `language="en"`
  - `beam_size=1`
  - `vad_filter=True`
- Returns JSON lines over stdout (`{"id":"...","text":"..."}` or error).

This avoids reloading Whisper for every utterance and keeps latency much lower than one-process-per-request.

### 4) Agent round-trip (OpenClaw)

- Transcripts are posted to OpenClaw Responses endpoint:
  - default: `http://127.0.0.1:<gatewayPort>/v1/responses`
- Payload targets `model: "openclaw:main"` with concise voice instructions.
- The bridge extracts assistant text from responses and applies cleanup for TTS:
  - strips emoji/pictographic chars
  - normalizes whitespace
  - clamps length for TTS safety

### 5) Audio output

- Uses `google-tts-api` to fetch MP3 for cleaned reply text.
- Plays MP3 via shared Discord audio player.
- Applies a short cooldown after playback to reduce self-trigger loops.
- Cleans temp audio files after playback.

### 6) Concurrency + safety controls

Per-guild runtime state tracks:

- enable/disable status
- active speaker stream handles
- STT worker instance
- serialized utterance queue
- duplicate transcript suppression window
- post-TTS cooldown window

`/leave` and `/voicechat off` both hard-stop listeners/streams and worker process.

---

## Configuration

Copy template and fill values:

```bash
cp .env.example .env
```

Required:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`

Optional tuning:

- `STT_MODEL` (default `tiny.en`)
- `STT_COMPUTE` (default `int8`)
- `VOICE_POST_TTS_COOLDOWN_MS` (default `800`)
- `MIN_TRANSCRIPT_CHARS` (default `4`)
- `OPENCLAW_RESPONSES_URL`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_GATEWAY_PORT`

If not provided in env, some values are auto-discovered from OpenClaw config.

---

## Local run (inside OpenClaw container)

```bash
docker exec -it clawdbot-openclaw-gateway-1 sh
cd /home/node/.openclaw/workspace/discord-voice-bridge

# Node runtime
source ~/.nvm/nvm.sh
nvm use 22 || nvm install 22

# Node deps
npm install

# Python deps for STT worker
python3 -m ensurepip --upgrade || true
python3 -m pip install --upgrade pip
python3 -m pip install faster-whisper

# configure env
cp .env.example .env
# edit .env values

npm start
```

---

## Discord app requirements

Scopes:

- `bot`
- `applications.commands`

Recommended bot permissions:

- View Channels
- Connect
- Speak
- Use Voice Activity
- Read Message History (optional but useful)

---

## Security notes

- Never commit `.env` or secrets.
- Keep bot tokens and gateway tokens rotated and private.
- Consider restricting command availability to trusted roles/channels.
- This repository is designed to be safe for private-by-default publishing.

---

## Current limitations

- Voicechat currently listens to command invoker only.
- English-first STT settings (`tiny.en` default).
- Google TTS is used for speed/simplicity; voice customization is limited.
- No wake-word model or interruption barge-in policy yet.

---

## Future improvements

- Per-user multi-speaker sessions
- Better echo cancellation / loop resistance
- Pluggable TTS backends (local neural voices)
- Streaming partial transcripts + partial response playback
- Rich per-guild config and persisted profiles
