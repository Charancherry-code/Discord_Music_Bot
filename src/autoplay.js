// Smart autoplay: when the queue is about to run out, add a similar song. Candidates come from
// YouTube's Mix and YouTube Music's song radio, then are scored: same language first, clean audio
// uploads over music videos, a little artist variety. No repeats for 2 days, no compilations.
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
const PICK_FROM_TOP = 3; // random among the best-scored few, for variety
const RETRY_AFTER_FAIL_MS = 60_000;
const SAME_ARTIST_WINDOW = 2; // soft penalty for an artist heard in the last 2 songs

// Uploads that aren't one clean song.
const NOT_A_SONG =
  /\b(jukebox|nonstop|non-stop|mashup|full album|top\s*\d+|best of|\d+\s*(hours?|hrs?)\b|compilation|playlist|karaoke|reaction|slowed|reverb|8d|sped up|ringtone|status|cover|bass ?boosted)\b/i;
// Video-style uploads: often start with dialogue or a long intro, so the plain audio upload is preferred.
const VIDEO_STYLE =
  /\b(full video|full song|video song|official (music )?video|music video|lyrical|lyric video|lyrics video|teaser|trailer|promo|4k|8k|hd video)\b/i;
const NOISE = /\b(official|video|audio|lyrics?|lyrical|full song|music video|video song|hd|4k|8k|remaster(ed)?|visualizer|title (song|track))\b/gi;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+-\s+topic$/, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Main artist of an upload: "Arijit Singh, Pritam" -> "arijitsingh"; for "The Weeknd - X" titles, "theweeknd". */
function artistKey(entry) {
  const dash = String(entry?.title ?? '').match(/^(.{2,40}?)\s+-\s+/);
  const name = String(entry?.author ?? '').split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?)\s*/i)[0] || dash?.[1];
  return norm(name).replace(/vevo$/, '');
}

/**
 * Comparable song name, the same for every upload of a song:
 * "Tum Hi Ho (Official Video) | Aashiqui 2" -> "tumhiho",
 * "The Weeknd - Blinding Lights (Official Video)" -> "blindinglights",
 * "Lyrical: Tum Hi Aana | Marjaavaan" -> "tumhiaana".
 */
export function songKey(title, author) {
  let t = String(title ?? '').replace(/^\s*(lyrical|lyrics|full video)\s*:\s*/i, '');
  const quoted = t.match(/^\s*"([^"]{2,60})"/); // "Kabira Full Song" Yeh Jawaani Hai Deewani
  if (quoted) t = quoted[1];
  t = t.split(/\s[|•]\s/)[0];
  // "Artist - Song": drop the artist part when it names the uploader, or when the title has one dash.
  const dash = t.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash) {
    const left = norm(dash[1]);
    const a = norm(author);
    if (!a || left.includes(a) || a.includes(left) || !dash[2].includes(' - ')) t = dash[2];
  }
  return t
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // "Chahun Main Ya Naa Full Video Song Aashiqui 2": the movie name follows the label.
    .replace(/\s(full video song|full video|video song|full song|title (song|track))\b.*$/, '')
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/\b(ft|feat|featuring)\b\.?.*$/i, ' ')
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

/** [a1, a2, ...] + [b1, b2, ...] -> [a1, b1, a2, b2, ...], so both lists' best picks rank first. */
function interleave(lists) {
  const out = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
    for (const list of lists) if (list[i]) out.push(list[i]);
  }
  return out;
}

export class Autoplay {
  #recentIds = [];
  #recentLanguages = []; // detected language of played songs (null = unknown)
  #recentArtists = [];
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

  /**
   * Finds the next song. Each step runs only if the one before found nothing usable:
   *   1. YouTube's Mix + YouTube Music radio of the current song (fetched in parallel)
   *   2. the same for the last two songs
   *   3. more songs by the current artist
   *   4. a search for hit songs in the current language
   */
  async #pick() {
    const language = this.language;
    const sources = [];
    for (const seed of this.#seeds()) {
      sources.push({
        label: 'mix',
        load: async () => {
          const [mix, radio] = await Promise.allSettled([
            this.#cached(`mix:${seed}`, () => fetchMix(seed, 'mix')),
            this.#cached(`radio:${seed}`, () => fetchMix(seed, 'radio')),
          ]);
          const lists = [mix, radio].filter((r) => r.status === 'fulfilled').map((r) => r.value);
          if (!lists.length) throw mix.reason ?? radio.reason;
          return interleave(lists);
        },
      });
    }
    const artist = this.session.nowPlaying?.author?.replace(/\s+-\s+topic$/i, '').split(/\s*,\s*/)[0];
    if (artist) sources.push({ label: `${artist} search`, load: () => this.#cached(`artist:${norm(artist)}`, () => searchTracks(`${artist} songs`, 15)) });
    if (language) {
      const query = Object.values(VIBES).find((v) => v.language === language)?.search ?? `${language} hit songs`;
      sources.push({ label: `${language} search`, load: () => this.#cached(`lang:${language}`, () => searchTracks(query, 15)) });
    }

    let lastError = null;
    for (const [i, source] of sources.entries()) {
      let entries;
      try {
        entries = await source.load();
      } catch (err) {
        lastError = err;
        continue; // one failed source shouldn't stop autoplay
      }
      const pick = this.#choose(entries, language);
      if (pick) {
        if (i > 0) log.info(`Autoplay: used the ${source.label} (earlier sources had nothing new).`);
        return [pick];
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  /**
   * Scores every usable entry and picks randomly among the best few.
   * Never picks a song clearly in another language while a language is known.
   */
  #choose(entries, language) {
    const recentArtists = this.#recentArtists.slice(-SAME_ARTIST_WINDOW);
    const scored = [];
    const seen = new Set();
    for (const [rank, e] of entries.entries()) {
      if (!this.#acceptable(e)) continue;
      const key = songKey(e.title, e.author);
      if (key && seen.has(key)) continue; // the same song listed twice (video + audio upload)
      if (key) seen.add(key);

      const lang = detectLanguage(e);
      if (language && lang && lang !== language) continue;

      let score = rank; // YouTube's order is the base: lower is better
      if (language && lang === language) score -= 8;
      if (VIDEO_STYLE.test(e.title ?? '')) score += 6; // prefer clean audio uploads
      if (/\s-\s+topic$/i.test(e.author ?? '') || /\((official )?audio\)/i.test(e.title ?? '')) score -= 3;
      const artist = artistKey(e);
      if (artist && recentArtists.includes(artist)) score += 5; // some variety, never a hard block
      scored.push({ e, score });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => a.score - b.score);
    const { e } = scored[Math.floor(Math.random() * Math.min(PICK_FROM_TOP, scored.length))];
    return { ...makeTrack(e, null), autoplay: true };
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
    if (this.#playedRecently(id, songKey(entry.title, entry.author))) return false; // same song or another upload of it
    if (NOT_A_SONG.test(entry.title ?? '')) return false;
    if (entry.duration && (entry.duration < MIN_SEC || entry.duration > MAX_SEC)) return false;
    return true;
  }

  #remember(track) {
    const id = youtubeId(track.url);
    const key = songKey(track.title, track.author);
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
    this.#recentArtists.push(artistKey(track));
    for (const list of [this.#recentIds, this.#recentLanguages, this.#recentArtists]) {
      if (list.length > HISTORY_SIZE) list.shift();
    }
  }
}
