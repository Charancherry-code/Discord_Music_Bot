// Prefix commands (cplay, cskip, ...) and Now Playing button handling.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { ffmpegAvailable } from './audio.js';
import { cleanTitle, formatDuration, formatListening, timeAgo, trackLabel } from './format.js';
import { toTracks } from './library.js';
import { PERIODS } from './stats.js';
import { log } from './logger.js';
import { COLORS } from './nowplaying.js';
import { LOOP_MODES } from './player.js';
import { clampVolume, MAX_VOLUME, PROFILES } from './profiles.js';
import { VIBES } from './autoplay.js';
import { makeTrack, resolveInput, shuffleInPlace, UserError } from './sources.js';
import { searchTracks } from './ytdlp.js';

const MSG_NO_PERMISSION = "🔒 You don't have permission to use this bot.";
const MSG_BUSY = '🎧 Busy with the owner. Try again when they leave voice.';
const QUEUE_PAGE_SIZE = 10;
const LIST_PAGE_SIZE = 15;
const MAX_SLEEP_MIN = 12 * 60;
const PERIOD_LABELS = { today: 'today', week: 'the last 7 days', month: 'the last 30 days', year: 'the last 365 days', all: 'all time' };
const MAX_LINKS_PER_MESSAGE = 10;
// Music links that link mode reacts to.
const MUSIC_LINK_RE =
  /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch|shorts|playlist|live)|youtu\.be\/|(?:www\.|m\.)?soundcloud\.com\/|on\.soundcloud\.com\/|open\.spotify\.com\/|spotify\.link\/|spotify\.app\.link\/)\S*$/i;

const embed = (text, color = COLORS.idle) => new EmbedBuilder().setColor(color).setDescription(text);

function parsePositive(text) {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** "30" / "30m" / "1h" / "1h30m" / "1.5h" -> minutes, or null. */
function parseMinutes(text) {
  const t = text.toLowerCase().replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+(?:\.\d+)?)h(?:ours?|rs?)?)?(?:(\d+)m(?:in(?:ute)?s?)?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** Splits trailing "shuffle" off a name: "gym mix shuffle" -> { name: "gym mix", shuffle: true }. */
function nameAndShuffle(text) {
  const m = text.match(/^(.*?)\s+(shuffle|sh)$/i);
  return m ? { name: m[1].trim(), shuffle: true } : { name: text.trim(), shuffle: false };
}

export class CommandHandler {
  #lookup = new Map();

  #reopenTimer = null;
  #sleepTimer = null;

  constructor({ session, voice, perms, settings, card, autoplay, library, stats }) {
    this.autoplay = autoplay;
    this.library = library;
    this.stats = stats;
    this.session = session;
    this.voice = voice;
    this.perms = perms;
    this.settings = settings;
    this.card = card;

    for (const command of this.#definitions()) {
      this.#lookup.set(command.name, { command, isAlias: false });
      for (const alias of command.aliases ?? []) this.#lookup.set(alias, { command, isAlias: true });
    }
  }

  // ---------- access rules ----------

  /**
   * Returns a denial message, or null if `member` may use the bot right now.
   * `anytime` commands don't control playback (likes, stats, lists), so approved users
   * can use them even while the owner is in voice.
   */
  #deny(member, { ownerOnly = false, anytime = false } = {}) {
    const isOwner = member?.id === config.ownerId;
    if (ownerOnly && !isOwner) return '🔒 Only the bot owner can use this command.';
    if (isOwner) return null;
    if (!this.perms.isApproved(member)) return MSG_NO_PERMISSION;
    if (!anytime && this.voice.ownerInVoice()) return MSG_BUSY;
    return null;
  }

  // ---------- message commands ----------

  async handleMessage(message) {
    if (message.author.bot || !message.inGuild() || message.guildId !== config.guildId) return;

    const content = message.content.trim();
    const prefix = config.prefix;

    // Link mode: in a channel with clink on, a message that is only music links plays them.
    if (this.#linkChannels().includes(message.channelId)) {
      const links = content.split(/\s+/).map((w) => w.replace(/^<|>$/g, ''));
      if (links.length && links.length <= MAX_LINKS_PER_MESSAGE && links.every((l) => MUSIC_LINK_RE.test(l))) {
        return this.#playLinks(message, links);
      }
    }

    if (content.length <= prefix.length || !content.toLowerCase().startsWith(prefix)) return;

    const rawName = content.slice(prefix.length).split(/\s+/, 1)[0];
    const entry = this.#lookup.get(rawName.toLowerCase());
    if (!entry) return;
    const { command, isAlias } = entry;

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    const reply = (text, color) =>
      message
        .reply({ embeds: [typeof text === 'string' ? embed(text, color) : text], allowedMentions: { repliedUser: false } })
        .catch((err) => log.debug(`Reply failed: ${err.message}`));

    const denied = this.#deny(member, command);
    if (denied) {
      // Short aliases like "cs" collide with normal chat, so only full command names get a reply.
      if (isAlias) return;
      return reply(denied, COLORS.error);
    }

    const argText = content.slice(prefix.length + rawName.length).trim();
    const ctx = { message, member, argText, args: argText ? argText.split(/\s+/) : [], reply };

    try {
      if (command.sameChannel) {
        const problem = this.voice.checkSameChannel(member);
        if (problem) return reply(problem, COLORS.error);
      }
      await command.run(ctx);
    } catch (err) {
      if (err instanceof UserError) return reply(err.message, COLORS.error);
      log.error(`${prefix}${command.name} failed:`, err);
      return reply('Something went wrong. Check the bot logs.', COLORS.error);
    }
  }

  // ---------- Now Playing buttons ----------

  async handleInteraction(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith('np:')) return;
    if (interaction.guildId !== config.guildId) return;

    const action = interaction.customId.slice(3);
    log.info(`Button "${action}" pressed by ${interaction.user.username}.`);

    // Before the button is acknowledged: answer with a private message.
    const ephemeral = (text, color = COLORS.error) =>
      interaction
        .reply({ embeds: [embed(text, color)], flags: MessageFlags.Ephemeral })
        .catch((err) => log.warn(`Button reply failed: ${err.message}`));

    const member = interaction.member ?? (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null));
    const denied = this.#deny(member, { anytime: action === 'queue' || action === 'like' });
    if (denied) return ephemeral(denied);

    if (action === 'queue') {
      return interaction
        .reply({ embeds: [this.#queueEmbed(0)], flags: MessageFlags.Ephemeral })
        .catch((err) => log.warn(`Button reply failed: ${err.message}`));
    }
    if (action === 'like') {
      const track = this.session.nowPlaying;
      if (!track) return ephemeral('Nothing is playing.');
      return ephemeral(this.#toggleLike(member.id, track), COLORS.playing);
    }

    const problem = this.voice.checkSameChannel(member);
    if (problem) return ephemeral(problem);

    // Acknowledge in parallel and act right away: on a slow network the acknowledgement can miss
    // Discord's 3-second window, but the skip/pause itself should still happen.
    const ack = interaction.deferUpdate().then(
      () => true,
      (err) => {
        log.warn(`Button "${action}" could not be acknowledged: ${err.message}`);
        return false;
      },
    );
    const notice = async (text) => {
      if (await ack) interaction.followUp({ embeds: [embed(text, COLORS.error)], flags: MessageFlags.Ephemeral }).catch(() => {});
    };

    const s = this.session;
    try {
      switch (action) {
        case 'prev':
          if (!s.previous()) return notice('No previous song.');
          break;
        case 'pause':
          if (s.isPaused) s.resume();
          else if (!s.pause()) return notice('Nothing is playing.');
          break;
        case 'skip':
          if (!s.skip()) return notice('Nothing to skip.');
          break;
        case 'stop':
          s.stop();
          break;
        case 'loop':
          s.setLoop(LOOP_MODES[(LOOP_MODES.indexOf(s.loop) + 1) % LOOP_MODES.length]);
          break;
        case 'shuffle':
          s.shuffle();
          break;
        case 'autoplay':
          this.autoplay.setEnabled(!s.autoplay);
          break;
        default:
          return;
      }
      await ack;
      await this.card.refreshNow();
    } catch (err) {
      log.error(`Button ${action} failed:`, err);
      return notice('Something went wrong. Check the bot logs.');
    }
  }

  // ---------- helpers ----------

  #queueEmbed(page) {
    const s = this.session;
    const upcoming = s.upcoming;
    const pages = Math.max(1, Math.ceil(upcoming.length / QUEUE_PAGE_SIZE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const now = s.nowPlaying;

    const lines = upcoming
      .slice(p * QUEUE_PAGE_SIZE, (p + 1) * QUEUE_PAGE_SIZE)
      .map((t, i) => `\`${p * QUEUE_PAGE_SIZE + i + 1}.\` ${trackLabel(t, 60)} \`${formatDuration(t.duration)}\`${t.autoplay ? ' 🎲' : ''}`);

    const total = upcoming.reduce((sum, t) => sum + (t.duration ?? 0), 0);
    return new EmbedBuilder()
      .setColor(COLORS.idle)
      .setTitle('📜 Queue')
      .setDescription(
        `**Now:** ${now ? trackLabel(now, 70) : 'nothing'}\n\n${lines.length ? lines.join('\n') : '*Up next is empty.*'}`.slice(0, 4000),
      )
      .setFooter({
        text: `Page ${p + 1}/${pages} · ${upcoming.length} song(s) · ${formatDuration(total)} · Loop: ${s.loop}`,
      });
  }

  /**
   * Applies new volume/profile settings to the playing song. Debounced, so `cvolume +10` typed
   * five times quickly causes one re-open, not five. Returns false if nothing is playing.
   */
  #reopenSoon() {
    const track = this.session.nowPlaying;
    if (!track || track.live) return false;
    clearTimeout(this.#reopenTimer);
    this.#reopenTimer = setTimeout(() => this.session.reopen(), 700);
    return true;
  }

  #toggleLike(userId, track) {
    const liked = this.library.toggleLike(userId, track);
    return liked
      ? `❤️ Added ${trackLabel(track, 60)} to your liked songs. \`${config.prefix}liked\` to see them.`
      : `💔 Removed ${trackLabel(track, 60)} from your liked songs.`;
  }

  #period(arg, fallback) {
    if (!arg) return fallback;
    const period = arg.toLowerCase();
    if (!Object.hasOwn(PERIODS, period)) throw new UserError(`Pick a period: ${Object.keys(PERIODS).join(', ')}.`);
    return period;
  }

  /** One page of a long list (`page` starts at 1). */
  #pageEmbed(title, lines, page, footer) {
    const pages = Math.max(1, Math.ceil(lines.length / LIST_PAGE_SIZE));
    const p = Math.min(Math.max(1, page ?? 1), pages) - 1;
    const body = lines.slice(p * LIST_PAGE_SIZE, (p + 1) * LIST_PAGE_SIZE).join('\n');
    const result = new EmbedBuilder().setColor(COLORS.idle).setTitle(title).setDescription(body.slice(0, 4000) || '*Empty.*');
    const footerText = [pages > 1 ? `Page ${p + 1}/${pages}` : null, footer].filter(Boolean).join(' · ');
    if (footerText) result.setFooter({ text: footerText });
    return result;
  }

  /** Joins the member's channel and queues saved songs (playlist or liked songs). */
  async #playSaved(ctx, stored, shuffle) {
    const denied = this.#deny(ctx.member);
    if (denied) throw new UserError(denied);
    await this.voice.ensureFor(ctx.member);
    this.session.textChannelId = ctx.message.channelId;
    const tracks = toTracks(stored, ctx.member.user);
    if (shuffle) shuffleInPlace(tracks);
    return this.#enqueue(ctx, tracks);
  }

  /** Starts (ms > 0) or cancels (ms = 0) the sleep timer. When it ends: stop, clear the queue, leave voice. */
  #setSleep(ms, channel) {
    clearTimeout(this.#sleepTimer);
    this.#sleepTimer = null;
    this.session.sleepAt = ms ? Date.now() + ms : null;
    this.session.emit('change');
    if (!ms) return;
    this.#sleepTimer = setTimeout(() => {
      this.#sleepTimer = null;
      this.session.sleepAt = null;
      const wasPlaying = Boolean(this.session.nowPlaying || this.session.hasPending);
      this.session.stop();
      this.voice.leave();
      log.info('Sleep timer ended: stopped and left voice.');
      if (wasPlaying) channel?.send({ embeds: [embed('😴 Sleep timer ended. Stopped the music and left voice. Good night!')] }).catch(() => {});
    }, ms);
  }

  #linkChannels() {
    return (this.settings.data.linkChannels ??= []);
  }

  /** Link mode: plays (or queues) pasted links, with the same access rules as cplay. */
  async #playLinks(message, links) {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;
    const reply = (text, color) =>
      message
        .reply({ embeds: [embed(text, color)], allowedMentions: { repliedUser: false } })
        .catch((err) => log.debug(`Reply failed: ${err.message}`));

    // People without access are ignored silently, so normal link sharing doesn't get spammed.
    const denied = this.#deny(member);
    if (denied === MSG_NO_PERMISSION) return;
    if (denied) return reply(denied, COLORS.error);

    const ctx = { message, member, reply };
    try {
      await this.voice.ensureFor(member);
      this.session.textChannelId = message.channelId;
      message.channel.sendTyping().catch(() => {});
      const tracks = [];
      for (const link of links) tracks.push(...(await resolveInput(link, member.user)));
      return await this.#enqueue(ctx, tracks);
    } catch (err) {
      if (err instanceof UserError) return reply(err.message, COLORS.error);
      log.error('Link mode failed:', err);
      return reply('Something went wrong. Check the bot logs.', COLORS.error);
    }
  }

  async #enqueue(ctx, tracks) {
    const { added, position } = this.session.add(tracks);
    this.session.start();
    if (!added) return ctx.reply('The queue is full (1000 songs).', COLORS.error);
    if (tracks.length === 1) {
      const t = tracks[0];
      const where = position === 0 ? '▶️ Playing' : '➕ Added';
      const suffix = position > 0 ? ` · #${position} in queue` : '';
      return ctx.reply(`${where} ${trackLabel(t)} \`${formatDuration(t.duration)}\`${suffix}`, COLORS.playing);
    }
    return ctx.reply(`➕ Added **${added}** songs to the queue.`, COLORS.playing);
  }

  // ---------- command definitions ----------

  #definitions() {
    const s = this.session;
    const v = this.voice;

    return [
      {
        name: 'play',
        aliases: ['p'],
        usage: 'play <song name or link>',
        description: 'Play a song or add it to the queue. With nothing after it, resumes the queue.',
        run: async (ctx) => {
          if (!ctx.argText && !s.hasPending && s.isIdle) {
            throw new UserError(`Nothing queued. Try \`${config.prefix}play <song>\` or \`${config.prefix}vibe\`.`);
          }
          await v.ensureFor(ctx.member);
          s.textChannelId = ctx.message.channelId;
          if (!ctx.argText) {
            s.start();
            return ctx.reply('▶️ Playing.', COLORS.playing);
          }
          ctx.message.channel.sendTyping().catch(() => {});
          const tracks = await resolveInput(ctx.argText, ctx.member.user);
          return this.#enqueue(ctx, tracks);
        },
      },
      {
        name: 'search',
        aliases: ['find'],
        usage: 'search <song name>',
        description: 'Show the top 5 results and pick one.',
        run: async (ctx) => {
          if (!ctx.argText) throw new UserError('Usage: `csearch <song name>`');
          ctx.message.channel.sendTyping().catch(() => {});
          let results;
          try {
            results = await searchTracks(ctx.argText, 5);
          } catch (err) {
            throw new UserError(`Search failed. (${err.message.slice(0, 150)})`);
          }
          if (!results.length) throw new UserError('No results.');

          const list = results.map((r, i) => `\`${i + 1}.\` ${cleanTitle(r.title, 70)} \`${formatDuration(r.duration)}\``);
          const row = new ActionRowBuilder().addComponents(
            ...results.map((_, i) =>
              new ButtonBuilder().setCustomId(`search:${i}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Primary),
            ),
          );
          const cancelRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('search:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          );
          const msg = await ctx.message.reply({
            embeds: [embed(`🔎 **Pick a song** (60s)\n\n${list.join('\n')}`)],
            components: [row, cancelRow],
            allowedMentions: { repliedUser: false },
          });

          const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 });
          collector.on('collect', async (i) => {
            if (i.user.id !== ctx.member.id) {
              return i.reply({ content: "This search isn't yours.", flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            collector.stop('picked');
            if (i.customId === 'search:cancel') {
              return i.update({ embeds: [embed('Search cancelled.')], components: [] }).catch(() => {});
            }
            const pick = results[Number(i.customId.split(':')[1])];
            const denied = this.#deny(ctx.member);
            if (denied) return i.update({ embeds: [embed(denied, COLORS.error)], components: [] }).catch(() => {});
            try {
              await v.ensureFor(ctx.member);
            } catch (err) {
              const text = err instanceof UserError ? err.message : 'Could not join your voice channel.';
              return i.update({ embeds: [embed(text, COLORS.error)], components: [] }).catch(() => {});
            }
            s.textChannelId = msg.channelId;
            const track = makeTrack(pick, ctx.member.user);
            const { position } = s.add([track]);
            s.start();
            const text = position === 0 ? `▶️ Playing ${trackLabel(track)}` : `➕ Added ${trackLabel(track)} · #${position} in queue`;
            return i.update({ embeds: [embed(text, COLORS.playing)], components: [] }).catch(() => {});
          });
          collector.on('end', (_, reason) => {
            if (reason === 'time') msg.edit({ embeds: [embed('Search timed out.')], components: [] }).catch(() => {});
          });
        },
      },
      {
        name: 'skip',
        aliases: ['s', 'next'],
        usage: 'skip',
        description: 'Skip to the next song.',
        sameChannel: true,
        run: (ctx) => {
          const current = s.nowPlaying;
          if (!s.skip()) throw new UserError('Nothing to skip.');
          return ctx.reply(`⏭ Skipped ${current ? trackLabel(current) : 'the song'}.`);
        },
      },
      {
        name: 'skipto',
        aliases: ['st', 'jump'],
        usage: 'skipto <number>',
        description: 'Jump to a song in the queue.',
        sameChannel: true,
        run: (ctx) => {
          const n = parsePositive(ctx.args[0]);
          const target = n ? s.upcoming[n - 1] : null;
          if (!target || !s.skipTo(n)) throw new UserError(`Pick a number from 1 to ${s.upcoming.length}. See \`cqueue\`.`);
          return ctx.reply(`⏭ Jumping to ${trackLabel(target)}.`);
        },
      },
      {
        name: 'previous',
        aliases: ['prev', 'back'],
        usage: 'previous',
        description: 'Play the previous song again.',
        sameChannel: true,
        run: (ctx) => {
          if (!s.previous()) throw new UserError('No previous song.');
          return ctx.reply('⏮ Going back.');
        },
      },
      {
        name: 'pause',
        usage: 'pause',
        description: 'Pause playback.',
        sameChannel: true,
        run: (ctx) => {
          if (!s.pause()) throw new UserError('Nothing is playing.');
          return ctx.reply('⏸ Paused.', COLORS.paused);
        },
      },
      {
        name: 'resume',
        aliases: ['unpause'],
        usage: 'resume',
        description: 'Resume playback.',
        sameChannel: true,
        run: (ctx) => {
          if (!s.resume()) throw new UserError('Not paused.');
          return ctx.reply('▶️ Resumed.', COLORS.playing);
        },
      },
      {
        name: 'stop',
        usage: 'stop',
        description: 'Stop and clear the queue.',
        sameChannel: true,
        run: (ctx) => {
          s.stop();
          return ctx.reply('⏹ Stopped and cleared the queue.');
        },
      },
      {
        name: 'nowplaying',
        aliases: ['np'],
        usage: 'np',
        description: 'Show the Now Playing card here.',
        run: async (ctx) => {
          if (!s.nowPlaying) throw new UserError('Nothing is playing.');
          await this.card.repost(ctx.message.channelId);
        },
      },
      {
        name: 'queue',
        aliases: ['q'],
        usage: 'queue',
        description: 'Show the queue.',
        run: async (ctx) => {
          let page = Math.max(0, (parsePositive(ctx.args[0]) ?? 1) - 1);
          const pages = () => Math.max(1, Math.ceil(s.upcoming.length / QUEUE_PAGE_SIZE));
          const buttons = () =>
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('queue:prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId('queue:next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages() - 1),
            );
          const msg = await ctx.message.reply({
            embeds: [this.#queueEmbed(page)],
            components: pages() > 1 ? [buttons()] : [],
            allowedMentions: { repliedUser: false },
          });
          if (pages() <= 1) return;

          const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 });
          collector.on('collect', (i) => {
            if (i.user.id !== ctx.member.id) {
              return i.reply({ content: 'Run `cqueue` yourself to browse.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            page = Math.min(Math.max(0, page + (i.customId === 'queue:next' ? 1 : -1)), pages() - 1);
            return i.update({ embeds: [this.#queueEmbed(page)], components: [buttons()] }).catch(() => {});
          });
          collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
        },
      },
      {
        name: 'remove',
        aliases: ['rm'],
        usage: 'remove <number>',
        description: 'Remove a song from the queue.',
        sameChannel: true,
        run: (ctx) => {
          const removed = s.remove(parsePositive(ctx.args[0]));
          if (!removed) throw new UserError(`Pick a number from 1 to ${s.upcoming.length}. See \`cqueue\`.`);
          return ctx.reply(`🗑 Removed ${trackLabel(removed)}.`);
        },
      },
      {
        name: 'move',
        aliases: ['mv'],
        usage: 'move <from> <to>',
        description: 'Move a song to another spot in the queue.',
        sameChannel: true,
        run: (ctx) => {
          const moved = s.move(parsePositive(ctx.args[0]), parsePositive(ctx.args[1]));
          if (!moved) throw new UserError(`Usage: \`cmove <from> <to>\` with numbers from 1 to ${s.upcoming.length}.`);
          return ctx.reply(`↕️ Moved ${trackLabel(moved)} to #${ctx.args[1]}.`);
        },
      },
      {
        name: 'clear',
        usage: 'clear',
        description: 'Clear Up Next (keeps the current song).',
        sameChannel: true,
        run: (ctx) => ctx.reply(`🧹 Cleared ${s.clearUpcoming()} song(s).`),
      },
      {
        name: 'shuffle',
        aliases: ['sh'],
        usage: 'shuffle',
        description: 'Shuffle Up Next.',
        sameChannel: true,
        run: (ctx) => {
          const count = s.shuffle();
          if (count < 2) throw new UserError('Need at least 2 songs in Up Next to shuffle.');
          return ctx.reply(`🔀 Shuffled ${count} songs.`);
        },
      },
      {
        name: 'loop',
        aliases: ['repeat'],
        usage: 'loop [off | song | queue]',
        description: 'Set loop mode. With nothing after it, cycles off → song → queue.',
        sameChannel: true,
        run: (ctx) => {
          const wanted = ctx.args[0]?.toLowerCase();
          if (wanted && !LOOP_MODES.includes(wanted)) throw new UserError('Usage: `cloop off`, `cloop song` or `cloop queue`.');
          const mode = s.setLoop(wanted ?? LOOP_MODES[(LOOP_MODES.indexOf(s.loop) + 1) % LOOP_MODES.length]);
          const label = { off: '➡️ Loop off.', song: '🔂 Looping this song.', queue: '🔁 Looping the queue.' };
          return ctx.reply(label[mode]);
        },
      },
      {
        name: 'sound',
        aliases: ['profile', 'eq'],
        usage: 'sound [pure | hifi | bass | vocal]',
        description: 'Pick the sound profile. With nothing after it, shows the options.',
        sameChannel: true,
        run: (ctx) => {
          const current = this.settings.data.soundProfile;
          const wanted = ctx.args[0]?.toLowerCase();
          if (!wanted) {
            const lines = Object.entries(PROFILES).map(
              ([key, p]) => `${p.emoji} \`${config.prefix}sound ${key}\` ${key === current ? '**(current)**' : ''}\n${p.description}`,
            );
            return ctx.reply(`🎚 **Sound profiles**\n\n${lines.join('\n\n')}`);
          }
          if (!PROFILES[wanted]) throw new UserError(`Unknown profile. Pick one of: ${Object.keys(PROFILES).join(', ')}.`);
          this.settings.data.soundProfile = wanted;
          this.settings.save();
          const applied = this.#reopenSoon();
          const p = PROFILES[wanted];
          return ctx.reply(
            `${p.emoji} Sound profile: **${p.label}**. ${applied ? 'Switching in a moment, without stopping the music.' : 'Applies to the next song.'}`,
            COLORS.playing,
          );
        },
      },
      {
        name: 'volume',
        aliases: ['vol'],
        usage: 'volume [0-150 | +10 | -10]',
        description: 'Set the volume (saved). Above 100% uses a limiter so it never distorts. Changes without stopping the music.',
        sameChannel: true,
        run: (ctx) => {
          const current = clampVolume(this.settings.data.volume ?? 100);
          const arg = ctx.args[0]?.replace(/%$/, '');
          if (!arg) return ctx.reply(`🔊 Volume: **${current}%**. Use \`${config.prefix}volume 0-${MAX_VOLUME}\`, \`+10\` or \`-10\`.`);
          const n = Number(arg);
          if (!Number.isFinite(n)) throw new UserError(`Usage: \`${config.prefix}volume 0-${MAX_VOLUME}\`, \`+10\` or \`-10\`.`);
          if (!ffmpegAvailable()) throw new UserError("Volume needs ffmpeg, which isn't working on this machine.");
          const value = clampVolume(/^[+-]/.test(arg) ? current + n : n);
          if (value === current) return ctx.reply(`🔊 Volume is already **${value}%**.`);
          this.settings.data.volume = value;
          this.settings.save();
          const applied = this.#reopenSoon();
          const icon = value === 0 ? '🔇' : value < 50 ? '🔈' : value <= 100 ? '🔉' : '🔊';
          return ctx.reply(
            `${icon} Volume **${value}%**${value > 100 ? ' (boosted, limiter on)' : ''}. ${applied ? 'Changing in a moment, without stopping the music.' : 'Applies to the next song.'}`,
            COLORS.playing,
          );
        },
      },
      {
        name: 'link',
        aliases: ['linkmode'],
        usage: 'link',
        description: 'Toggle link mode in this channel: pasted YouTube, Spotify or SoundCloud links play without cplay.',
        run: (ctx) => {
          const channels = this.#linkChannels();
          const id = ctx.message.channelId;
          const i = channels.indexOf(id);
          const on = i === -1;
          if (on) channels.push(id);
          else channels.splice(i, 1);
          this.settings.save();
          return ctx.reply(
            on
              ? `🔗 **Link mode is ON** in <#${id}>.\nPaste a YouTube, Spotify or SoundCloud link to play it. Paste more and they get queued.\nType \`${config.prefix}link\` again to turn it off.`
              : `🔗 **Link mode is OFF** in <#${id}>. Use \`${config.prefix}play <link>\` again.`,
            on ? COLORS.playing : COLORS.idle,
          );
        },
      },
      {
        name: 'autoplay',
        aliases: ['ap', 'auto'],
        usage: 'autoplay [on | off]',
        description: 'When the queue runs out, keep playing similar songs. With nothing after it, toggles.',
        sameChannel: true,
        run: (ctx) => {
          const wanted = ctx.args[0]?.toLowerCase();
          if (wanted && !['on', 'off'].includes(wanted)) throw new UserError('Usage: `cautoplay on` or `cautoplay off`.');
          const on = this.autoplay.setEnabled(wanted ? wanted === 'on' : !s.autoplay);
          return ctx.reply(
            on ? '🎲 Autoplay **on**. Similar songs play when the queue runs out.' : '⏹ Autoplay **off**. Picks already queued were removed.',
            on ? COLORS.playing : COLORS.idle,
          );
        },
      },
      {
        name: 'vibe',
        aliases: ['radio', 'mood'],
        usage: 'vibe <mood>',
        description: `Endless radio in a mood: ${Object.keys(VIBES).join(', ')}.`,
        run: async (ctx) => {
          const name = ctx.args[0]?.toLowerCase();
          if (!name || !VIBES[name]) {
            const list = Object.entries(VIBES).map(([k, x]) => `${x.emoji} \`${config.prefix}vibe ${k}\``).join('\n');
            return ctx.reply(`📻 **Pick a vibe**\n\n${list}`);
          }
          await v.ensureFor(ctx.member);
          s.textChannelId = ctx.message.channelId;
          ctx.message.channel.sendTyping().catch(() => {});
          let seed;
          try {
            seed = await this.autoplay.vibeSeed(name, ctx.member.user);
          } catch (err) {
            throw new UserError(`Couldn't start that vibe. (${err.message.slice(0, 150)})`);
          }
          if (!seed) throw new UserError('No songs found for that vibe. Try another one.');
          if (!s.autoplay) this.autoplay.setEnabled(true);
          const { position } = s.add([seed]);
          s.start();
          const where = position === 0 ? 'Starting with' : `Up #${position}:`;
          return ctx.reply(`${VIBES[name].emoji} **${name}** radio on. ${where} ${trackLabel(seed)}. Autoplay keeps the vibe going.`, COLORS.playing);
        },
      },
      {
        name: 'sleep',
        aliases: ['timer'],
        usage: 'sleep <30m | 1h | 1h30m | off>',
        description: 'Stop the music and leave voice after a while. With nothing after it, shows the time left.',
        sameChannel: true,
        run: (ctx) => {
          const arg = ctx.argText.toLowerCase();
          if (!arg) {
            if (!s.sleepAt) return ctx.reply(`😴 No sleep timer. Try \`${config.prefix}sleep 30m\`.`);
            return ctx.reply(`😴 Stopping in **${formatListening((s.sleepAt - Date.now()) / 1000)}**. \`${config.prefix}sleep off\` cancels.`);
          }
          if (['off', 'cancel', 'stop', '0'].includes(arg)) {
            if (!s.sleepAt) throw new UserError('No sleep timer is running.');
            this.#setSleep(0);
            return ctx.reply('⏰ Sleep timer cancelled.');
          }
          const minutes = parseMinutes(arg);
          if (!minutes || minutes < 1 || minutes > MAX_SLEEP_MIN) {
            throw new UserError(`Usage: \`${config.prefix}sleep 30m\`, \`${config.prefix}sleep 1h30m\` (1 min to 12 h) or \`${config.prefix}sleep off\`.`);
          }
          this.#setSleep(Math.round(minutes * 60_000), ctx.message.channel);
          const at = Math.floor((Date.now() + minutes * 60_000) / 1000);
          return ctx.reply(`😴 Sleep timer set: the music stops <t:${at}:R> (at <t:${at}:t>).`, COLORS.paused);
        },
      },
      {
        name: 'like',
        aliases: ['love', 'fav'],
        usage: 'like',
        description: 'Add the current song to your liked songs (or remove it). The ❤️ button does the same.',
        anytime: true,
        run: (ctx) => {
          const track = s.nowPlaying;
          if (!track) throw new UserError('Nothing is playing.');
          return ctx.reply(this.#toggleLike(ctx.member.id, track), COLORS.playing);
        },
      },
      {
        name: 'liked',
        aliases: ['likes', 'favs'],
        usage: 'liked [play | shuffle | page]',
        description: 'Show your liked songs. `liked play` queues them all, `liked shuffle` in random order.',
        anytime: true,
        run: async (ctx) => {
          const list = this.library.liked(ctx.member.id);
          const arg = ctx.args[0]?.toLowerCase();
          if (arg === 'play' || arg === 'shuffle') {
            if (!list.length) throw new UserError('You have no liked songs yet. Press ❤️ on the player.');
            return this.#playSaved(ctx, list, arg === 'shuffle');
          }
          const lines = list.map((t, i) => `\`${i + 1}.\` ${trackLabel(t, 60)} \`${formatDuration(t.duration)}\``);
          const total = list.reduce((sum, t) => sum + (t.duration ?? 0), 0);
          return ctx.reply(
            this.#pageEmbed(
              `❤️ ${ctx.member.displayName}'s liked songs`,
              lines.length ? lines : ['*None yet. Press ❤️ on the player to like a song.*'],
              parsePositive(ctx.args[0]),
              list.length ? `${list.length} song(s) · ${formatListening(total)} · ${config.prefix}liked play` : null,
            ),
          );
        },
      },
      {
        name: 'save',
        aliases: ['savepl'],
        usage: 'save <playlist name>',
        description: 'Save the current song and Up Next as a playlist (autoplay picks are left out). Same name replaces it.',
        anytime: true,
        run: (ctx) => {
          if (!ctx.argText) throw new UserError(`Usage: \`${config.prefix}save <playlist name>\``);
          const tracks = s.tracks.slice(s.index).filter((t, i) => i === 0 || !t.autoplay);
          if (!tracks.length) throw new UserError('The queue is empty; play something first.');
          const isOwner = ctx.member.id === config.ownerId;
          const { replaced, count, cut } = this.library.savePlaylist(ctx.argText, tracks, ctx.member.id, isOwner);
          const name = this.library.playlist(ctx.argText).name;
          return ctx.reply(
            `💾 ${replaced ? 'Updated' : 'Saved'} **${name}** with ${count} song(s)${cut ? ' (the limit is 500)' : ''}. Play it with \`${config.prefix}load ${name}\`.`,
            COLORS.playing,
          );
        },
      },
      {
        name: 'load',
        aliases: ['loadpl'],
        usage: 'load <playlist name> [shuffle]',
        description: 'Queue a saved playlist. Add `shuffle` for random order.',
        run: async (ctx) => {
          if (!ctx.argText) throw new UserError(`Usage: \`${config.prefix}load <playlist name>\`. See \`${config.prefix}playlists\`.`);
          // A playlist literally named "... shuffle" wins over the shuffle option.
          const exact = this.library.playlist(ctx.argText);
          const { name, shuffle } = exact ? { name: ctx.argText, shuffle: false } : nameAndShuffle(ctx.argText);
          const playlist = exact ?? this.library.playlist(name);
          if (!playlist) throw new UserError(`No playlist called **${cleanTitle(name, 32)}**. See \`${config.prefix}playlists\`.`);
          return this.#playSaved(ctx, playlist.tracks, shuffle);
        },
      },
      {
        name: 'playlists',
        aliases: ['pls'],
        usage: 'playlists [name]',
        description: 'List saved playlists, or the songs in one.',
        anytime: true,
        run: (ctx) => {
          // "cplaylists 2" = page 2 of the list; "cplaylists gym 2" = page 2 of "gym" (unless "gym 2" exists).
          const exact = ctx.argText && this.library.playlist(ctx.argText);
          const m = ctx.argText.match(/^(.*?)\s*(\d+)?$/);
          const name = exact ? ctx.argText : m[1].trim();
          const page = exact ? 1 : parsePositive(m[2]);
          if (name) {
            const playlist = exact || this.library.playlist(name);
            if (!playlist) throw new UserError(`No playlist called **${cleanTitle(name, 32)}**.`);
            const lines = playlist.tracks.map((t, i) => `\`${i + 1}.\` ${trackLabel(t, 60)} \`${formatDuration(t.duration)}\``);
            const total = playlist.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
            return ctx.reply(
              this.#pageEmbed(
                `💾 ${playlist.name}`,
                [`By <@${playlist.by}> · updated ${timeAgo(playlist.updatedAt)}`, '', ...lines],
                page,
                `${playlist.tracks.length} song(s) · ${formatListening(total)} · ${config.prefix}load ${playlist.name}`,
              ),
            );
          }
          const all = this.library.playlists();
          const lines = all.map((p) => `💾 **${cleanTitle(p.name, 32)}** · ${p.tracks.length} song(s) · <@${p.by}> · ${timeAgo(p.updatedAt)}`);
          return ctx.reply(
            this.#pageEmbed(
              '💾 Playlists',
              lines.length ? lines : [`*None yet. Queue some songs, then \`${config.prefix}save <name>\`.*`],
              page,
              all.length ? `${config.prefix}load <name> · ${config.prefix}playlists <name> shows the songs` : null,
            ),
          );
        },
      },
      {
        name: 'delpl',
        aliases: ['deleteplaylist', 'unsave'],
        usage: 'delpl <playlist name>',
        description: 'Delete a saved playlist (its creator or the owner).',
        anytime: true,
        run: (ctx) => {
          if (!ctx.argText) throw new UserError(`Usage: \`${config.prefix}delpl <playlist name>\``);
          const name = this.library.deletePlaylist(ctx.argText, ctx.member.id, ctx.member.id === config.ownerId);
          return ctx.reply(`🗑 Deleted playlist **${name}**.`);
        },
      },
      {
        name: 'history',
        aliases: ['hist', 'recent'],
        usage: 'history [page]',
        description: 'Songs played recently (heard for at least 30 s).',
        anytime: true,
        run: (ctx) => {
          const recent = this.stats.recent(150);
          const lines = recent.map(({ track, at }, i) => `\`${i + 1}.\` ${trackLabel(track, 55)} · ${timeAgo(at)}`);
          return ctx.reply(this.#pageEmbed('🕘 Recently played', lines.length ? lines : ['*Nothing yet.*'], parsePositive(ctx.args[0])));
        },
      },
      {
        name: 'top',
        aliases: ['mostplayed'],
        usage: 'top [today | week | month | year | all]',
        description: 'Most played songs and artists (all time unless you pick a period).',
        anytime: true,
        run: (ctx) => {
          const period = this.#period(ctx.args[0], 'all');
          const sum = this.stats.summary(PERIODS[period]);
          if (!sum.plays) return ctx.reply(`📊 No plays in ${PERIOD_LABELS[period]} yet.`);
          const songs = sum.songs
            .slice(0, 10)
            .map((x, i) => `\`${i + 1}.\` ${trackLabel(x.track, 50)} · **${x.count}** play${x.count === 1 ? '' : 's'}`);
          const artists = sum.artists.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${cleanTitle(x.name, 40)} · **${x.count}** · ${formatListening(x.seconds)}`);
          const result = new EmbedBuilder()
            .setColor(COLORS.idle)
            .setTitle(`📊 Top · ${PERIOD_LABELS[period]}`)
            .setDescription(`**Songs**\n${songs.join('\n')}${artists.length ? `\n\n**Artists**\n${artists.join('\n')}` : ''}`.slice(0, 4000))
            .setFooter({ text: `${sum.plays} plays · ${sum.unique} songs · ${formatListening(sum.seconds)} listened` });
          return ctx.reply(result);
        },
      },
      {
        name: 'wrapped',
        aliases: ['stats'],
        usage: 'wrapped [today | week | month | year | all]',
        description: 'Your listening summary: time, plays, top songs, artists and languages (last 30 days by default).',
        anytime: true,
        run: (ctx) => {
          const period = this.#period(ctx.args[0], 'month');
          const sum = this.stats.summary(PERIODS[period]);
          if (!sum.plays) return ctx.reply(`🎁 No plays in ${PERIOD_LABELS[period]} yet.`);
          const top = sum.songs[0];
          const langTotal = sum.languages.reduce((n, l) => n + l.count, 0);
          const langs = sum.languages
            .slice(0, 3)
            .map((l) => `${l.name} ${Math.round((l.count / langTotal) * 100)}%`)
            .join(' · ');
          const lines = [
            `⏱ **${formatListening(sum.seconds)}** listened · **${sum.plays}** plays · **${sum.unique}** different songs`,
            '',
            `🏆 **Song of the period:** ${trackLabel(top.track, 60)} (${top.count}×)`,
            ...(sum.artists[0] ? [`🎤 **Top artist:** ${cleanTitle(sum.artists[0].name, 40)} (${formatListening(sum.artists[0].seconds)})`] : []),
            ...(langs ? [`🌐 **Languages:** ${langs}`] : []),
            '',
            '**Top 5 songs**',
            ...sum.songs.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${trackLabel(x.track, 50)} · ${x.count}×`),
            ...(sum.artists.length
              ? ['', '**Top 5 artists**', ...sum.artists.slice(0, 5).map((x, i) => `\`${i + 1}.\` ${cleanTitle(x.name, 40)} · ${x.count} plays`)]
              : []),
          ];
          const result = new EmbedBuilder()
            .setColor(COLORS.playing)
            .setTitle(`🎁 Wrapped · ${PERIOD_LABELS[period]}`)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: sum.since ? `Since ${new Date(sum.since).toLocaleDateString('en-GB')} · ${config.prefix}top for more` : `${config.prefix}top for more` });
          return ctx.reply(result);
        },
      },
      {
        name: 'follow',
        usage: 'follow [on | off]',
        description: 'Turn shadow mode on or off (the bot follows you between voice channels).',
        ownerOnly: true,
        run: (ctx) => {
          const wanted = ctx.args[0]?.toLowerCase();
          if (wanted && !['on', 'off'].includes(wanted)) throw new UserError('Usage: `cfollow on` or `cfollow off`.');
          const on = wanted ? wanted === 'on' : !this.settings.data.follow;
          this.settings.data.follow = on;
          this.settings.save();
          if (on) v.scheduleOwnerSync(0);
          return ctx.reply(on ? '👣 Follow mode **on**. I go where you go.' : '🛑 Follow mode **off**. Use `cplay` to call me.');
        },
      },
      {
        name: 'ping',
        aliases: ['latency', 'net'],
        usage: 'ping',
        description: 'Show network speed: Discord, voice and how fast songs start.',
        run: async (ctx) => {
          const rate = (ms, good, ok) => (ms == null || ms < 0 ? '⚪' : ms <= good ? '🟢' : ms <= ok ? '🟡' : '🔴');
          const fmt = (ms) => (ms == null || ms < 0 ? 'n/a' : `${Math.round(ms)} ms`);

          const started = Date.now();
          const msg = await ctx.message.reply({ embeds: [embed('📶 Measuring…')], allowedMentions: { repliedUser: false } });
          const apiMs = Date.now() - started;
          const gatewayMs = ctx.message.client.ws.ping;
          const voicePing = v.connection?.ping;
          const voiceMs = voicePing?.udp ?? voicePing?.ws ?? null;
          const loadMs = s.lastLoadMs;

          const lines = [
            `${rate(gatewayMs, 150, 300)} **Discord gateway:** ${fmt(gatewayMs)}`,
            `${rate(apiMs, 300, 700)} **Message round trip:** ${fmt(apiMs)}`,
            `${v.connection ? rate(voiceMs, 100, 200) : '⚪'} **Voice:** ${v.connection ? fmt(voiceMs) : 'not in voice'}`,
            `${rate(loadMs, 8_000, 20_000)} **Last song start time:** ${loadMs == null ? 'n/a' : `${(loadMs / 1000).toFixed(1)} s`}`,
          ];
          const worst = [rate(gatewayMs, 150, 300), rate(voiceMs, 100, 200), rate(loadMs, 8_000, 20_000)];
          const verdict = worst.includes('🔴')
            ? '🔴 Slow network: songs may take long to start or stutter.'
            : worst.includes('🟡')
              ? '🟡 OK, with small delays.'
              : '🟢 Network is good.';

          const result = new EmbedBuilder()
            .setColor(verdict.startsWith('🔴') ? COLORS.error : verdict.startsWith('🟡') ? COLORS.paused : COLORS.playing)
            .setTitle('📶 Network')
            .setDescription(`${lines.join('\n')}\n\n${verdict}`)
            .setFooter({ text: 'Voice ping updates every few seconds after joining.' });
          await msg.edit({ embeds: [result] }).catch(() => {});
        },
      },
      {
        name: 'grant',
        usage: 'grant @user | @role',
        description: 'Let a user or role use the bot.',
        ownerOnly: true,
        run: (ctx) => {
          const target = this.#target(ctx);
          const ok = this.perms.grant(target.kind, target.id);
          return ctx.reply(ok ? `✅ ${target.mention} can now use the bot.` : `${target.mention} already has access.`);
        },
      },
      {
        name: 'revoke',
        usage: 'revoke @user | @role',
        description: "Remove a user's or role's access.",
        ownerOnly: true,
        run: (ctx) => {
          const target = this.#target(ctx);
          const ok = this.perms.revoke(target.kind, target.id);
          return ctx.reply(ok ? `🚫 ${target.mention} can no longer use the bot.` : `${target.mention} didn't have access.`);
        },
      },
      {
        name: 'perms',
        aliases: ['access'],
        usage: 'perms',
        description: 'List who can use the bot.',
        ownerOnly: true,
        run: (ctx) => {
          const users = this.perms.users.map((id) => `<@${id}>`).join(', ') || '*nobody*';
          const roles = this.perms.roles.map((id) => `<@&${id}>`).join(', ') || '*none*';
          return ctx.reply(`**Owner:** <@${config.ownerId}>\n**Users:** ${users}\n**Roles:** ${roles}`);
        },
      },
      {
        name: 'help',
        aliases: ['commands'],
        usage: 'help',
        description: 'Show all commands.',
        run: async (ctx) => {
          const isOwner = ctx.member.id === config.ownerId;
          const lines = this.#definitions()
            .filter((c) => isOwner || !c.ownerOnly)
            .map((c) => {
              const aliases = c.aliases?.length ? ` *(${c.aliases.map((a) => config.prefix + a).join(', ')})*` : '';
              return `\`${config.prefix}${c.usage}\`${aliases}\n${c.description}`;
            });
          // Discord allows 4096 characters per embed, so long help is split over several messages.
          const chunks = [''];
          for (const line of lines) {
            if (chunks.at(-1).length + line.length + 2 > 3900) chunks.push('');
            chunks[chunks.length - 1] += `${chunks.at(-1) ? '\n\n' : ''}${line}`;
          }
          for (const [i, text] of chunks.entries()) {
            const help = new EmbedBuilder().setColor(COLORS.idle).setDescription(text);
            if (i === 0) help.setTitle('🎧 Commands');
            if (i === chunks.length - 1) help.setFooter({ text: 'While the owner is in voice, only the owner can control playback.' });
            if (i === 0) await ctx.reply(help);
            else await ctx.message.channel.send({ embeds: [help] }).catch(() => {});
          }
        },
      },
    ];
  }

  /** Reads a @user / @role mention or a raw ID from the command. */
  #target(ctx) {
    const { message, args } = ctx;
    const role = message.mentions.roles.first();
    if (role) return { kind: 'roles', id: role.id, mention: `<@&${role.id}>` };
    const user = message.mentions.users.first();
    if (user) {
      if (user.id === config.ownerId) throw new UserError("You're the owner; you always have access.");
      return { kind: 'users', id: user.id, mention: `<@${user.id}>` };
    }
    const id = args[0]?.replace(/\D/g, '');
    if (id && /^\d{17,20}$/.test(id)) {
      const isRole = message.guild.roles.cache.has(id);
      return isRole ? { kind: 'roles', id, mention: `<@&${id}>` } : { kind: 'users', id, mention: `<@${id}>` };
    }
    throw new UserError('Mention a user or role, e.g. `cgrant @friend`.');
  }
}
