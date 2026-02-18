import 'dotenv/config';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import ffmpegPath from 'ffmpeg-static';
import googleTTS from 'google-tts-api';
import prism from 'prism-media';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';

process.env.FFMPEG_PATH = ffmpegPath || process.env.FFMPEG_PATH;

let token = process.env.DISCORD_TOKEN;
let clientId = process.env.DISCORD_CLIENT_ID;
let guildId = process.env.DISCORD_GUILD_ID;
let gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
let gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';

if (!token || !clientId || !guildId) {
  try {
    const cfgRaw = await fs.readFile('/home/node/.openclaw/openclaw.json', 'utf8');
    const cfg = JSON.parse(cfgRaw);
    token ||= cfg?.channels?.discord?.token;
    clientId ||= cfg?.channels?.discord?.applicationId || cfg?.channels?.discord?.appId;
    if (!guildId) {
      const gids = Object.keys(cfg?.channels?.discord?.guilds || {});
      guildId = gids[0];
    }
    gatewayToken ||= cfg?.gateway?.auth?.token;
    if (cfg?.gateway?.port) gatewayPort = String(cfg.gateway.port);
  } catch {}
}

if (!token || !clientId || !guildId) {
  console.error('Missing config. Set DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID (env or openclaw.json).');
  process.exit(1);
}

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const STT_MODEL = process.env.STT_MODEL || 'tiny.en';
const STT_COMPUTE = process.env.STT_COMPUTE || 'int8';
const OPENCLAW_RESPONSES_URL = process.env.OPENCLAW_RESPONSES_URL || `http://127.0.0.1:${gatewayPort}/v1/responses`;
const VOICE_POST_TTS_COOLDOWN_MS = Number(process.env.VOICE_POST_TTS_COOLDOWN_MS || 800);
const MIN_TRANSCRIPT_CHARS = Number(process.env.MIN_TRANSCRIPT_CHARS || 4);

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel.'),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Speak a short sentence in the current voice channel.')
    .addStringOption((opt) => opt.setName('text').setDescription('What to say').setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel (also stops voicechat).'),
  new SlashCommandBuilder()
    .setName('voicechat')
    .setDescription('Enable/disable voice transcription + auto voice response.')
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('On or off')
        .setRequired(true)
        .addChoices(
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
          { name: 'status', value: 'status' },
        ),
    ),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer();

/** @type {Map<string, {enabled:boolean, userId:string, sessionUser:string, stopFns:(()=>void)[], activeStreams:Set<any>, sttWorker: STTWorker | null, queue: Promise<void>, lastTranscript:string, lastTranscriptAt:number, lastReplyAt:number, cooldownUntil:number}>} */
const voiceChatState = new Map();

player.on('error', (err) => console.error('Audio player error:', err.message));

class STTWorker {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
  }

  start() {
    if (this.proc) return;

    const projectRoot = '/home/node/.openclaw/workspace/discord-voice-bridge';
    const scriptPath = path.resolve(projectRoot, 'scripts/stt_worker.py');
    const venvPython = path.resolve(projectRoot, '.venv/bin/python');
    const pythonBin = process.env.STT_PYTHON || (existsSync(venvPython) ? venvPython : 'python3');

    this.proc = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        STT_MODEL,
        STT_COMPUTE,
      },
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx = this.buffer.indexOf('\n');
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this._handleLine(line);
        idx = this.buffer.indexOf('\n');
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      console.error('[stt_worker]', chunk.toString('utf8').trim());
    });

    this.proc.on('exit', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('STT worker exited unexpectedly'));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  _handleLine(line) {
    try {
      const msg = JSON.parse(line);
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.text || '');
    } catch (err) {
      console.error('Failed parsing STT worker output:', err.message);
    }
  }

  async transcribeWav(filePath, timeoutMs = 15000) {
    this.start();
    const id = randomUUID();
    const payload = JSON.stringify({ id, path: filePath }) + '\n';

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('STT timeout'));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('STT worker stopped'));
    }
    this.pending.clear();
  }
}

function connectToMemberVoice(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) return null;

  const existing = getVoiceConnection(channel.guild.id);
  if (existing) return existing;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  connection.subscribe(player);
  return connection;
}

async function synthesizeToMp3(text) {
  const url = googleTTS.getAudioUrl(text, {
    lang: 'en',
    slow: false,
    host: 'https://translate.google.com',
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TTS fetch failed: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(os.tmpdir(), `zofia-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
  await fs.writeFile(out, buf);
  return out;
}

function sanitizeVoiceReply(text) {
  // strip most emoji/pictographic chars for voice mode
  const noEmoji = (text || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, '');
  // collapse whitespace and clamp to avoid google-tts-api 200-char limit issues
  return noEmoji.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function speak(text) {
  const safeText = sanitizeVoiceReply(text);
  if (!safeText) return;
  const mp3Path = await synthesizeToMp3(safeText);
  const resource = createAudioResource(mp3Path);

  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 8_000);

  player.once(AudioPlayerStatus.Idle, async () => {
    try { await fs.unlink(mp3Path); } catch {}
  });
}

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();

  const items = Array.isArray(data.output) ? data.output : [];
  const chunks = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && part?.text) chunks.push(part.text);
      }
    }
  }
  return chunks.join(' ').trim();
}

async function askZofia(inputText, sessionUser = null) {
  if (!gatewayToken) {
    return `I heard: ${inputText}`;
  }

  const payload = {
    model: 'openclaw:main',
    instructions: 'Voice mode: reply briefly (1-2 short sentences), plain text only, no emojis, no markdown.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: inputText }],
      },
    ],
    max_output_tokens: 120,
  };
  if (sessionUser) payload.user = sessionUser;

  const res = await fetch(OPENCLAW_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
      'x-openclaw-agent-id': 'main',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenClaw responses failed (${res.status}): ${body.slice(0, 180)}`);
  }

  const data = await res.json();
  const text = extractResponseText(data);
  return text || `I heard: ${inputText}`;
}

function writeWavHeader(dataLen, sampleRate = DISCORD_SAMPLE_RATE, channels = DISCORD_CHANNELS, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);

  return header;
}

async function transcribePcmChunk(sttWorker, pcmChunks) {
  if (!pcmChunks.length) return '';

  const pcm = Buffer.concat(pcmChunks);
  if (!pcm.length) return '';

  const wavPath = path.join(os.tmpdir(), `zofia-vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const wav = Buffer.concat([writeWavHeader(pcm.length), pcm]);
  await fs.writeFile(wavPath, wav);

  try {
    const text = await sttWorker.transcribeWav(wavPath);
    return text.trim();
  } finally {
    try { await fs.unlink(wavPath); } catch {}
  }
}

function stopVoiceChat(guildId) {
  const state = voiceChatState.get(guildId);
  if (!state) return;

  for (const stream of state.activeStreams || []) {
    try { stream.destroy(); } catch {}
  }

  for (const stop of state.stopFns || []) {
    try { stop(); } catch {}
  }

  try { state.sttWorker?.stop(); } catch {}
  voiceChatState.delete(guildId);
}

async function startVoiceChat(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const connection = connectToMemberVoice(interaction);
  if (!connection) throw new Error('Join a voice channel first.');

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

  stopVoiceChat(guildId);

  const receiver = connection.receiver;
  const activeStreams = new Set();
  const sttWorker = new STTWorker();

  const state = {
    enabled: true,
    userId,
    sessionUser: `discord-voice:${guildId}:${userId}:${Date.now()}`,
    stopFns: [],
    activeStreams,
    sttWorker,
    queue: Promise.resolve(),
    lastTranscript: '',
    lastTranscriptAt: 0,
    lastReplyAt: 0,
    cooldownUntil: 0,
  };
  voiceChatState.set(guildId, state);

  const processUtterance = async (pcmChunks) => {
    const transcript = await transcribePcmChunk(sttWorker, pcmChunks);
    if (!transcript || transcript.length < MIN_TRANSCRIPT_CHARS) return;

    const norm = transcript.trim().toLowerCase();
    const now = Date.now();
    if (norm && norm === state.lastTranscript && (now - state.lastTranscriptAt) < 5000) {
      console.log('[voicechat] skipped duplicate transcript:', transcript);
      return;
    }
    state.lastTranscript = norm;
    state.lastTranscriptAt = now;

    console.log('[voicechat] transcript:', transcript);
    const reply = await askZofia(transcript, state.sessionUser);
    console.log('[voicechat] reply:', reply);
    await speak(reply);
    state.lastReplyAt = Date.now();
    state.cooldownUntil = state.lastReplyAt + VOICE_POST_TTS_COOLDOWN_MS;
  };

  const onSpeakingStart = (speakingUserId) => {
    const current = voiceChatState.get(guildId);
    if (!current || !current.enabled) return;
    if (speakingUserId !== userId) return;
    if (Date.now() < current.cooldownUntil) return;

    const opusStream = receiver.subscribe(speakingUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 650 },
    });

    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: DISCORD_CHANNELS, rate: DISCORD_SAMPLE_RATE });
    const pcmChunks = [];

    activeStreams.add(opusStream);
    activeStreams.add(decoder);

    decoder.on('data', (chunk) => pcmChunks.push(chunk));

    const cleanup = () => {
      activeStreams.delete(opusStream);
      activeStreams.delete(decoder);
      try { opusStream.destroy(); } catch {}
      try { decoder.destroy(); } catch {}
    };

    decoder.on('end', () => {
      cleanup();
      const stillEnabled = voiceChatState.get(guildId)?.enabled;
      if (!stillEnabled) return;

      state.queue = state.queue
        .then(() => processUtterance(pcmChunks))
        .catch((err) => console.error('voicechat utterance error:', err.message));
    });

    decoder.on('error', (err) => {
      console.error('Decoder error:', err.message);
      cleanup();
    });

    opusStream.on('error', (err) => {
      console.error('Opus stream error:', err.message);
      cleanup();
    });

    opusStream.pipe(decoder);
  };

  receiver.speaking.on('start', onSpeakingStart);

  const offSpeaking = () => {
    try { receiver.speaking.off('start', onSpeakingStart); } catch {}
  };

  state.stopFns.push(offSpeaking);
}

client.once('ready', async () => {
  try {
    const appId = clientId || client.application?.id;
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log('Registered guild slash commands: /join /say /leave /voicechat');
  } catch (err) {
    console.error('Command registration failed:', err.message);
  }
  console.log(`Voice bridge online as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'join') {
      await interaction.deferReply({ ephemeral: true });
      const connection = connectToMemberVoice(interaction);
      if (!connection) {
        await interaction.editReply('Join a voice channel first.');
        return;
      }
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      await interaction.editReply('Joined ✅');
      return;
    }

    if (interaction.commandName === 'leave') {
      await interaction.deferReply({ ephemeral: true });
      const gid = interaction.guildId;
      stopVoiceChat(gid);
      const connection = getVoiceConnection(gid);
      if (connection) connection.destroy();
      await interaction.editReply('Left voice channel 👋 (voicechat stopped)');
      return;
    }

    if (interaction.commandName === 'say') {
      await interaction.deferReply({ ephemeral: true });
      const text = interaction.options.getString('text', true).slice(0, 200);
      const connection = connectToMemberVoice(interaction);
      if (!connection) {
        await interaction.editReply('Join a voice channel first.');
        return;
      }

      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      await interaction.editReply(`Saying: "${text}"`);
      await speak(text);
      return;
    }

    if (interaction.commandName === 'voicechat') {
      const stateArg = interaction.options.getString('state', true);
      await interaction.deferReply({ ephemeral: true });

      if (stateArg === 'status') {
        const st = voiceChatState.get(interaction.guildId);
        if (!st) {
          await interaction.editReply('Voicechat status: OFF');
          return;
        }
        const since = st.lastTranscriptAt ? `${Math.max(0, Math.round((Date.now() - st.lastTranscriptAt) / 1000))}s ago` : 'never';
        const cooldown = Math.max(0, st.cooldownUntil - Date.now());
        await interaction.editReply(`Voicechat status: ON | queue active | last transcript: ${since} | cooldown: ${cooldown}ms`);
        return;
      }

      if (stateArg === 'off') {
        stopVoiceChat(interaction.guildId);
        await interaction.editReply('Voicechat off ✅');
        return;
      }

      await startVoiceChat(interaction);
      await interaction.editReply('Voicechat on ✅ (local STT active, listening to your voice)');
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `Error: ${err.message}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `Error: ${err.message}`, ephemeral: true });
    }
  }
});

await client.login(token);
