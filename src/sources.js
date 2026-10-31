// Turns what someone typed (song name, YouTube/SoundCloud/Spotify link) into track objects.
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
