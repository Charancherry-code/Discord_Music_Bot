import { config } from './config.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { CommandHandler } from './commands.js';
import { log } from './logger.js';
import { NowPlayingCard } from './nowplaying.js';
import { Permissions } from './permissions.js';
import { MusicSession } from './player.js';
import { DEFAULT_PROFILE, encodeBitrate, getProfile, PROFILES } from './profiles.js';
import { Resolver } from './resolver.js';
import { loadDefaultPlaylist } from './sources.js';
import { JsonStore } from './store.js';
import { FORGET_AFTER_MS, VoiceManager } from './voice.js';
import { checkFfmpeg, raisePriority } from './audio.js';
import { Autoplay } from './autoplay.js';
import { ensureYtDlp } from './ytdlp-install.js';
import { updateYtDlp } from './ytdlp.js';

// Node tries IPv6 and IPv4 in parallel, giving each only 250 ms by default. On slow networks
// that makes connections fail ("fetch failed"); 1 s is still fast but much more reliable.
net.setDefaultAutoSelectFamilyAttemptTimeout(1000);

// Never let a stray error take the bot (and its voice connection) down.
process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => log.error('Uncaught exception:', err));

// View Channel, Send Messages, Embed Links, Read Message History, Connect, Speak
const INVITE_PERMISSIONS = '3230720';
const SESSION_SAVE_DELAY_MS = 2_000;
const SESSION_SAVE_INTERVAL_MS = 15_000;
const SESSION_MAX_AGE_MS = 6 * 60 * 60_000; // Don't auto-rejoin sessions older than this.

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Needed for the "c" prefix commands.
  ],
  // Keep RAM low by not caching things this bot never uses.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    ReactionManager: 0,
    PresenceManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    ThreadManager: 0,
  }),
});

const settings = new JsonStore(path.join(config.dataDir, 'settings.json'), { follow: true, soundProfile: DEFAULT_PROFILE });
const permissionsStore = new JsonStore(path.join(config.dataDir, 'permissions.json'), { users: [], roles: [] });
const sessionStore = new JsonStore(path.join(config.dataDir, 'session.json'), {});
const historyStore = new JsonStore(path.join(config.dataDir, 'history.json'), { played: {} });

const resolver = new Resolver(config.cacheFile);
const session = new MusicSession(resolver);
const voice = new VoiceManager(client, session, settings);
const card = new NowPlayingCard(client, session);
let commands = null;

const autoplay = new Autoplay(session, settings, historyStore);

// When the queue runs out: similar songs if autoplay is on, otherwise playlist.txt
// (only in your channel, re-read each time).
session.onQueueEnd = async () => {
  if (session.autoplay && session.loop === 'off') {
    const picks = await autoplay.next();
    if (picks.length) return picks;
  }
  const botChannel = voice.channelId;
  return botChannel && botChannel === voice.ownerChannelId() ? loadDefaultPlaylist() : [];
};

// Sound profile + encode bitrate for each track (bitrate follows the voice channel's setting).
session.getAudioOptions = () => {
  const name = PROFILES[settings.data.soundProfile] ? settings.data.soundProfile : DEFAULT_PROFILE;
  const channel = voice.channelId ? client.channels.cache.get(voice.channelId) : null;
  return { profile: name, filters: getProfile(name).filters, bitrate: encodeBitrate(channel?.bitrate) };
};

// ---------- resume after restart ----------

function buildSnapshot() {
  return { savedAt: Date.now(), channelId: voice.channelId, textChannelId: session.textChannelId, ...session.snapshot() };
}

let saveTimer = null;
function scheduleSessionSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    sessionStore.data = buildSnapshot();
    sessionStore.flush().catch((err) => log.warn(`Could not save session: ${err.message}`));
  }, SESSION_SAVE_DELAY_MS);
}
session.on('change', scheduleSessionSave);
setInterval(() => {
  if (session.nowPlaying) scheduleSessionSave();
}, SESSION_SAVE_INTERVAL_MS).unref();

async function restoreSession(guild) {
  const snap = sessionStore.data;
  if (!snap?.tracks?.length) return;
  // Same rule as leaving voice: a queue left behind for more than 3 minutes is dropped.
  if (!snap.channelId && Date.now() - (snap.savedAt ?? 0) > FORGET_AFTER_MS) {
    log.info('Saved queue is older than 3 minutes and nobody was listening; starting fresh.');
    return;
  }

  session.restore(snap);
  session.textChannelId = snap.textChannelId ?? null;
  log.info(`Restored queue: ${session.tracks.length} track(s).`);

  const fresh = Date.now() - (snap.savedAt ?? 0) < SESSION_MAX_AGE_MS;
  if (!snap.channelId || !fresh) return;
  if (settings.data.follow && voice.ownerInVoice()) {
    voice.resumeOnNextJoin(); // following you rejoins your channel and continues the song
    return;
  }

  const channel = guild.channels.cache.get(snap.channelId);
  if (!channel?.isVoiceBased() || voice.humansIn(channel.id) === 0) return;
  try {
    await voice.join(channel);
    session.start();
    log.info(`Resumed playback in "${channel.name}".`);
  } catch (err) {
    log.warn(`Could not resume the previous session: ${err.message}`);
  }
}

// ---------- Discord events ----------

async function enforceSingleGuild(guild) {
  if (guild.id === config.guildId) return;
  log.warn(`Leaving "${guild.name}" (${guild.id}): this bot only works in its home server.`);
  await guild.leave().catch((err) => log.warn(`Could not leave ${guild.id}: ${err.message}`));
}

client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag}. Prefix: "${config.prefix}" (try ${config.prefix}help)`);

  for (const guild of c.guilds.cache.values()) await enforceSingleGuild(guild);

  const home = c.guilds.cache.get(config.guildId);
  if (!home) {
    log.warn(
      `The bot is not in server ${config.guildId}. Invite it with:\n` +
        `https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot&permissions=${INVITE_PERMISSIONS}&guild_id=${config.guildId}`,
    );
    return;
  }

  // Remove slash commands registered by the first version of this bot.
  await home.commands.set([]).catch(() => {});

  voice.attach();
  await restoreSession(home);
  await voice.syncOwner();
});

client.on(Events.GuildCreate, async (guild) => {
  await enforceSingleGuild(guild);
  if (guild.id === config.guildId) {
    voice.attach();
    await voice.syncOwner();
  }
});

client.on(Events.MessageCreate, (message) => commands?.handleMessage(message));
client.on(Events.InteractionCreate, (interaction) => commands?.handleInteraction(interaction));
client.on(Events.Error, (err) => log.error('Discord client error:', err));
client.on(Events.Warn, (msg) => log.warn('Discord client warning:', msg));
client.on(Events.ShardDisconnect, () => log.warn('Gateway disconnected; discord.js will reconnect.'));
client.on(Events.ShardResume, () => log.info('Gateway connection resumed.'));

// ---------- shutdown ----------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received; saving and disconnecting.`);
  try {
    clearTimeout(saveTimer);
    sessionStore.data = buildSnapshot(); // Saved before leaving so a restart resumes here.
    await Promise.allSettled([sessionStore.flush(), resolver.flush(), settings.flush(), permissionsStore.flush(), historyStore.flush()]);
    voice.leave();
    await client.destroy();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- startup ----------

/** Stops a second copy of the bot from starting (two copies fight over the voice connection). */
function acquireSingleInstanceLock() {
  const lockFile = path.join(config.dataDir, 'bot.lock');
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (pid && pid !== process.pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        alive = err.code === 'EPERM';
      }
      if (alive) {
        log.error(`Another copy of the bot is already running (process ${pid}). Close it first, then start again.`);
        process.exit(1);
      }
    }
  } catch {
    // No lock file yet.
  }
  fs.writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8')) === process.pid) fs.rmSync(lockFile);
    } catch {
      // Already gone.
    }
  });
}

async function main() {
  acquireSingleInstanceLock();
  raisePriority(); // audio timing is sensitive; keep it ahead of games and browsers
  log.debug(`\n${generateDependencyReport()}`);

  try {
    await ensureYtDlp(config.ytDlpPath, log);
    if (config.ytDlpAutoUpdate) await updateYtDlp();
  } catch (err) {
    log.error(`yt-dlp is unavailable (${err.message}). The bot can join voice but can't stream until this is fixed.`);
  }

  await Promise.all([resolver.load(), settings.load(), permissionsStore.load(), sessionStore.load(), historyStore.load()]);

  // Test ffmpeg with the real filter chains so a broken binary or filter can't silence every song.
  const ff = await checkFfmpeg(getProfile('bass').filters);
  if (ff.ok) {
    log.info(`ffmpeg OK. Sound profile: ${getProfile(settings.data.soundProfile).label}.`);
  } else {
    log.error(
      `ffmpeg doesn't work here (${ff.reason}). Playing untouched audio only (no sound profiles or resume mid-song). ` +
        'Fix: run "npm rebuild ffmpeg-static", or install ffmpeg and set FFMPEG_PATH in .env.',
    );
  }
  session.autoplay = settings.data.autoplay !== false; // on unless you turned it off
  commands = new CommandHandler({ session, voice, perms: new Permissions(permissionsStore), settings, card, autoplay });

  // Network problems are retried forever (with backoff); a bad token or intent stops the bot.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(config.token);
      return;
    } catch (err) {
      if (/disallowed intents/i.test(err.message)) {
        log.error('Login failed: turn on "Message Content Intent" in the Developer Portal (Bot page), then restart.');
        process.exit(1);
      }
      if (/token/i.test(err.message) || err.code === 'TokenInvalid') {
        log.error(`Login failed: ${err.message}. Check DISCORD_TOKEN.`);
        process.exit(1);
      }
      const waitSec = Math.min(60, 5 * attempt);
      log.warn(`Can't reach Discord (${err.message}). Retrying in ${waitSec}s (attempt ${attempt}).`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }
}

main();
