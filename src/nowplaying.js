// The live Now Playing card ("D+", IDE status bar style): one message, edited in place.
// No code block: every status item is its own inline-code chip, so on narrow screens whole chips
// move to the next line instead of breaking. Looks the same on desktop, web and phones.
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { cleanTitle, formatDuration, truncate } from './format.js';
import { detectLanguage } from './language.js';
import { log } from './logger.js';
import { getProfile } from './profiles.js';

const REFRESH_MS = 15_000; // Progress bar update interval (Discord rate limits make faster updates a bad idea).
const DEBOUNCE_MS = 1_500;
const BAR_SIZE = 13;
const WATERMARK = '</> developed by cherry';

export const COLORS = { playing: 0x1db954, paused: 0xfaa61a, idle: 0x5865f2, error: 0xed4245, loading: 0x00b8d4 };

const chip = (text) => `\`${String(text).replace(/`/g, "'")}\``;
const memoryMb = () => Math.round(process.memoryUsage().rss / 1048576);

function bar(positionSec, durationSec) {
  if (!durationSec) return '─'.repeat(BAR_SIZE);
  const filled = Math.round(Math.min(1, Math.max(0, positionSec / durationSec)) * BAR_SIZE);
  return `${'━'.repeat(filled)}●${'─'.repeat(Math.max(0, BAR_SIZE - filled))}`;
}

/** Where the song came from, shown as a git branch: ⎇ youtube / spotify / soundcloud / local. */
function branch(track) {
  if (track.path) return 'local';
  if (track.source === 'spotify') return 'spotify';
  if (/soundcloud\.com/i.test(track.url ?? '')) return 'soundcloud';
  return 'youtube';
}

/** "~/queue/hindi › track.opus" (or ~/autoplay/... for autoplay picks). */
function breadcrumb(track) {
  const folder = track.autoplay ? 'autoplay' : 'queue';
  const lang = detectLanguage(track);
  const file = track.path ? path.basename(track.path) : 'track.opus';
  return `~/${folder}${lang ? `/${lang}` : ''} › ${truncate(file, 40)}`;
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

  #footer(codec) {
    const s = this.session;
    return `⚠ ${s.stutters ?? 0}  ✖ ${s.failedCount ?? 0} · ${memoryMb()}MB · UTF-8 · ${codec} · ${WATERMARK}`;
  }

  build() {
    const s = this.session;
    const state = this.#state();
    const track = s.nowPlaying ?? (state === 'loading' ? s.tracks[s.index] : null);

    if (state === 'idle' || !track) {
      const idle = new EmbedBuilder()
        .setColor(COLORS.idle)
        .setAuthor({ name: '~/queue › empty' })
        .setDescription(`${chip('■ stopped')}\n\n// queue empty — ${chip('cplay <song>')}`)
        .setFooter({ text: this.#footer('Opus') });
      return { embeds: [idle], components: [] };
    }

    const profile = getProfile(s.audioOptions.profile);
    const kbps = Math.round((s.audioOptions.bitrate ?? 160_000) / 1000);
    const ping = this.client.ws.ping;

    let timeline;
    if (state === 'loading') timeline = `${chip('○ loading')} fetching stream…`;
    else if (track.live) timeline = chip('● LIVE');
    else {
      const pos = s.positionSec;
      timeline = `${chip(formatDuration(pos))} ${bar(pos, track.duration)} ${chip(formatDuration(track.duration))}`;
    }

    const status = { playing: '▶ playing', paused: '‖ paused', loading: '○ loading' }[state];
    const row1 = [chip(status), chip(`⎇ ${branch(track)}`), chip(s.passthrough ? 'pure' : profile.label.toLowerCase()), chip(`${kbps}k`)];
    const row2 = [
      chip(`🎲 ${s.autoplay ? 'on' : 'off'}`),
      chip(`↻ ${s.loop}`),
      chip(`Ln ${s.index + 1}/${s.tracks.length}`),
      chip(`⚡${ping >= 0 ? `${ping}ms` : 'n/a'}`),
    ];

    const next = s.upcoming;
    const nextText = next.length
      ? `${displayTitle(next[0], 50)}${next.length > 1 ? ` (+${next.length - 1})` : ''}`
      : s.loop === 'queue'
        ? 'back to the top'
        : s.autoplay
          ? '🎲 picking a similar song…'
          : 'nothing queued';

    const lines = [
      ...(track.author ? [cleanTitle(track.author, 80)] : []),
      '',
      timeline,
      '',
      row1.join(' '),
      row2.join(' '),
      '',
      `\`// next →\` ${nextText}`,
    ];

    const color = { playing: COLORS.playing, paused: COLORS.paused, loading: COLORS.loading }[state];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: breadcrumb(track) })
      .setTitle(truncate(displayTitle(track, 200), 250))
      .setDescription(lines.join('\n'))
      .setFooter({ text: this.#footer('Opus') });
    if (track.url?.startsWith('http')) embed.setURL(track.url);
    if (track.thumbnail?.startsWith('http')) embed.setThumbnail(track.thumbnail);

    // Emoji-only buttons stay on one row even in narrow panels.
    const btn = (id, emoji, style = ButtonStyle.Secondary, disabled = false) =>
      new ButtonBuilder().setCustomId(`np:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);

    const canPause = state === 'playing' || state === 'paused';
    const buttons1 = new ActionRowBuilder().addComponents(
      btn('prev', '⏮', ButtonStyle.Secondary, s.index === 0),
      btn('pause', state === 'paused' ? '▶️' : '⏸', ButtonStyle.Primary, !canPause),
      btn('skip', '⏭'),
      btn('stop', '⏹', ButtonStyle.Danger),
    );
    const buttons2 = new ActionRowBuilder().addComponents(
      btn('loop', s.loop === 'song' ? '🔂' : '🔁', s.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
      btn('shuffle', '🔀', ButtonStyle.Secondary, next.length < 2),
      btn('autoplay', '🎲', s.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn('queue', '📜'),
    );
    return { embeds: [embed], components: [buttons1, buttons2] };
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
