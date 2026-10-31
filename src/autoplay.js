// Smart autoplay: when the queue is about to run out, add a similar song from YouTube's Mix
// for the current song. It avoids repeats, skips compilations/covers, and learns from quick skips.
//
// The next pick is added while the current song is still playing (not after it ends),
// so the player can preload it and the change of song is seamless.
import { log } from './logger.js';
import { searchTracks, fetchMix, youtubeId } from './ytdlp.js';
import { makeTrack } from './sources.js';

const HISTORY_SIZE = 50;
const MIX_CACHE_SIZE = 30;
const MIX_CACHE_TTL_MS = 30 * 60_000;
const QUICK_SKIP_SEC = 30;
const DISLIKE_MS = 2 * 60 * 60_000;
const MIN_SEC = 90;
const MAX_SEC = 600; // longer than 10 min is usually a jukebox or album upload
const PICK_FROM_TOP = 5; // random among the most relevant few, for variety
const RETRY_AFTER_FAIL_MS = 60_000;

// Uploads that aren't one clean song.
const NOT_A_SONG =
  /\b(jukebox|nonstop|non-stop|mashup|full album|top\s*\d+|best of|\d+\s*(hours?|hrs?)\b|compilation|playlist|karaoke|reaction|slowed|reverb|8d|sped up|ringtone|status)\b/i;
const NOISE = /\b(official|video|audio|lyrics?|lyrical|full song|music video|hd|4k|remaster(ed)?|visualizer)\b/gi;

/** Comparable song name: "Tum Hi Ho (Official Video) | Aashiqui 2" -> "tumhiho". */
export function songKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .split(/\s[|•]\s/)[0]
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const artistKey = (s) => String(s ?? '').toLowerCase().replace(/\s+-\s+topic$/, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Moods for `cvibe`: a search that finds a good first song; autoplay keeps the mood going. */
export const VIBES = {
  chill: { emoji: '🌙', search: 'chill lofi hindi songs' },
  romantic: { emoji: '💕', search: 'romantic hindi songs' },
  sad: { emoji: '🥀', search: 'sad hindi songs' },
  party: { emoji: '🎉', search: 'bollywood party songs' },
  gym: { emoji: '💪', search: 'gym workout motivation songs' },
  punjabi: { emoji: '🎺', search: 'punjabi hit songs' },
  telugu: { emoji: '🎬', search: 'telugu hit songs' },
  tamil: { emoji: '🥁', search: 'tamil hit songs' },
  english: { emoji: '🎸', search: 'english pop hits' },
  focus: { emoji: '🎧', search: 'instrumental focus music' },
};

export class Autoplay {
  #recentIds = [];
  #recentKeys = [];
  #disliked = new Map(); // artistKey -> expiry time
  #mixCache = new Map(); // videoId -> { entries, at }
  #busy = null;
  #failedAt = 0;

  constructor(session, settings) {
    this.session = session;
    this.settings = settings;

    session.on('trackStart', (track) => {
      this.#remember(track);
      this.#topUp();
    });
    session.on('skip', (track, playedSec) => this.#learn(track, playedSec));
    session.on('change', () => this.#topUp());
  }

  /** Turns autoplay on or off and saves the choice. Turning it off removes queued picks. */
  setEnabled(on) {
    const s = this.session;
    s.autoplay = on;
    this.settings.data.autoplay = on;
    this.settings.save();
    if (!on) {
      const before = s.tracks.length;
      s.tracks = s.tracks.filter((t, i) => i <= s.index || !t.autoplay);
      if (s.tracks.length !== before) log.info(`Autoplay off: removed ${before - s.tracks.length} queued pick(s).`);
    }
    s.emit('change'); // also triggers #topUp when turned on
    return on;
  }

  /**
   * Picks the next similar song. Returns [] if there's nothing to base it on or nothing fits.
   * Never throws; only one lookup runs at a time.
   */
  next() {
    this.#busy ??= this.#pick()
      .catch((err) => {
        log.warn(`Autoplay lookup failed: ${err.message}`);
        return [];
      })
      .then((picks) => {
        if (!picks.length) this.#failedAt = Date.now();
        return picks;
      })
      .finally(() => {
        this.#busy = null;
      });
    return this.#busy;
  }

  /** First song for a vibe (cvibe): a random pick from the top results of the vibe's search. */
  async vibeSeed(name, requester) {
    const vibe = VIBES[name];
    const results = (await searchTracks(vibe.search, 8)).filter((r) => this.#acceptable(r));
    if (!results.length) return null;
    const pick = results[Math.floor(Math.random() * Math.min(PICK_FROM_TOP, results.length))];
    return makeTrack(pick, requester);
  }

  // ---------- internals ----------

  /** While the last queued song plays, queue one similar song so it can be preloaded. */
  #topUp() {
    const s = this.session;
    if (!s.autoplay || s.loop !== 'off' || !s.nowPlaying || s.upcoming.length || this.#busy) return;
    if (Date.now() - this.#failedAt < RETRY_AFTER_FAIL_MS) return; // don't hammer YouTube after a miss
    this.next().then((picks) => {
      // Re-check: the queue may have changed while we were looking.
      if (picks.length && s.autoplay && s.loop === 'off' && s.nowPlaying && !s.upcoming.length) {
        log.info(`Autoplay queued: ${picks[0].title}`);
        s.add(picks);
      }
    });
  }

  async #pick() {
    const seeds = this.#seeds();
    for (const seed of seeds) {
      const entries = await this.#mix(seed);
      const fresh = entries.filter((e) => this.#acceptable(e));
      if (!fresh.length) continue;
      const pick = fresh[Math.floor(Math.random() * Math.min(PICK_FROM_TOP, fresh.length))];
      return [{ ...makeTrack(pick, null), autoplay: true }];
    }
    return [];
  }

  /** Video IDs to base the pick on: the current song first, then recent ones. */
  #seeds() {
    const current = youtubeId(this.session.nowPlaying?.url ?? this.session.tracks[this.session.index - 1]?.url);
    const ids = [current, ...this.#recentIds.slice().reverse()].filter(Boolean);
    return [...new Set(ids)].slice(0, 3);
  }

  async #mix(videoId) {
    const hit = this.#mixCache.get(videoId);
    if (hit && Date.now() - hit.at < MIX_CACHE_TTL_MS) return hit.entries;
    const entries = await fetchMix(videoId);
    this.#mixCache.set(videoId, { entries, at: Date.now() });
    if (this.#mixCache.size > MIX_CACHE_SIZE) this.#mixCache.delete(this.#mixCache.keys().next().value);
    return entries;
  }

  #acceptable(entry) {
    const id = youtubeId(entry.url);
    if (!id || this.#recentIds.includes(id)) return false;
    if (this.#recentKeys.includes(songKey(entry.title))) return false; // same song, other upload
    if (NOT_A_SONG.test(entry.title ?? '')) return false;
    if (entry.duration && (entry.duration < MIN_SEC || entry.duration > MAX_SEC)) return false;
    const now = Date.now();
    for (const [artist, until] of this.#disliked) {
      if (until < now) this.#disliked.delete(artist);
      else if (artistKey(entry.author) === artist || artistKey(entry.title).includes(artist)) return false;
    }
    return true;
  }

  #remember(track) {
    const id = youtubeId(track.url);
    if (id) this.#recentIds.push(id);
    this.#recentKeys.push(songKey(track.title));
    if (this.#recentIds.length > HISTORY_SIZE) this.#recentIds.shift();
    if (this.#recentKeys.length > HISTORY_SIZE) this.#recentKeys.shift();
  }

  /** Skipping an autoplay pick in its first 30 s means "not this artist" for 2 hours. */
  #learn(track, playedSec) {
    if (!track?.autoplay || playedSec >= QUICK_SKIP_SEC) return;
    const artist = artistKey(track.author);
    if (artist.length < 3) return; // too short to match safely
    this.#disliked.set(artist, Date.now() + DISLIKE_MS);
    log.info(`Autoplay: avoiding ${track.author} for 2 hours (skipped quickly).`);
  }
}
