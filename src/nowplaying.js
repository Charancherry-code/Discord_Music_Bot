// The live Now Playing card: one message, edited in place.
// Plain markdown with short lines and inline code labels, so it wraps cleanly in narrow
// panels (voice channel chat, phones) instead of breaking like a code block does.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { cleanTitle, formatDuration, truncate } from './format.js';
import { log } from './logger.js';
import { getProfile } from './profiles.js';

const REFRESH_MS = 15_000; // Progress bar update interval (Discord rate limits make faster updates a bad idea).
const DEBOUNCE_MS = 1_500;
const BAR_SIZE = 14; // Short enough to fit on one line in the narrow voice chat panel.

export const COLORS = { playing: 0x1db954, paused: 0xfaa61a, idle: 0x5865f2, error: 0xed4245, loading: 0x00b8d4 };

function bar(positionSec, durationSec) {
  if (!durationSec) return '─'.repeat(BAR_SIZE);
  const filled = Math.round(Math.min(1, Math.max(0, positionSec / durationSec)) * BAR_SIZE);
  return `${'━'.repeat(filled)}●${'─'.repeat(Math.max(0, BAR_SIZE - filled))}`;
}

/** Title to show; playlist links that haven't loaded yet show as "🔗 youtube.com" instead of a raw URL. */
function displayTitle(track, max = 60) {
  const title = String(track?.title ?? 'Unknown');
  if (/^https?:\/\//i.test(title)) {
    try {
      return `🔗 ${new URL(title).hostname.replace(/^www\./, '')}`;
    } catch {
      return '🔗 link';
    }
  }
  return cleanTitle(title, max);
}

export class NowPlayingCard {
  #message = null;
  #interval = null;
  #debounce = null;
  #busy = Promise.resolve();

  constructor(client, session) {
    this.client = client;
    this.session = session;

    session.on('trackStart', () => this.#enqueue(() => this.#show()));
    session.on('change', () => this.#refreshSoon());
    session.on('idle', () => this.#enqueue(() => this.#finish()));
  }

  /** Runs card updates one at a time so edits never race each other. */
  #enqueue(task) {
    this.#busy = this.#busy.then(task).catch((err) => log.debug(`Now Playing card update failed: ${err.message}`));
    return this.#busy;
  }

  #channel() {
    const channel = this.client.channels.cache.get(this.session.textChannelId);
    return channel?.isTextBased() ? channel : null;
  }

  #state() {
    const s = this.session;
    if (s.nowPlaying) return s.isPaused ? 'paused' : 'playing';
    if (!s.isIdle) return 'loading';
    return 'idle';
  }

  build() {
    const s = this.session;
    const state = this.#state();
    const track = s.nowPlaying ?? (state === 'loading' ? s.tracks[s.index] : null);
    const ping = this.client.ws.ping;
    const footer = `$ shadow-music · ${ping >= 0 ? `${ping}ms` : 'n/a'} · chelp`;

    if (state === 'idle' || !track) {
      const idle = new EmbedBuilder()
        .setColor(COLORS.idle)
        .setAuthor({ name: '■ STOPPED' })
        .setDescription('Queue is empty.\n`cplay <song or link>` to start.')
        .setFooter({ text: footer });
      return { embeds: [idle], components: [] };
    }

    const profile = getProfile(s.audioOptions.profile);
    const kbps = Math.round((s.audioOptions.bitrate ?? 160_000) / 1000);
    const quality = s.passthrough ? `${profile.label} · passthrough` : `${profile.label} · ${kbps}k`;
    const status = { playing: '▶ PLAYING', paused: '⏸ PAUSED', loading: '⏳ LOADING' }[state];

    let timeline;
    if (state === 'loading') timeline = '`fetching stream…`';
    else if (track.live) timeline = '`● LIVE`';
    else {
      const pos = s.positionSec;
      timeline = `\`${formatDuration(pos)}\` ${bar(pos, track.duration)} \`${formatDuration(track.duration)}\``;
    }

    const next = s.upcoming;
    const nextLine = next.length
      ? `${displayTitle(next[0], 40)}${next.length > 1 ? ` · +${next.length - 1}` : ''}`
      : s.loop === 'queue'
        ? 'restart from top'
        : '—';
    const requester = track.requesterId ? `<@${track.requesterId}>` : 'playlist.txt';

    const lines = [
      ...(track.author ? [`by **${cleanTitle(track.author, 60)}**`, ''] : []),
      timeline,
      '',
      `\`queue\` ${s.index + 1}/${s.tracks.length} · \`loop\` ${s.loop}`,
      `\`req\` ${requester}`,
      `\`next\` ${nextLine}`,
    ];

    const color = { playing: COLORS.playing, paused: COLORS.paused, loading: COLORS.loading }[state];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: `${status}  ·  ${quality}` })
      .setTitle(truncate(displayTitle(track, 200), 250))
      .setDescription(lines.join('\n'))
      .setFooter({ text: footer });
    if (track.url?.startsWith('http')) embed.setURL(track.url);
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);

    // Emoji-only buttons stay on one row even in narrow panels.
    const btn = (id, emoji, style = ButtonStyle.Secondary, disabled = false) =>
      new ButtonBuilder().setCustomId(`np:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);

    const canPause = state === 'playing' || state === 'paused';
    const row1 = new ActionRowBuilder().addComponents(
      btn('prev', '⏮', ButtonStyle.Secondary, s.index === 0),
      btn('pause', state === 'paused' ? '▶️' : '⏸', ButtonStyle.Primary, !canPause),
      btn('skip', '⏭'),
      btn('stop', '⏹', ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
      btn('loop', s.loop === 'song' ? '🔂' : '🔁', s.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
      btn('shuffle', '🔀', ButtonStyle.Secondary, next.length < 2),
      btn('queue', '📜'),
    );
    return { embeds: [embed], components: [row1, row2] };
  }

  /** Posts the card for a new track: edits the old one if it's still the latest message, otherwise reposts. */
  async #show() {
    const channel = this.#channel();
    if (!channel) return;
    const payload = this.build();

    if (this.#message && this.#message.channelId === channel.id && channel.lastMessageId === this.#message.id) {
      await this.#message.edit(payload);
    } else {
      const old = this.#message;
      this.#message = await channel.send(payload);
      old?.delete().catch(() => {});
    }
    this.#startInterval();
  }

  #refreshSoon() {
    if (!this.#message) return;
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => this.#enqueue(() => this.#edit()), DEBOUNCE_MS);
  }

  async #edit() {
    if (!this.#message) return;
    if (this.#state() === 'idle') return; // 'idle' event handles the final state
    try {
      await this.#message.edit(this.build());
    } catch (err) {
      if (err.code === 10008) this.#message = null; // Unknown Message: someone deleted the card.
      else throw err;
    }
  }

  async #finish() {
    this.#stopInterval();
    if (!this.#message) return;
    const message = this.#message;
    this.#message = null;
    await message.edit(this.build()).catch(() => {});
  }

  #startInterval() {
    this.#stopInterval();
    this.#interval = setInterval(() => {
      if (this.session.nowPlaying && !this.session.isPaused) this.#enqueue(() => this.#edit());
    }, REFRESH_MS);
  }

  #stopInterval() {
    clearInterval(this.#interval);
    this.#interval = null;
  }

  /** Posts a fresh card at the bottom of `channelId` (used by cnp). */
  repost(channelId) {
    this.session.textChannelId = channelId;
    return this.#enqueue(async () => {
      const old = this.#message;
      this.#message = null;
      await this.#show();
      old?.delete().catch(() => {});
    });
  }

  /** Refreshes immediately after a button press. */
  refreshNow() {
    clearTimeout(this.#debounce);
    return this.#enqueue(() => this.#edit());
  }
}
