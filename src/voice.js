// Voice connection rules: follow the owner, join for approved users when the owner isn't in voice,
// auto-pause in empty channels, and leave when idle.
import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { log } from './logger.js';
import { UserError } from './sources.js';

const OWNER_SYNC_DELAY_MS = 500; // Debounce for quick channel hopping.
const READY_TIMEOUT_MS = 20_000;
const RECONNECT_GRACE_MS = 5_000;
const EMPTY_LEAVE_MS = 5 * 60_000;
const IDLE_LEAVE_MS = 5 * 60_000;
const MAX_JOINS_PER_WINDOW = 6;
const JOIN_WINDOW_MS = 60_000;

const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

export class VoiceManager {
  #ownerTimer = null;
  #occupancyTimer = null;
  #emptyTimer = null;
  #idleTimer = null;
  #lastOwnerChannel = null;
  #joinTimes = [];
  #wired = new WeakSet();
  #syncing = false;
  #resumeOnRejoin = false;
  #pendingSync = false;

  constructor(client, session, settings) {
    this.client = client;
    this.session = session;
    this.settings = settings;

    session.on('idle', () => this.#startIdleTimer());
    session.on('trackStart', () => this.#clearIdleTimer());
  }

  get guild() {
    return this.client.guilds.cache.get(config.guildId) ?? null;
  }

  get connection() {
    const conn = getVoiceConnection(config.guildId);
    return conn && conn.state.status !== VoiceConnectionStatus.Destroyed ? conn : null;
  }

  /** The channel the bot is in (or connecting to), or null. */
  get channelId() {
    const conn = this.connection;
    if (!conn || conn.state.status === VoiceConnectionStatus.Disconnected) return null;
    return conn.joinConfig.channelId ?? null;
  }

  ownerChannelId() {
    return this.guild?.voiceStates.cache.get(config.ownerId)?.channelId ?? null;
  }

  ownerInVoice() {
    return Boolean(this.ownerChannelId());
  }

  humansIn(channelId) {
    if (!channelId || !this.guild) return 0;
    let count = 0;
    for (const state of this.guild.voiceStates.cache.values()) {
      if (state.channelId !== channelId || state.id === this.client.user.id) continue;
      const user = state.member?.user ?? this.client.users.cache.get(state.id);
      if (!user?.bot) count++;
    }
    return count;
  }

  #attached = false;

  attach() {
    this.#lastOwnerChannel = this.ownerChannelId();
    if (this.#attached) return;
    this.#attached = true;
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (newState.guild.id !== config.guildId) return;
      const moved = oldState.channelId !== newState.channelId;
      if (moved && (newState.id === config.ownerId || newState.id === this.client.user.id)) {
        this.scheduleOwnerSync();
      }
      const botChannel = this.channelId;
      if (moved && botChannel && (oldState.channelId === botChannel || newState.channelId === botChannel)) {
        this.#scheduleOccupancyCheck();
      }
    });
  }

  scheduleOwnerSync(delay = OWNER_SYNC_DELAY_MS) {
    clearTimeout(this.#ownerTimer);
    this.#ownerTimer = setTimeout(() => this.syncOwner(), delay);
  }

  /** Applies the owner rules to the current state. Never throws. */
  async syncOwner() {
    if (this.#syncing) {
      this.#pendingSync = true;
      return;
    }
    this.#syncing = true;
    try {
      await this.#syncOwner();
    } catch (err) {
      log.warn(`Following you failed: ${err.message}`);
    } finally {
      this.#syncing = false;
      if (this.#pendingSync) {
        this.#pendingSync = false;
        this.scheduleOwnerSync();
      }
    }
  }

  async #syncOwner() {
    const ownerChannel = this.ownerChannelId();
    const previous = this.#lastOwnerChannel;
    this.#lastOwnerChannel = ownerChannel;
    const botChannel = this.channelId;

    if (!ownerChannel) {
      // You left voice: leave too if the bot was with you.
      if (botChannel && botChannel === previous) {
        log.info('Owner left voice; leaving.');
        this.leave();
      }
      return;
    }

    if (!this.settings.data.follow) return;
    if (botChannel === ownerChannel) return;

    const channel = this.guild.channels.cache.get(ownerChannel);
    if (!channel?.isVoiceBased()) return;

    // Following you never starts music by itself. Music only keeps going if it was
    // already playing (you switched channels, or the connection dropped mid-song).
    const keepPlaying = this.session.active || this.#resumeOnRejoin;
    this.#resumeOnRejoin = false;
    await this.join(channel);
    if (keepPlaying) {
      this.session.start();
    } else if (!this.session.textChannelId) {
      this.session.textChannelId = channel.id; // so a later cplay card has somewhere to go
    }
    this.#scheduleOccupancyCheck();
  }

  /**
   * Makes sure the bot is in `member`'s voice channel for cplay. Throws UserError with a
   * message to show if that isn't possible.
   */
  async ensureFor(member) {
    const target = member.voice?.channel;
    if (!target) throw new UserError('Join a voice channel first.');

    const botChannel = this.channelId;
    if (botChannel === target.id) return target;

    const isOwner = member.id === config.ownerId;
    if (botChannel && !isOwner && this.humansIn(botChannel) > 0) {
      throw new UserError(`I'm already playing in <#${botChannel}>. Join that channel to control me.`);
    }
    await this.join(target);
    return target;
  }

  /** For skip/pause/etc.: approved users must be in the bot's channel. The owner can control from anywhere. */
  checkSameChannel(member) {
    if (member.id === config.ownerId) return null;
    const botChannel = this.channelId;
    if (!botChannel) return "I'm not in a voice channel right now.";
    if (member.voice?.channelId !== botChannel) return `Join <#${botChannel}> to control me.`;
    return null;
  }

  async join(channel) {
    const problem = this.#joinProblem(channel);
    if (problem) throw new UserError(problem);
    if (!this.#takeJoinSlot()) throw new UserError('Too many voice joins in the last minute. Try again shortly.');

    const moving = Boolean(this.connection);
    log.info(`${moving ? 'Moving to' : 'Joining'} "${channel.name}".`);

    // If a connection already exists, this moves it instead of opening a new one.
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.#wire(connection);
    connection.subscribe(this.session.audio);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch {
      this.leave();
      throw new UserError("Couldn't connect to voice in time. Try again.");
    }

    if (channel.type === ChannelType.GuildStageVoice) await this.#speakOnStage(channel.guild);
    // Cleared as soon as a track starts; leaves if nothing ever plays (e.g. a failed cplay).
    this.#startIdleTimer();
    this.#scheduleOccupancyCheck();
  }

  /** Leaves voice, keeping the queue so it can continue later. */
  leave() {
    clearTimeout(this.#emptyTimer);
    this.#clearIdleTimer();
    this.session.halt();
    const conn = this.connection;
    if (conn) conn.destroy();
  }

  #joinProblem(channel) {
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(NEEDED)) return `I need View Channel, Connect and Speak permissions in <#${channel.id}>.`;
    if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) return `<#${channel.id}> is full.`;
    return null;
  }

  #takeJoinSlot() {
    const now = Date.now();
    this.#joinTimes = this.#joinTimes.filter((t) => now - t < JOIN_WINDOW_MS);
    if (this.#joinTimes.length >= MAX_JOINS_PER_WINDOW) return false;
    this.#joinTimes.push(now);
    return true;
  }

  #wire(connection) {
    if (this.#wired.has(connection)) return;
    this.#wired.add(connection);

    connection.on('error', (err) => log.warn('Voice connection error:', err.message));
    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) log.debug(`Voice: ${oldState.status} -> ${newState.status}`);
    });

    // Standard recovery: a disconnect is often a channel move or a short network blip.
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
          entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
        ]);
      } catch {
        log.warn('Voice connection lost.');
        this.#resumeOnRejoin = this.session.active; // a network blip shouldn't stop the music
        this.leave();
        if (this.settings.data.follow && this.ownerInVoice()) this.scheduleOwnerSync(2_000);
      }
    });
  }

  #scheduleOccupancyCheck() {
    clearTimeout(this.#occupancyTimer);
    this.#occupancyTimer = setTimeout(() => this.#checkOccupancy(), 1_000);
  }

  #checkOccupancy() {
    const botChannel = this.channelId;
    if (!botChannel) return;
    if (this.humansIn(botChannel) === 0) {
      this.session.autoPause();
      if (!this.#emptyTimer) {
        this.#emptyTimer = setTimeout(() => {
          this.#emptyTimer = null;
          if (this.channelId && this.humansIn(this.channelId) === 0) {
            log.info('Channel empty for 5 minutes; leaving.');
            this.leave();
          }
        }, EMPTY_LEAVE_MS);
      }
    } else {
      clearTimeout(this.#emptyTimer);
      this.#emptyTimer = null;
      this.session.autoResume();
    }
  }

  #startIdleTimer() {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      const botChannel = this.channelId;
      // Stay with the owner; only leave other people's channels when nothing is playing.
      if (botChannel && botChannel !== this.ownerChannelId() && this.session.isIdle) {
        log.info('Nothing played for 5 minutes; leaving.');
        this.leave();
      }
    }, IDLE_LEAVE_MS);
  }

  #clearIdleTimer() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async #speakOnStage(guild) {
    const voice = guild.members.me?.voice;
    try {
      await voice?.setSuppressed(false);
    } catch {
      try {
        await voice?.setRequestToSpeak(true);
        log.warn('Stage channel: requested to speak. Accept the request so the music is audible.');
      } catch (err) {
        log.warn(`Stage channel: could not become a speaker (${err.message}).`);
      }
    }
  }
}
