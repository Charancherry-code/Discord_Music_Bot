// Prefix commands (cplay, cskip, ...) and Now Playing button handling.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { cleanTitle, formatDuration, trackLabel } from './format.js';
import { log } from './logger.js';
import { COLORS } from './nowplaying.js';
import { LOOP_MODES } from './player.js';
import { PROFILES } from './profiles.js';
import { VIBES } from './autoplay.js';
import { loadDefaultPlaylist, makeTrack, resolveInput, UserError } from './sources.js';
import { searchTracks } from './ytdlp.js';

const MSG_NO_PERMISSION = "🔒 You don't have permission to use this bot.";
const MSG_BUSY = '🎧 Busy with the owner. Try again when they leave voice.';
const QUEUE_PAGE_SIZE = 10;

const embed = (text, color = COLORS.idle) => new EmbedBuilder().setColor(color).setDescription(text);

function parsePositive(text) {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export class CommandHandler {
  #lookup = new Map();

  constructor({ session, voice, perms, settings, card, autoplay }) {
    this.autoplay = autoplay;
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

  /** Returns a denial message, or null if `member` may use the bot right now. */
  #deny(member, { ownerOnly = false } = {}) {
    const isOwner = member?.id === config.ownerId;
    if (ownerOnly && !isOwner) return '🔒 Only the bot owner can use this command.';
    if (isOwner) return null;
    if (!this.perms.isApproved(member)) return MSG_NO_PERMISSION;
    if (this.voice.ownerInVoice()) return MSG_BUSY;
    return null;
  }

  // ---------- message commands ----------

  async handleMessage(message) {
    if (message.author.bot || !message.inGuild() || message.guildId !== config.guildId) return;

    const content = message.content.trim();
    const prefix = config.prefix;
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
    const denied = this.#deny(member);
    if (denied) return ephemeral(denied);

    if (action === 'queue') {
      return interaction
        .reply({ embeds: [this.#queueEmbed(0)], flags: MessageFlags.Ephemeral })
        .catch((err) => log.warn(`Button reply failed: ${err.message}`));
    }

    const problem = this.voice.checkSameChannel(member);
    if (problem) return ephemeral(problem);

    // Acknowledge right away: Discord shows "This interaction failed" after 3 seconds without it.
    try {
      await interaction.deferUpdate();
    } catch (err) {
      log.warn(`Button "${action}" could not be acknowledged: ${err.message}`);
      return;
    }
    // After acknowledging: private follow-up messages.
    const notice = (text) =>
      interaction.followUp({ embeds: [embed(text, COLORS.error)], flags: MessageFlags.Ephemeral }).catch(() => {});

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
      .map((t, i) => `\`${p * QUEUE_PAGE_SIZE + i + 1}.\` ${trackLabel(t, 60)} \`${formatDuration(t.duration)}\`${t.autoplay ? ' 🎲' : t.isDefault ? ' 📄' : ''}`);

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

  async #loadDefaultInto() {
    const tracks = await loadDefaultPlaylist();
    if (tracks.length) this.session.add(tracks);
    return tracks.length;
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
        description: 'Play a song or add it to the queue. With nothing after it, resumes or plays playlist.txt.',
        run: async (ctx) => {
          await v.ensureFor(ctx.member);
          s.textChannelId = ctx.message.channelId;
          if (!ctx.argText) {
            if (!s.hasPending && s.isIdle) {
              const count = await this.#loadDefaultInto();
              if (!count) return ctx.reply('Nothing queued and playlist.txt is empty. Try `cplay <song>`.', COLORS.error);
            }
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
          const applied = s.reapplyAudio();
          const p = PROFILES[wanted];
          return ctx.reply(`${p.emoji} Sound profile: **${p.label}**. ${applied ? 'Applied now.' : 'Applies to the next song.'}`, COLORS.playing);
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
        run: (ctx) => {
          const isOwner = ctx.member.id === config.ownerId;
          const lines = this.#definitions()
            .filter((c) => isOwner || !c.ownerOnly)
            .map((c) => {
              const aliases = c.aliases?.length ? ` *(${c.aliases.map((a) => config.prefix + a).join(', ')})*` : '';
              return `\`${config.prefix}${c.usage}\`${aliases}\n${c.description}`;
            });
          const help = new EmbedBuilder()
            .setColor(COLORS.idle)
            .setTitle('🎧 Commands')
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setFooter({ text: 'While the owner is in voice, only the owner can control the bot.' });
          return ctx.reply(help);
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
