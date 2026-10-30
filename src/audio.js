// Builds a playable AudioResource for one track.
// With the "pure" profile, Opus sources (most YouTube audio) go straight to Discord untouched.
// Sound profiles, seeking and non-Opus sources go through ffmpeg once, straight to high-quality Opus.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';
import { createAudioResource, demuxProbe, StreamType } from '@discordjs/voice';
import { log } from './logger.js';
import { lastLine, parseInfoLine, spawnAudioStream } from './ytdlp.js';

/** Fills in duration/artist/cover that quick search results leave out, from yt-dlp's info file. */
async function applyInfoFile(track, infoFile) {
  try {
    const info = parseInfoLine((await fsp.readFile(infoFile, 'utf8')).trim().split(/\r?\n/)[0]);
    if (!info) return;
    track.duration ??= info.duration;
    track.author ??= info.author;
    track.thumbnail ??= info.thumbnail;
    if (info.live) track.live = true;
  } catch {
    // Cosmetic only.
  } finally {
    fsp.rm(infoFile, { force: true }).catch(() => {});
  }
}

// Slow connections plus YouTube's JS challenge can take a while before the first audio byte.
const FIRST_BYTE_TIMEOUT_MS = 75_000;
// Wait for this much audio before playing (about 20 s at 160 kbps), so short network dips don't stutter.
const PREBUFFER_BYTES = 384 * 1024;
// Let yt-dlp keep downloading ahead of playback, up to about a whole song.
const DOWNLOAD_AHEAD_BYTES = 16 * 1024 * 1024;
// FFMPEG_PATH lets you use a system ffmpeg if the bundled ffmpeg-static binary doesn't work on your host.
const FFMPEG = process.env.FFMPEG_PATH?.trim() || ffmpegPath;

let ffmpegOk = true;

/**
 * Runs ffmpeg once with a real filter chain to make sure it works on this machine.
 * If it doesn't, the bot falls back to untouched passthrough instead of failing every song.
 */
export function checkFfmpeg(filters) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'];
    if (filters) args.push('-af', filters);
    args.push('-c:a', 'libopus', '-b:a', '160k', '-f', 'null', '-');
    let stderr = '';
    let child;
    try {
      child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      ffmpegOk = false;
      return resolve({ ok: false, reason: err.code ?? err.message });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      ffmpegOk = false;
      resolve({ ok: false, reason: err.code ?? err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      ffmpegOk = code === 0;
      resolve(ffmpegOk ? { ok: true } : { ok: false, reason: lastLine(stderr) || `exit code ${code}` });
    });
  });
}

export function ffmpegAvailable() {
  return ffmpegOk;
}

/**
 * Detects an Opus file from its first bytes. Used instead of demuxProbe, which puts the bytes
 * it read back at the END of a stream that already has data buffered, corrupting the start.
 */
function sniffOpus(head) {
  const text = head.subarray(0, 4096).toString('latin1');
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3 && text.includes('A_OPUS')) return StreamType.WebmOpus;
  if (text.startsWith('OggS') && text.includes('OpusHead')) return StreamType.OggOpus;
  return null;
}

function kill(proc) {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * Resolves with a stream once enough audio is buffered (or the whole song arrived),
 * or rejects with yt-dlp's error if nothing arrives.
 */
function waitForAudio(child, signal) {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdout.on('error', () => {});

  return new Promise((resolve, reject) => {
    // Buffered chunks are kept in order here, then written to a fresh stream first,
    // so playback always starts at byte 0 of the file.
    const chunks = [];
    let received = 0;
    // Timeout: play whatever is buffered; fail only if nothing arrived at all.
    const timer = setTimeout(
      () => finish(received > 0 ? null : new Error(`no audio received within ${FIRST_BYTE_TIMEOUT_MS / 1000}s`)),
      FIRST_BYTE_TIMEOUT_MS,
    );
    const onData = (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= PREBUFFER_BYTES) finish(null);
    };
    const onEnd = () => {
      if (received > 0) finish(null); // Short song: fully downloaded before the buffer target.
    };
    const onExit = (code) =>
      finish(received > 0 ? null : new Error(lastLine(stderr) || `yt-dlp exited with code ${code}`));
    const onError = (err) => finish(new Error(`could not start yt-dlp: ${err.message}`));
    const onAbort = () => finish(new Error('aborted'));

    let done = false;
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.pause();
      child.stdout.off('data', onData);
      child.stdout.off('end', onEnd);
      child.off('exit', onExit);
      child.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (err) {
        child.stdout.destroy();
        reject(err);
        return;
      }
      const head = Buffer.concat(chunks);
      const out = new PassThrough({ highWaterMark: DOWNLOAD_AHEAD_BYTES });
      out.write(head);
      if (child.stdout.readableEnded) out.end();
      else child.stdout.pipe(out); // keeps downloading ahead of playback
      resolve({ stream: out, head });
    }

    child.stdout.on('data', onData);
    child.stdout.once('end', onEnd);
    child.once('exit', onExit);
    child.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Encodes `input` (a stream) or `file` (a path) to high-quality Ogg/Opus,
 * optionally starting at `seekSec` and applying an ffmpeg filter chain.
 */
function transcode({ input, file, seekSec = 0, filters = null, bitrate = 160_000 }) {
  if (!FFMPEG) throw new Error('no ffmpeg binary for this platform; install ffmpeg and set FFMPEG_PATH');
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (file) {
    if (seekSec > 0) args.push('-ss', String(seekSec));
    args.push('-i', file);
  } else {
    args.push('-i', 'pipe:0');
    if (seekSec > 0) args.push('-ss', String(seekSec));
  }
  args.push('-vn');
  if (filters) args.push('-af', filters);
  args.push(
    '-c:a', 'libopus',
    '-b:a', String(bitrate),
    '-vbr', 'on',
    '-compression_level', '10', // Best quality the encoder offers.
    '-application', 'audio', // Tuned for music, not speech.
    '-frame_duration', '20',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'ogg',
    'pipe:1',
  );

  let ff;
  try {
    ff = spawn(FFMPEG, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new Error(`could not start ffmpeg (${err.code ?? err.message}); run "npm rebuild ffmpeg-static" or set FFMPEG_PATH`);
  }
  ff.on('error', (err) => log.debug('ffmpeg process error:', err.message));
  ff.stdout.on('error', () => {});
  ff.stderr.setEncoding('utf8');
  ff.stderr.on('data', (chunk) => log.debug('ffmpeg:', chunk.trim()));
  if (input) {
    ff.stdin.on('error', () => {});
    input.on('error', () => ff.stdin.destroy());
    input.pipe(ff.stdin);
  }
  return ff;
}

/**
 * Returns { resource, cleanup, passthrough }. `cleanup()` kills helper processes and must be
 * called once the track is finished or abandoned. The track needs either `url` or `path`.
 */
export async function createTrackResource(track, { seekSec = 0, filters = null, bitrate = 160_000, signal } = {}) {
  const procs = [];
  const cleanup = () => procs.forEach(kill);
  const onAbort = () => cleanup();
  signal?.addEventListener('abort', onAbort, { once: true });

  const finalize = (stream, inputType, passthrough) => ({
    resource: createAudioResource(stream, { inputType, metadata: track }),
    cleanup,
    passthrough,
  });

  // Without a working ffmpeg, play untouched from the start rather than fail.
  if (!ffmpegOk) {
    filters = null;
    seekSec = 0;
  }
  // Filters or seeking need ffmpeg; with neither, Opus sources pass straight through.
  const mustEncode = Boolean(filters) || seekSec > 0;

  try {
    // Local files: ffmpeg reads them directly (works for MP3, FLAC, WAV...).
    if (track.path && ffmpegOk) {
      const ff = transcode({ file: track.path, seekSec, filters, bitrate });
      procs.push(ff);
      return finalize(ff.stdout, StreamType.OggOpus, false);
    }
    if (track.path) {
      const probe = await demuxProbe(createReadStream(track.path));
      return finalize(probe.stream, probe.type, true);
    }

    let source;
    let head;
    {
      if (!track.url) throw new Error('track has no URL');
      const needsInfo = track.duration == null || !track.author;
      const infoFile = needsInfo ? path.join(os.tmpdir(), `smb-${randomUUID()}.json`) : null;
      const child = spawnAudioStream(track.url, { infoFile });
      procs.push(child);
      child.once('exit', (code) => {
        if (code) log.debug(`yt-dlp exited with code ${code} for ${track.url}`);
      });
      try {
        ({ stream: source, head } = await waitForAudio(child, signal));
      } finally {
        if (infoFile) await applyInfoFile(track, infoFile);
      }
    }
    signal?.throwIfAborted();

    if (mustEncode) {
      const ff = transcode({ input: source, seekSec, filters, bitrate });
      procs.push(ff);
      return finalize(ff.stdout, StreamType.OggOpus, false);
    }

    const opusType = sniffOpus(head);
    if (opusType) return finalize(source, opusType, true);
    if (!ffmpegOk) throw new Error('source is not Opus and ffmpeg is unavailable');

    const ff = transcode({ input: source, bitrate });
    procs.push(ff);
    return finalize(ff.stdout, StreamType.OggOpus, false);
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
