// Listening stats for chistory, ctop and cwrapped. A song counts as played once it has been
// heard for 30 s (or half of it, for very short songs); skips before that don't count.
// Saved in data/stats.json as { songs: { key: track }, plays: [{ k, at, s }] }, oldest play first.
import { detectLanguage } from './language.js';
import { storedTrack, trackKey } from './library.js';

const COUNT_AFTER_SEC = 30;
const TICK_SEC = 5;
const MAX_PLAYS = 20_000; // roughly a year of daily listening; the oldest plays are dropped
const DAY_MS = 86_400_000;

/** Period name -> days (null = all time). */
export const PERIODS = { today: 1, week: 7, month: 30, year: 365, all: null };

// Channels that upload many artists' songs; their name says nothing about the artist.
const LABELS =
  /^(t-?series|saregama|zee music|sony music|tips|yrf|speed records|white hill|desi melodies|eros now|times music|aditya music|lahari|think music|sun tv|goldmines|venus|shemaroo|ultra|ncs|nocopyrightsounds)\b/i;

/** Main artist for stats: "Arijit Singh, Pritam" -> "Arijit Singh"; label uploads use "Artist - Song" titles. */
export function mainArtist(track) {
  const split = (s) => s.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?)\s*/i)[0].trim();
  const author = String(track?.author ?? '').replace(/\s+-\s+topic$/i, '').replace(/vevo$/i, '').trim();
  if (author && !LABELS.test(author)) return split(author);
  const dash = String(track?.title ?? '').match(/^(.{2,40}?)\s+-\s+/);
  return dash ? split(dash[1]) : null;
}

export class Stats {
  #current = null; // { key, listened, entry } for the song playing now

  /** @param store JsonStore for data/stats.json */
  constructor(session, store) {
    this.session = session;
    this.store = store;
    session.on('trackStart', (track) => {
      this.#current = { key: trackKey(track), listened: 0, entry: null };
    });
    setInterval(() => this.#tick(), TICK_SEC * 1000).unref();
  }

  get #data() {
    const d = this.store.data;
    d.songs ??= {};
    d.plays ??= [];
    return d;
  }

  /** Every few seconds: add listening time to the song playing now, and count it once it passes 30 s. */
  #tick() {
    const c = this.#current;
    if (!c) return;
    const s = this.session;
    const track = s.nowPlaying;
    if (!track || trackKey(track) !== c.key) {
      this.#current = null;
      return;
    }
    if (s.isPaused) return;

    c.listened += TICK_SEC;
    if (c.entry) {
      c.entry.s = c.listened; // saved with the next counted play (or on shutdown)
      return;
    }
    const needed = track.duration ? Math.min(COUNT_AFTER_SEC, track.duration / 2) : COUNT_AFTER_SEC;
    if (c.listened < needed) return;

    const data = this.#data;
    c.entry = { k: c.key, at: Date.now(), s: c.listened };
    data.plays.push(c.entry);
    data.songs[c.key] = storedTrack(track);
    if (data.plays.length > MAX_PLAYS) {
      data.plays.splice(0, data.plays.length - MAX_PLAYS);
      const used = new Set(data.plays.map((p) => p.k));
      for (const k of Object.keys(data.songs)) if (!used.has(k)) delete data.songs[k];
    }
    this.store.save(5_000);
  }

  /** Plays since `days` ago (all if null), oldest first. */
  #plays(days) {
    const plays = this.#data.plays;
    if (!days) return plays;
    const cutoff = Date.now() - days * DAY_MS;
    let lo = 0;
    let hi = plays.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (plays[mid].at < cutoff) lo = mid + 1;
      else hi = mid;
    }
    return plays.slice(lo);
  }

  /** The last `limit` counted plays, newest first: [{ track, at }]. */
  recent(limit) {
    const { plays, songs } = this.#data;
    return plays
      .slice(-limit)
      .reverse()
      .map((p) => ({ track: songs[p.k], at: p.at }))
      .filter((r) => r.track);
  }

  /**
   * Totals and rankings for a period:
   * { plays, seconds, unique, songs: [{ track, count, seconds }], artists: [{ name, count, seconds }], languages: [{ name, count }], since }
   */
  summary(days) {
    const { songs } = this.#data;
    const plays = this.#plays(days);
    const bySong = new Map();
    const byArtist = new Map();
    const byLanguage = new Map();
    let seconds = 0;
    for (const p of plays) {
      const track = songs[p.k];
      if (!track) continue;
      seconds += p.s;
      const song = bySong.get(p.k) ?? { track, count: 0, seconds: 0 };
      song.count++;
      song.seconds += p.s;
      bySong.set(p.k, song);
    }
    // Artists and languages per song (not per play), so detection runs once per song.
    for (const song of bySong.values()) {
      const name = mainArtist(song.track);
      if (name) {
        const key = name.toLowerCase();
        const artist = byArtist.get(key) ?? { name, count: 0, seconds: 0 };
        artist.count += song.count;
        artist.seconds += song.seconds;
        byArtist.set(key, artist);
      }
      const lang = detectLanguage(song.track);
      if (lang) byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + song.count);
    }
    const rank = (list) => list.sort((a, b) => b.count - a.count || b.seconds - a.seconds);
    return {
      plays: plays.length,
      seconds,
      unique: bySong.size,
      songs: rank([...bySong.values()]),
      artists: rank([...byArtist.values()]),
      languages: [...byLanguage].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      since: plays[0]?.at ?? null,
    };
  }
}
