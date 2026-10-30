// Runs on `npm install`. Failure here is not fatal: the bot retries the download on startup.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBinaryName, ensureYtDlp } from '../src/ytdlp-install.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.YTDLP_PATH) {
  console.log('[postinstall] YTDLP_PATH is set, skipping yt-dlp download.');
} else {
  try {
    await ensureYtDlp(path.join(root, 'bin', defaultBinaryName()));
  } catch (err) {
    console.warn(`[postinstall] ${err.message}. The bot will try again on startup.`);
  }
}
