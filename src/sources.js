// Turns user input or playlist.txt lines into track objects.
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from './config.js';
import { log } from './logger.js';
import { getSpotifyTracks, SPOTIFY_RE } from './spotify.js';
import { fetchEntries, searchTracks } from './ytdlp.js';

const URL_RE = /^https?:\/\/\S+$/i;

/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {}

export function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function makeTrack(info, requester) {
  return {
    title: info.title,
    url: info.url,
    duration: info.duration ?? null,
    thumbnail: info.thumbnail ?? null,
    author: info.author ?? null,
    live: Boolean(info.live),
    requesterId: requester?.id ?? null,
  };
}

/** Resolves what a user typed after `cplay` into one or more tracks. */
export async function resolveInput(input, requester, signal) {
  if (SPOTIFY_RE.test(input)) {
    let songs;
    try {
      songs = await getSpotifyTracks(input, signal);
    } catch (err) {
      throw new UserError(`I couldn't read that Spotify link: ${err.message.slice(0, 180)}.`);
    }
    if (!songs.length) throw new UserError('That Spotify link has no songs.');
    // Each song is searched on YouTube Music right before it plays (cached), so this is instant.
    return songs.map((s) => ({
      ...makeTrack({ ...s, url: null }, requester),
      query: s.author ? `${s.author} - ${s.title}` : s.title,
      source: 'spotify',
    }));
  }

  if (URL_RE.test(input)) {
    let entries;
    try {
      entries = await fetchEntries(input, { signal });
    } catch (err) {
      throw new UserError(`I couldn't open that link. (${err.message.replace(/^yt-dlp:\s*/, '').slice(0, 180)})`);
    }
    if (!entries.length) throw new UserError('Nothing playable at that link.');
    return entries.map((info) => makeTrack(info, requester));
  }

  let results;
  try {
    results = await searchTracks(input, 1, signal);
  } catch (err) {
    throw new UserError(`Search failed. (${err.message.replace(/^yt-dlp:\s*/, '').slice(0, 180)})`);
  }
  if (!results.length) throw new UserError(`No results for **${input.slice(0, 80)}**.`);
  return [makeTrack(results[0], requester)];
}

function lineToTrack(line) {
  if (URL_RE.test(line)) return { title: line, url: line, requesterId: null, isDefault: true };

  // Local files are only allowed from playlist.txt (which only the host owner can edit).
  const local = path.resolve(ROOT_DIR, line);
  try {
    if (statSync(local).isFile()) {
      return { title: path.basename(local), url: null, path: local, requesterId: null, isDefault: true };
    }
  } catch {
    // Not a local file; treat it as a search phrase.
  }
  return { title: line, url: null, query: line, requesterId: null, isDefault: true };
}

/** Reads playlist.txt. Returns [] (and logs why) if it's missing or unreadable. */
export async function loadDefaultPlaylist() {
  try {
    const text = await fs.readFile(config.playlistFile, 'utf8');
    const tracks = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(lineToTrack);
    if (config.shuffle) shuffleInPlace(tracks);
    log.info(`playlist.txt loaded: ${tracks.length} track(s).`);
    return tracks;
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found' : err.message;
    log.warn(`Could not read ${config.playlistFile} (${reason}).`);
    return [];
  }
}
