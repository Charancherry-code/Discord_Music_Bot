// Disk cache of downloaded songs (.cache/audio/<videoId>.bin, the original audio as YouTube sent it).
// A cached song starts without yt-dlp or YouTube: read from disk in milliseconds.
// Only complete, successful downloads are saved. The least recently played files are removed
// when the cache passes AUDIO_CACHE_MB (default 1024 MB, about 250 songs; 0 turns it off).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from './config.js';
import { log } from './logger.js';

const DIR = path.join(ROOT_DIR, '.cache', 'audio');
const MAX_BYTES = Math.max(0, Number(process.env.AUDIO_CACHE_MB ?? 1024) || 0) * 1024 * 1024;
const ID_RE = /^[\w-]{11}$/;

const fileFor = (id) => path.join(DIR, `${id}.bin`);
let pruneTimer = null;

export const audioCacheEnabled = () => MAX_BYTES > 0;

/** The cached audio for a YouTube video ID, or null. Marks it as recently used. */
export async function readCached(id) {
  if (!MAX_BYTES || !ID_RE.test(id ?? '')) return null;
  const file = fileFor(id);
  try {
    const data = await fsp.readFile(file);
    const now = new Date();
    fsp.utimes(file, now, now).catch(() => {}); // last-used time, for pruning
    return data.length ? data : null;
  } catch {
    return null;
  }
}

/** Saves a completely downloaded song. Never throws. */
export async function writeCached(id, chunks) {
  if (!MAX_BYTES || !ID_RE.test(id ?? '') || !chunks?.length) return;
  const file = fileFor(id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(DIR, { recursive: true });
    await fsp.writeFile(tmp, Buffer.concat(chunks));
    await fsp.rename(tmp, file);
    schedulePrune();
  } catch (err) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    log.debug(`Audio cache write failed for ${id}: ${err.message}`);
  }
}

function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    prune().catch((err) => log.debug(`Audio cache prune failed: ${err.message}`));
  }, 30_000);
  pruneTimer.unref();
}

/** Deletes the least recently used songs until the cache fits in MAX_BYTES. */
async function prune() {
  const names = await fsp.readdir(DIR);
  const files = [];
  let total = 0;
  for (const name of names) {
    const file = path.join(DIR, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    if (name.endsWith('.tmp') && Date.now() - st.mtimeMs > 3_600_000) {
      await fsp.rm(file, { force: true }); // left over from a crash
      continue;
    }
    files.push({ file, size: st.size, used: st.mtimeMs });
    total += st.size;
  }
  if (total <= MAX_BYTES) return;
  files.sort((a, b) => a.used - b.used);
  let removed = 0;
  for (const f of files) {
    if (total <= MAX_BYTES * 0.9) break; // free a little extra so this doesn't run after every song
    await fsp.rm(f.file, { force: true }).catch(() => {});
    total -= f.size;
    removed++;
  }
  log.info(`Audio cache: removed ${removed} least-played song(s); ${Math.round(total / 1048576)} MB left.`);
}
