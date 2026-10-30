import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';

let warnedMissingCookies = false;

// Only the fields we need, as one JSON object per line.
const INFO_TEMPLATE =
  '%(.{id,title,duration,thumbnail,thumbnails,uploader,channel,artist,url,webpage_url,ie_key,extractor_key,live_status})j';

function baseArgs() {
  const args = [
    '--ignore-config',
    '--no-playlist',
    // YouTube now requires a JS runtime to solve its challenges; reuse the Node binary running this bot.
    '--js-runtimes',
    `node:${process.execPath}`,
    '--socket-timeout',
    '15',
    '--retries',
    '3',
  ];
  if (config.cookiesFile) {
    if (fs.existsSync(config.cookiesFile)) {
      args.push('--cookies', config.cookiesFile);
    } else if (!warnedMissingCookies) {
      warnedMissingCookies = true;
      log.warn(`COOKIES_FILE is set but ${config.cookiesFile} does not exist; continuing without cookies.`);
    }
  }
  return args;
}

export function lastLine(text) {
  return String(text ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
}

function run(args, { timeoutMs = 45_000, signal, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.ytDlpPath,
      raw ? args : [...baseArgs(), ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`yt-dlp: ${lastLine(stderr) || err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function normalizeInfo(info) {
  const isYouTube = /youtube/i.test(info.ie_key ?? info.extractor_key ?? '');
  const url =
    info.webpage_url || (isYouTube && info.id ? `https://www.youtube.com/watch?v=${info.id}` : info.url) || null;
  const thumbnail =
    info.thumbnail ||
    (isYouTube && info.id ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` : info.thumbnails?.at(-1)?.url) ||
    null;
  return {
    id: isYouTube ? info.id : null,
    title: info.title || url || 'Unknown title',
    url,
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    thumbnail,
    author: (info.artist || info.uploader || info.channel || '').replace(/\s+-\s+Topic$/, '') || null,
    live: info.live_status === 'is_live',
  };
}

/** Parses one line of INFO_TEMPLATE output. Returns null if it isn't valid. */
export function parseInfoLine(line) {
  try {
    return normalizeInfo(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * Lists the playable entries behind a URL or search target without downloading anything.
 * A single video returns one entry; a playlist returns up to `limit`.
 */
export async function fetchEntries(target, { limit = 200, signal } = {}) {
  const out = await run(['--flat-playlist', '--playlist-end', String(limit), '-O', INFO_TEMPLATE, '--', target], {
    signal,
    timeoutMs: 60_000,
  });
  const entries = [];
  for (const line of out.split(/\r?\n/)) {
    const info = line.trim() ? parseInfoLine(line) : null;
    if (info?.url) entries.push(info);
  }
  return entries;
}

const VIDEO_ID = /^[\w-]{11}$/;

/**
 * Top `count` results for a search phrase. Searches YouTube Music's "Songs" first: those are
 * official studio tracks without music-video intros or dialogue. Falls back to normal YouTube.
 */
export async function searchTracks(query, count = 1, signal) {
  try {
    const music = await fetchEntries(`https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`, {
      limit: count,
      signal,
    });
    const songs = music.filter((e) => VIDEO_ID.test(e.id ?? ''));
    if (songs.length) return songs.slice(0, count);
  } catch (err) {
    if (signal?.aborted) throw err;
    log.debug(`YouTube Music search failed, using YouTube: ${err.message}`);
  }
  return fetchEntries(`ytsearch${count}:${query}`, { limit: count, signal });
}

/**
 * Starts yt-dlp writing the best audio-only format of `url` to stdout.
 * If `infoFile` is given, yt-dlp also writes the track's metadata there (no extra request).
 */
export function spawnAudioStream(url, { infoFile } = {}) {
  const infoArgs = infoFile ? ['--print-to-file', INFO_TEMPLATE, infoFile] : [];
  const child = spawn(
    config.ytDlpPath,
    [
      ...baseArgs(),
      ...infoArgs,
      '--quiet',
      '--no-progress',
      '--no-part',
      // Prefer Opus so audio can be sent to Discord without re-encoding (near-zero CPU, no quality loss).
      '-f',
      'bestaudio[acodec=opus]/bestaudio/best',
      '-o',
      '-',
      '--',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  // A permanent handler so a late spawn error can never crash the process.
  child.on('error', (err) => log.debug('yt-dlp process error:', err.message));
  return child;
}

export async function updateYtDlp() {
  try {
    const out = await run(['-U'], { timeoutMs: 120_000, raw: true });
    log.info(`yt-dlp: ${lastLine(out) || 'update check done'}`);
  } catch (err) {
    log.warn(`yt-dlp self-update skipped: ${err.message}`);
  }
}
