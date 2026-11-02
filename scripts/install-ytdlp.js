// Runs on `npm install`. Failure here is not fatal: the bot retries the download on startup.
import { ensureYtDlp } from '../src/ytdlp-install.js';

try {
  console.log(`[postinstall] yt-dlp ready: ${await ensureYtDlp(console)}`);
} catch (err) {
  console.warn(`[postinstall] ${err.message}. The bot will try again on startup.`);
}
