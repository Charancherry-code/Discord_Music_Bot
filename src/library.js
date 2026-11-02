// Saved playlists (shared, csave/cload) and liked songs (one list per user, ❤️ button / clike).
// Everything lives in data/library.json.
import { songKey } from './autoplay.js';
import { makeTrack, UserError } from './sources.js';
import { youtubeId } from './ytdlp.js';

const MAX_PLAYLISTS = 50;
const MAX_PLAYLIST_SONGS = 500;
const MAX_LIKED = 2000;
const NAME_RE = /^[\p{L}\p{N} _\-'.!&]{1,32}$/u;

/** Stable ID for a song: its YouTube video ID, or a normalized title for links that aren't resolved yet. */
export function trackKey(track) {
  const id = youtubeId(track?.url);
  return id ? `yt:${id}` : `q:${songKey(track?.title, track?.author)}`;
}

/** The fields worth saving: enough to show the song and play it again. */
export function storedTrack(t) {
  const out = { title: t.title, url: t.url ?? null, duration: t.duration ?? null, author: t.author ?? null, thumbnail: t.thumbnail ?? null };
  if (!out.url && t.query) {
    out.query = t.query; // a Spotify song that hasn't been looked up on YouTube yet
    out.source = t.source;
  }
  return out;
}

/** Saved songs -> queue tracks requested by `user`. */
export function toTracks(stored, user) {
  return stored.map((t) => ({ ...makeTrack(t, user), ...(t.query ? { query: t.query, source: t.source } : {}) }));
}

const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export class Library {
  /** @param store JsonStore of { playlists: { key: { name, by, createdAt, updatedAt, tracks } }, liked: { userId: [...] } } */
  constructor(store) {
    this.store = store;
  }

  get #playlists() {
    return (this.store.data.playlists ??= {});
  }

  get #liked() {
    return (this.store.data.liked ??= {});
  }

  // ---------- playlists ----------

  playlist(name) {
    return this.#playlists[nameKey(name)] ?? null;
  }

  /** All playlists, A–Z. */
  playlists() {
    return Object.values(this.#playlists).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Saves (or replaces) a playlist. Only its creator or the owner can replace it. */
  savePlaylist(name, tracks, userId, isOwner) {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(clean)) throw new UserError('Playlist names are 1–32 letters, numbers, spaces or `_ - . \' ! &`.');
    const key = nameKey(clean);
    const existing = this.#playlists[key];
    if (existing && existing.by !== userId && !isOwner) throw new UserError(`**${existing.name}** belongs to <@${existing.by}>. Pick another name.`);
    if (!existing && Object.keys(this.#playlists).length >= MAX_PLAYLISTS) {
      throw new UserError(`You can have up to ${MAX_PLAYLISTS} playlists. Delete one first.`);
    }
    const now = Date.now();
    this.#playlists[key] = {
      name: clean,
      by: existing?.by ?? userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      tracks: tracks.slice(0, MAX_PLAYLIST_SONGS).map(storedTrack),
    };
    this.store.save();
    return { replaced: Boolean(existing), count: Math.min(tracks.length, MAX_PLAYLIST_SONGS), cut: tracks.length > MAX_PLAYLIST_SONGS };
  }

  /** Deletes a playlist. Returns its display name. Only its creator or the owner can delete it. */
  deletePlaylist(name, userId, isOwner) {
    const key = nameKey(name);
    const existing = this.#playlists[key];
    if (!existing) throw new UserError(`No playlist called **${name.slice(0, 32)}**. See \`cplaylists\`.`);
    if (existing.by !== userId && !isOwner) throw new UserError(`**${existing.name}** belongs to <@${existing.by}>; only they can delete it.`);
    delete this.#playlists[key];
    this.store.save();
    return existing.name;
  }

  // ---------- liked songs ----------

  /** A user's liked songs, newest first. */
  liked(userId) {
    return this.#liked[userId] ?? [];
  }

  isLiked(userId, track) {
    const key = trackKey(track);
    return this.liked(userId).some((t) => t.key === key);
  }

  /** Likes the song, or unlikes it if it was already liked. Returns true if it's liked now. */
  toggleLike(userId, track) {
    const key = trackKey(track);
    const list = (this.#liked[userId] ??= []);
    const i = list.findIndex((t) => t.key === key);
    if (i !== -1) list.splice(i, 1);
    else {
      list.unshift({ key, ...storedTrack(track), likedAt: Date.now() });
      if (list.length > MAX_LIKED) list.length = MAX_LIKED;
    }
    this.store.save();
    return i === -1;
  }
}
