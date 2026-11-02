// Console logging, plus a daily file in logs/ (bot-YYYY-MM-DD.log, kept 7 days) so the history
// survives restarts. Writing is buffered and never blocks or crashes the bot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const KEEP_DAYS = 7;

let file = null; // { day, stream }

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  fs.readdir(LOG_DIR, (err, names) => {
    if (err) return;
    for (const name of names) {
      const day = name.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/)?.[1];
      if (day && Date.parse(day) < cutoff) fs.rm(path.join(LOG_DIR, name), { force: true }, () => {});
    }
  });
}

function fileStream(day) {
  if (file?.day === day) return file.stream;
  file?.stream.end();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Console logging still works.
  }
  const stream = fs.createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
  stream.on('error', () => {});
  file = { day, stream };
  prune();
  return stream;
}

function write(level, args) {
  const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  const prefix = `${stamp} ${level.toUpperCase().padEnd(5)}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(prefix, ...args);
  fileStream(stamp.slice(0, 10)).write(`${prefix} ${format(...args)}\n`);
}

export const log = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
