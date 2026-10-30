import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBinaryName } from './ytdlp-install.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present. Variables already set by the host panel take priority.
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const SNOWFLAKE = /^\d{17,20}$/;
const problems = [];

function env(name) {
  return process.env[name]?.trim() ?? '';
}

function required(name, pattern) {
  const value = env(name);
  if (!value || value.startsWith('YOUR_')) {
    problems.push(`${name} is not set`);
  } else if (pattern && !pattern.test(value)) {
    problems.push(`${name} does not look valid`);
  }
  return value;
}

function bool(name, fallback) {
  const value = env(name).toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

const dataDir = resolvePath(env('DATA_DIR') || 'data');

export const config = Object.freeze({
  token: required('DISCORD_TOKEN'),
  ownerId: required('OWNER_ID', SNOWFLAKE),
  guildId: required('GUILD_ID', SNOWFLAKE),
  prefix: (env('PREFIX') || 'c').toLowerCase(),
  playlistFile: resolvePath(env('PLAYLIST_FILE') || 'playlist.txt'),
  cookiesFile: env('COOKIES_FILE') ? resolvePath(env('COOKIES_FILE')) : null,
  ytDlpPath: resolvePath(env('YTDLP_PATH') || path.join('bin', defaultBinaryName())),
  ytDlpAutoUpdate: bool('YTDLP_AUTO_UPDATE', true),
  shuffle: bool('SHUFFLE', false),
  dataDir,
  cacheFile: path.join(ROOT_DIR, '.cache', 'resolved.json'),
});

if (problems.length) {
  console.error(`Configuration error:\n  - ${problems.join('\n  - ')}\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}
