// Smart autoplay: when the queue is about to run out, add a similar song from YouTube's Mix
// for the current song. It avoids repeats and compilations, and stays in the same language.
//
// The next pick is added while the current song is still playing (not after it ends),
// so the player can preload it and the change of song is seamless.
import { detectLanguage } from './language.js';
import { log } from './logger.js';
import { makeTrack } from './sources.js';
import { fetchMix, searchTracks, youtubeId } from './ytdlp.js';

const HISTORY_SIZE = 50; // in-memory list used to pick Mix seeds and the language
const NO_REPEAT_MS = 48 * 60 * 60_000; // autoplay never picks a song played in the last 2 days
const HISTORY_MAX_ENTRIES = 5000;
const LANGUAGE_WINDOW = 3; // the language of the last few known songs decides
const MIX_CACHE_SIZE = 30;
const MIX_CACHE_TTL_MS = 30 * 60_000;
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

/** Moods for `cvibe`: a search for the first song, and the language autoplay should stick to. */
export const VIBES = {
  chill: { emoji: '🌙', search: 'chill lofi hindi songs', language: 'hindi' },
  romantic: { emoji: '💕', search: 'romantic hindi songs', language: 'hindi' },
  sad: { emoji: '🥀', search: 'sad hindi songs', language: 'hindi' },
  party: { emoji: '🎉', search: 'bollywood party songs', language: 'hindi' },
  gym: { emoji: '💪', search: 'gym workout motivation songs', language: null },
  punjabi: { emoji: '🎺', search: 'punjabi hit songs', language: 'punjabi' },
  telugu: { emoji: '🎬', search: 'telugu hit songs', language: 'telugu' },
  tamil: { emoji: '🥁', search: 'tamil hit songs', language: 'tamil' },
  english: { emoji: '🎸', search: 'english pop hits', language: 'english' },
  focus: { emoji: '🎧', search: 'instrumental focus music', language: null },
};

export class Autoplay {
  #recentIds = [];
  #recentLanguages = []; // detected language of played songs (null = unknown)
  #lockedLanguage = null; // set by cvibe; cleared when someone requests a song
  #mixCache = new Map(); // key -> { entries, at }
  #busy = null;
  #failedAt = 0;

  /**
   * @param history JsonStore of { played: { "id:<videoId>" | "key:<songKey>": timestamp } }.
   * Saved to disk, so the 2-day no-repeat rule survives restarts.
   */
  constructor(session, settings, history) {
    this.session = session;
    this.settings = settings;
    this.history = history;

    session.on('trackStart', (track) => {
      // A song someone asked for sets the direction again (a vibe seed keeps its lock).
      if (!track.autoplay && !track.vibe) this.#lockedLanguage = null;
      this.#remember(track);
      this.#topUp();
    });
    session.on('change', () => this.#topUp());
  }

  /** The language autoplay is following right now, or null if it isn't sure. */
  get language() {
    if (this.#lockedLanguage) return this.#lockedLanguage;
    const known = this.#recentLanguages.filter(Boolean).slice(-LANGUAGE_WINDOW);
    if (!known.length) return null;
    const counts = {};
    for (const lang of known) counts[lang] = (counts[lang] ?? 0) + 1;
    // Most common; ties go to the most recent song.
    return known.reduceRight((best, lang) => (counts[lang] > (counts[best] ?? 0) ? lang : best), known.at(-1));
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

  /** First song for a vibe (cvibe). Also locks autoplay to the vibe's language. */
  async vibeSeed(name, requester) {
    const vibe = VIBES[name];
    const results = (await searchTracks(vibe.search, 8)).filter((r) => this.#acceptable(r));
    if (!results.length) return null;
    this.#lockedLanguage = vibe.language;
    const pick = results[Math.floor(Math.random() * Math.min(PICK_FROM_TOP, results.length))];
    return { ...makeTrack(pick, requester), vibe: name };
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
        const lang = detectLanguage(picks[0]);
        log.info(`Autoplay queued: ${picks[0].title}${lang ? ` [${lang}]` : ''}`);
        s.add(picks);
      }
    });
  }

  async #pick() {
    const language = this.language;

    // 1. Mixes of the current and recent songs, same-language picks first.
    for (const seed of this.#seeds()) {
      const pick = this.#choose(await this.#cached(seed, () => fetchMix(seed)), language);
      if (pick) return [pick];
    }

    // 2. The Mixes only had other languages: search for songs in this language instead.
    if (language) {
      const query = Object.values(VIBES).find((v) => v.language === language)?.search ?? `${language} hit songs`;
      const pick = this.#choose(await this.#cached(`search:${language}`, () => searchTracks(query, 15)), language);
      if (pick) {
        log.info(`Autoplay: the Mix drifted away from ${language}; picked from a ${language} search.`);
        return [pick];
      }
    }
    return [];
  }

  /**
   * Chooses one entry: songs detected as the same language first, then songs of unknown language.
   * Songs clearly in another language are never picked while a language is known.
   */
  #choose(entries, language) {
    const fresh = entries.filter((e) => this.#acceptable(e));
    let pool = fresh;
    if (language) {
      const same = [];
      const unknown = [];
      for (const e of fresh) {
        const lang = detectLanguage(e);
        if (lang === language) same.push(e);
        else if (!lang) unknown.push(e);
      }
      pool = [...same, ...unknown];
    }
    if (!pool.length) return null;
    const pick = pool[Math.floor(Math.random() * Math.min(PICK_FROM_TOP, pool.length))];
    return { ...makeTrack(pick, null), autoplay: true };
  }

  /** Video IDs to base the pick on: the current song first, then recent ones. */
  #seeds() {
    const current = youtubeId(this.session.nowPlaying?.url ?? this.session.tracks[this.session.index - 1]?.url);
    const ids = [current, ...this.#recentIds.slice().reverse()].filter(Boolean);
    return [...new Set(ids)].slice(0, 3);
  }

  async #cached(key, load) {
    const hit = this.#mixCache.get(key);
    if (hit && Date.now() - hit.at < MIX_CACHE_TTL_MS) return hit.entries;
    const entries = await load();
    this.#mixCache.set(key, { entries, at: Date.now() });
    if (this.#mixCache.size > MIX_CACHE_SIZE) this.#mixCache.delete(this.#mixCache.keys().next().value);
    return entries;
  }

  get #played() {
    return (this.history.data.played ??= {});
  }

  /** True if this song (any upload of it) was played in the last 2 days. */
  #playedRecently(id, key) {
    const cutoff = Date.now() - NO_REPEAT_MS;
    return (id && this.#played[`id:${id}`] > cutoff) || (key && this.#played[`key:${key}`] > cutoff);
  }

  #acceptable(entry) {
    const id = youtubeId(entry.url);
    if (!id) return false;
    if (this.#playedRecently(id, songKey(entry.title))) return false; // same song or another upload of it
    if (NOT_A_SONG.test(entry.title ?? '')) return false;
    if (entry.duration && (entry.duration < MIN_SEC || entry.duration > MAX_SEC)) return false;
    return true;
  }

  #remember(track) {
    const id = youtubeId(track.url);
    const key = songKey(track.title);
    const now = Date.now();
    const played = this.#played;
    if (id) played[`id:${id}`] = now;
    if (key) played[`key:${key}`] = now;

    // Drop entries older than 2 days, and cap the file size.
    const cutoff = now - NO_REPEAT_MS;
    for (const k of Object.keys(played)) if (played[k] < cutoff) delete played[k];
    const keys = Object.keys(played);
    for (let n = 0; n < keys.length - HISTORY_MAX_ENTRIES; n++) delete played[keys[n]];
    this.history.save(5_000);

    if (id) this.#recentIds.push(id);
    this.#recentLanguages.push(detectLanguage(track));
    for (const list of [this.#recentIds, this.#recentLanguages]) {
      if (list.length > HISTORY_SIZE) list.shift();
    }
  }
}
