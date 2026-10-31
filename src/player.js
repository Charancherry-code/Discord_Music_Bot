// The music session: queue, loop modes, playback and failure handling for the one home server.
import { EventEmitter } from 'node:events';
import { AudioPlayerStatus, createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import { createTrackResource } from './audio.js';
import { log } from './logger.js';
import { shuffleInPlace } from './sources.js';

const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_BACKOFF_MS = 60_000;
const MIN_HEALTHY_PLAYBACK_MS = 3_000;
const MAX_HISTORY = 50;
const MAX_QUEUE = 1000;

export const LOOP_MODES = ['off', 'song', 'queue'];

/**
 * Events:
 *  - 'trackStart' (track)   a new track began playing
 *  - 'trackError' (track, err)
 *  - 'idle'                 the queue ran out
 *  - 'change'               anything shown on the Now Playing card changed
 */
export class MusicSession extends EventEmitter {
  /** All tracks; `index` points at the current (or next-to-play) one. Earlier ones are history. */
  tracks = [];
  index = 0;
  loop = 'off';
  /** When the queue runs out, keep playing similar songs (managed by autoplay.js). */
  autoplay = false;
  /** True while the bot is in voice and should be playing. */
  active = false;
  /** Where the Now Playing card goes. */
  textChannelId = null;
  /** How long the last song took to start (search done, until first audio), in ms. */
  lastLoadMs = null;
  /** Set by the app: returns tracks to append when the queue runs out (e.g. playlist.txt). */
  onQueueEnd = null;
  /** Set by the app: returns { filters, bitrate } for the next track (sound profile, channel bitrate). */
  getAudioOptions = () => ({});

  #current = null; // { resource, cleanup, passthrough }
  #loading = null; // AbortController for the track being prepared
  #nextTimer = null;
  #failures = 0;
  #pendingJump = null; // { index, seekSec } applied when the current track stops
  #suppressEnd = false;
  #seekBase = 0; // seconds: where the current resource started inside the track
  #resumeAt = 0; // seconds: where to start the next load (resume after leave/restart)
  #autoPaused = false;
  #prefetch = null; // { track, key, controller, promise } for the next song
  #prefetchTimer = null;
  #currentDownloaded = false;

  constructor(resolver) {
    super();
    this.resolver = resolver;
    this.audio = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 },
    });

    this.audio.on('error', (err) => {
      log.warn(`Stream error on "${err.resource?.metadata?.title ?? 'unknown'}": ${err.message}`);
      // The player goes Idle right after this, which moves on to the next track.
    });

    this.audio.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        this.#onTrackEnd(oldState.resource);
      }
    });

    // Queue edits (add, move, shuffle, loop...) can change which song is next: re-check the preload.
    this.on('change', () => {
      if (this.nowPlaying) this.#schedulePrefetch();
    });

    // Stutter detector: "missed frames" means audio data wasn't ready in time (slow download or busy CPU).
    let lastReport = 0;
    setInterval(() => {
      const state = this.audio.state;
      const missed = state.status === AudioPlayerStatus.Playing ? state.missedFrames ?? 0 : 0;
      if (missed > 0 && Date.now() - lastReport > 10_000) {
        lastReport = Date.now();
        this.stutters = (this.stutters ?? 0) + 1;
        log.warn(`Stutter: audio data arrived late (${missed} missed frames). Cause: slow download or busy CPU.`);
      }
    }, 1_000).unref();
  }

  // ---------- read-only state ----------

  /** The track that is playing or paused right now, or null. */
  get nowPlaying() {
    const state = this.audio.state;
    return state.status === AudioPlayerStatus.Idle ? null : state.resource.metadata;
  }

  get upcoming() {
    return this.tracks.slice(this.index + 1);
  }

  get isPaused() {
    return this.audio.state.status === AudioPlayerStatus.Paused;
  }

  get isLoading() {
    return Boolean(this.#loading);
  }

  /** True when nothing is playing, loading or scheduled. */
  get isIdle() {
    return !this.#loading && !this.#nextTimer && this.audio.state.status === AudioPlayerStatus.Idle;
  }

  /** True if there is a track waiting at `index` (e.g. after leaving voice or a restart). */
  get hasPending() {
    return this.index < this.tracks.length;
  }

  /** Whether the current audio goes to Discord untouched (true) or through ffmpeg (false). */
  get passthrough() {
    return this.#current?.passthrough ?? true;
  }

  /** The { profile, bitrate, filters } the current track was opened with. */
  get audioOptions() {
    return this.#current?.audioOptions ?? {};
  }

  get positionSec() {
    const state = this.audio.state;
    if (state.status === AudioPlayerStatus.Idle) return this.#resumeAt;
    return this.#seekBase + state.resource.playbackDuration / 1000;
  }

  // ---------- queue editing ----------

  /**
   * Adds tracks to the queue. Songs people ask for go before any remaining playlist.txt songs.
   * Returns { added, position } where position 0 means "plays now" and N means "Nth in Up Next".
   */
  add(newTracks) {
    const room = Math.max(0, MAX_QUEUE - this.tracks.length);
    const items = newTracks.slice(0, room);
    if (!items.length) return { added: 0, position: -1 };

    // Requested songs jump ahead of filler (playlist.txt and autoplay picks).
    const isFiller = (t) => t.isDefault || t.autoplay;
    const finished = this.index >= this.tracks.length;
    let insertAt = this.tracks.length;
    if (!finished && !isFiller(items[0])) {
      const firstFiller = this.tracks.findIndex((t, i) => i > this.index && isFiller(t));
      if (firstFiller !== -1) insertAt = firstFiller;
    }
    this.tracks.splice(insertAt, 0, ...items);

    const position = finished && this.isIdle ? 0 : insertAt - this.index;
    this.emit('change');
    if (this.active && this.isIdle) this.#playCurrent();
    return { added: items.length, position };
  }

  /** `n` is 1-based within Up Next. Returns the removed track or null. */
  remove(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.upcoming.length) return null;
    const [removed] = this.tracks.splice(this.index + n, 1);
    this.emit('change');
    return removed;
  }

  move(from, to) {
    const count = this.upcoming.length;
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1 && n <= count)) return null;
    const [track] = this.tracks.splice(this.index + from, 1);
    this.tracks.splice(this.index + to, 0, track);
    this.emit('change');
    return track;
  }

  clearUpcoming() {
    const removed = this.tracks.length - this.index - 1;
    if (removed > 0) this.tracks.splice(this.index + 1);
    this.emit('change');
    return Math.max(0, removed);
  }

  shuffle() {
    const upcoming = this.tracks.splice(this.index + 1);
    shuffleInPlace(upcoming);
    this.tracks.push(...upcoming);
    this.emit('change');
    return upcoming.length;
  }

  setLoop(mode) {
    this.loop = LOOP_MODES.includes(mode) ? mode : 'off';
    this.emit('change');
    return this.loop;
  }

  // ---------- playback control ----------

  /** Starts (or resumes) playback if there is something queued. Safe to call repeatedly. */
  start() {
    this.active = true;
    if (this.isIdle && this.hasPending) this.#playCurrent();
  }

  /** Stops playback because the bot left voice. Keeps the queue and the position in the song. */
  halt() {
    if (this.audio.state.status !== AudioPlayerStatus.Idle) this.#resumeAt = Math.floor(this.positionSec);
    this.active = false;
    this.#autoPaused = false;
    this.#pendingJump = null;
    this.#dropPrefetch();
    this.#clearNextTimer();
    this.#loading?.abort();
    this.#loading = null;
    this.audio.stop(true);
    this.#current?.cleanup();
    this.#current = null;
    this.emit('idle');
    this.emit('change');
  }

  /** Stops playback and clears the whole queue. */
  stop() {
    this.tracks = [];
    this.index = 0;
    this.#resumeAt = 0;
    this.#pendingJump = null;
    this.#dropPrefetch();
    this.#clearNextTimer();
    this.#loading?.abort();
    this.#loading = null;
    if (this.audio.state.status !== AudioPlayerStatus.Idle) {
      this.#suppressEnd = true;
      this.audio.stop(true);
    }
    this.#current?.cleanup();
    this.#current = null;
    this.emit('idle');
    this.emit('change');
  }

  skip() {
    if (this.isIdle) return false;
    if (this.#nextTimer && !this.#loading && this.audio.state.status === AudioPlayerStatus.Idle) {
      // Already moved on and waiting (e.g. failure backoff): play that next track right away.
      this.#failures = 0;
      this.#jump(this.index);
      return true;
    }
    this.#jump(this.index + 1);
    return true;
  }

  previous() {
    if (this.index === 0) return false;
    this.#jump(this.index - 1);
    return true;
  }

  /** `n` is 1-based within Up Next. */
  skipTo(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.upcoming.length) return false;
    this.#jump(this.index + n);
    return true;
  }

  /** Re-opens the current track at the same spot so a new sound profile takes effect right away. */
  reapplyAudio() {
    if (!this.nowPlaying || this.nowPlaying.live) return false;
    const wasPaused = this.isPaused;
    this.seek(this.positionSec);
    if (wasPaused) this.once('trackStart', () => this.pause());
    return true;
  }

  /** Restarts the current track at `seconds` (used by resume and, later, cseek). */
  seek(seconds) {
    if (!this.nowPlaying) return false;
    this.#jump(this.index, Math.max(0, Math.floor(seconds)));
    return true;
  }

  pause() {
    this.#autoPaused = false;
    const ok = this.audio.pause();
    if (ok) this.emit('change');
    return ok;
  }

  resume() {
    this.#autoPaused = false;
    const ok = this.audio.unpause();
    if (ok) this.emit('change');
    return ok;
  }

  /** Pauses because nobody is listening. Undone by autoResume() or a manual resume. */
  autoPause() {
    if (this.audio.state.status !== AudioPlayerStatus.Playing) return;
    if (this.audio.pause()) {
      this.#autoPaused = true;
      log.info('Nobody is listening; paused.');
      this.emit('change');
    }
  }

  autoResume() {
    if (!this.#autoPaused) return;
    this.#autoPaused = false;
    if (this.audio.unpause()) {
      log.info('Listener is back; resumed.');
      this.emit('change');
    }
  }

  // ---------- persistence ----------

  snapshot() {
    return {
      tracks: this.tracks,
      index: this.index,
      position: Math.floor(this.positionSec),
      loop: this.loop,
    };
  }

  restore(snap) {
    if (!Array.isArray(snap?.tracks)) return;
    this.tracks = snap.tracks.slice(0, MAX_QUEUE);
    this.index = Math.min(Math.max(0, snap.index | 0), this.tracks.length);
    this.#resumeAt = Math.max(0, snap.position | 0);
    this.loop = LOOP_MODES.includes(snap.loop) ? snap.loop : 'off';
  }

  // ---------- internals ----------

  #clearNextTimer() {
    clearTimeout(this.#nextTimer);
    this.#nextTimer = null;
  }

  #jump(index, seekSec = 0) {
    this.#clearNextTimer();
    this.#failures = 0;
    if (this.audio.state.status !== AudioPlayerStatus.Idle) {
      this.#pendingJump = { index, seekSec };
      this.audio.stop(true); // -> Idle -> #onTrackEnd applies the jump
      return;
    }
    this.#loading?.abort();
    this.#loading = null;
    this.index = index;
    this.#resumeAt = seekSec;
    this.emit('change');
    if (this.active) this.#playCurrent();
  }

  #onTrackEnd(resource) {
    this.#current?.cleanup();
    this.#current = null;

    if (this.#suppressEnd) {
      this.#suppressEnd = false;
      return;
    }
    if (this.#pendingJump) {
      const { index, seekSec } = this.#pendingJump;
      this.#pendingJump = null;
      this.index = index;
      this.#resumeAt = seekSec;
      this.emit('change');
      if (this.active) this.#playCurrent();
      return;
    }
    if (!this.active) return;

    const playedMs = resource?.playbackDuration ?? 0;
    if (playedMs >= MIN_HEALTHY_PLAYBACK_MS) {
      this.#failures = 0;
      this.#advance(true);
    } else {
      this.#failures++;
      log.warn(`Track ended after ${playedMs}ms; treating it as a failed stream.`);
      this.#advance(false);
    }
  }

  /** Moves to the next track. `natural` = the song finished by itself (song loop applies). */
  #advance(natural) {
    this.index = natural && this.loop === 'song' ? this.index : this.index + 1;

    let delay = this.#failures ? 1000 : 0;
    if (this.#failures >= MAX_CONSECUTIVE_FAILURES) {
      log.warn(`${this.#failures} tracks failed in a row; waiting ${FAILURE_BACKOFF_MS / 1000}s before trying again.`);
      this.#failures = 0;
      delay = FAILURE_BACKOFF_MS;
    }
    this.emit('change');
    this.#clearNextTimer();
    this.#nextTimer = setTimeout(() => {
      this.#nextTimer = null;
      this.#playCurrent();
    }, delay);
  }

  #trimHistory() {
    if (this.loop === 'queue' || this.index <= MAX_HISTORY) return;
    const drop = this.index - MAX_HISTORY;
    this.tracks.splice(0, drop);
    this.index -= drop;
  }

  /**
   * Turns playlist.txt search phrases into a URL (cached after the first time).
   * Links need nothing here: the streaming yt-dlp run fills in title, artist and length.
   */
  async #prepare(track, signal) {
    if (!track.query || track.url) return;
    const info = await this.resolver.resolve(track.query, signal);
    if (track.source === 'spotify') {
      // Keep Spotify's clean title/artist/length; only borrow the playable URL (and a cover if missing).
      track.url = info.url;
      track.thumbnail ??= info.thumbnail ?? null;
      return;
    }
    Object.assign(track, {
      title: info.title,
      url: info.url,
      duration: info.duration ?? null,
      thumbnail: info.thumbnail ?? null,
      author: info.author ?? null,
    });
  }

  // ---------- preloading the next song ----------

  /** Starts loading the next song a few seconds after the current one starts. */
  #schedulePrefetch(delayMs = 3_000) {
    clearTimeout(this.#prefetchTimer);
    this.#prefetchTimer = setTimeout(() => this.#startPrefetch(), delayMs);
    this.#prefetchTimer.unref();
  }

  #startPrefetch() {
    if (!this.active || !this.nowPlaying || this.loop === 'song') return;
    // Never let the next song's download compete with the current one on a slow connection.
    if (!this.#currentDownloaded) return;
    const next = this.tracks[this.index + 1] ?? (this.loop === 'queue' ? this.tracks[0] : null);
    if (!next || next.live || next === this.nowPlaying) return;

    const audioOptions = this.getAudioOptions();
    const key = JSON.stringify(audioOptions);
    if (this.#prefetch?.track === next && this.#prefetch.key === key) return;
    this.#dropPrefetch();

    const controller = new AbortController();
    const entry = { track: next, key, controller, promise: null };
    entry.promise = (async () => {
      await this.#prepare(next, controller.signal);
      return createTrackResource(next, { ...audioOptions, signal: controller.signal });
    })();
    entry.promise.catch((err) => {
      if (!controller.signal.aborted) log.debug(`Preload of "${next.title}" failed: ${err.message}`);
    });
    this.#prefetch = entry;
    log.debug(`Preloading "${next.title}".`);
  }

  /** Returns the preload for `track` if it matches, otherwise discards any preload. */
  #takePrefetch(track, audioOptions, seekSec) {
    const p = this.#prefetch;
    if (!p) return null;
    if (p.track !== track || seekSec > 0 || p.key !== JSON.stringify(audioOptions)) {
      this.#dropPrefetch();
      return null;
    }
    this.#prefetch = null;
    return p;
  }

  #dropPrefetch() {
    clearTimeout(this.#prefetchTimer);
    const p = this.#prefetch;
    this.#prefetch = null;
    if (!p) return;
    p.controller.abort();
    p.promise.then((loaded) => loaded.cleanup(), () => {});
  }

  async #playCurrent() {
    this.#clearNextTimer();
    if (!this.active) return;

    this.#loading?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    this.#loading = controller;

    try {
      if (this.index >= this.tracks.length) {
        if (this.loop === 'queue' && this.tracks.length) {
          this.index = 0;
        } else {
          const more = (await this.onQueueEnd?.()) ?? [];
          if (signal.aborted) return;
          if (!more.length) {
            this.#loading = null;
            this.emit('idle');
            this.emit('change');
            return;
          }
          this.tracks.push(...more.slice(0, MAX_QUEUE));
        }
      }
      this.#trimHistory();

      const track = this.tracks[this.index];
      const seekSec = this.#resumeAt;
      this.#resumeAt = 0;
      const loadStarted = Date.now();
      const audioOptions = this.getAudioOptions();

      // Use the preloaded copy of this song if there is one (skip feels instant).
      let loaded = null;
      const pre = this.#takePrefetch(track, audioOptions, seekSec);
      if (pre) {
        signal.addEventListener('abort', () => pre.controller.abort(), { once: true });
        loaded = await pre.promise.catch(() => null);
        if (loaded) log.debug(`Using preloaded "${track.title}".`);
      }
      if (!loaded) {
        signal.throwIfAborted();
        await this.#prepare(track, signal);
        signal.throwIfAborted();
        loaded = await createTrackResource(track, { ...audioOptions, seekSec, signal });
      }
      if (signal.aborted || !this.active) {
        loaded.cleanup();
        return;
      }
      this.#loading = null;
      this.lastLoadMs = Date.now() - loadStarted;
      this.#current = { ...loaded, audioOptions };
      this.#seekBase = seekSec;
      this.audio.play(loaded.resource);
      log.info(`Now playing: ${track.title}${loaded.passthrough ? '' : ' (ffmpeg)'}`);
      this.emit('trackStart', track);
      this.emit('change');

      // Preload the next song only after this one is fully downloaded (or after 2 minutes at most).
      this.#currentDownloaded = false;
      const current = this.#current;
      const waitLimit = new Promise((resolve) => setTimeout(resolve, 120_000).unref());
      Promise.race([loaded.downloadDone ?? Promise.resolve(), waitLimit]).then(() => {
        if (this.#current !== current) return;
        this.#currentDownloaded = true;
        log.debug(`"${track.title}" fully downloaded.`);
        this.#schedulePrefetch(1_000);
      });
    } catch (err) {
      if (signal.aborted) return;
      this.#loading = null;
      const track = this.tracks[this.index];
      if (track?.query) this.resolver.forget(track.query);
      this.#failures++;
      log.warn(`Skipping "${track?.title ?? 'unknown'}": ${err.message}`);
      this.emit('trackError', track, err);
      this.#advance(false);
    }
  }
}
