// Shows the current song in two places:
//   1. The bot's profile: "Listening to <song>".
//   2. The voice channel status (the line under the channel name in the sidebar).
// Both update only when the song changes (never on a timer), so they stay well inside Discord's
// rate limits. Failures are logged once and never affect playback.
import { ActivityType, Events } from 'discord.js';
import { config } from './config.js';
import { log } from './logger.js';

const STATUS_MAX = 100; // Discord allows 500; 100 keeps the sidebar readable
const DEBOUNCE_MS = 1_500; // quick skips cause one update, not several

const clip = (text, max) => {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

export class NowPlayingStatus {
  #timer = null;
  #busy = Promise.resolve();
  #channelId = null; // channel whose status we last set
  #warned = false;

  constructor(client, session, voice) {
    this.client = client;
    this.session = session;
    this.voice = voice;

    session.on('trackStart', () => this.#schedule());
    session.on('idle', () => this.#schedule());
    // The bot moved to another channel mid-song: move the status with it.
    client.on(Events.VoiceStateUpdate, (before, after) => {
      if (after.guild.id === config.guildId && after.id === client.user?.id && before.channelId !== after.channelId) {
        this.#schedule();
      }
    });
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#busy = this.#busy.then(() => this.#apply()).catch((err) => log.debug(`Status update failed: ${err.message}`));
    }, DEBOUNCE_MS);
    this.#timer.unref();
  }

  async #apply() {
    const track = this.session.nowPlaying;
    const channelId = track ? this.voice.channelId : null;

    // Profile status.
    if (track) {
      this.client.user?.setActivity({ name: clip(track.title, 128), type: ActivityType.Listening });
    } else {
      this.client.user?.setPresence({ activities: [] });
    }

    // Voice channel status: clear the old channel if we moved or stopped, then set the new one.
    if (this.#channelId && this.#channelId !== channelId) {
      await this.#setVoiceStatus(this.#channelId, '');
      this.#channelId = null;
    }
    if (channelId) {
      const text = track.author ? `🎵 ${track.title} · ${track.author}` : `🎵 ${track.title}`;
      if (await this.#setVoiceStatus(channelId, clip(text, STATUS_MAX))) this.#channelId = channelId;
    }
  }

  /** Discord's voice-status endpoint (not in discord.js yet). Returns true on success. */
  async #setVoiceStatus(channelId, status) {
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
      return true;
    } catch (err) {
      if (!this.#warned) {
        this.#warned = true;
        const hint = err.status === 403 ? ' Give the bot the "Set Voice Channel Status" permission.' : '';
        log.warn(`Couldn't set the voice channel status (${err.message}).${hint}`);
      }
      return false;
    }
  }

  /** Clears both statuses (used on shutdown). */
  async clear() {
    clearTimeout(this.#timer);
    this.client.user?.setPresence({ activities: [] });
    if (this.#channelId) await this.#setVoiceStatus(this.#channelId, '');
    this.#channelId = null;
  }
}
