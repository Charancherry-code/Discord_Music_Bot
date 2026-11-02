// Installs and updates yt-dlp (no Python needed).
//
// Windows uses the "folder" build (yt-dlp_win.zip), unpacked once into bin/yt-dlp-<version>/.
// The one-file yt-dlp.exe unpacks about 23 MB into a temp folder on EVERY run (measured: 1.9 s
// just for --version), and the bot runs yt-dlp for every search and every song.
// Folder builds can't update themselves (yt-dlp -U refuses), so this module does it: download
// the zip, check its SHA-256 against the release's checksum file, unpack it into a new versioned
// folder and switch to it. Songs already playing keep using the old folder; old folders are
// deleted once nothing uses them (at the latest on the next start).
//
// Other platforms use the single binary bin/yt-dlp and `yt-dlp -U`.
// YTDLP_PATH (in .env) overrides all of this with your own yt-dlp.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const REPO = 'https://github.com/yt-dlp/yt-dlp/releases';
const DIR_PREFIX = 'yt-dlp-';
const WINDOWS = process.platform === 'win32';
const DOWNLOAD_TIMEOUT_MS = 600_000;

let current = null; // path of the yt-dlp binary in use

// ---------- which build ----------

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** Release asset for this platform: a zip (Windows folder build) or a single binary. */
function assetName() {
  const { platform, arch } = process;
  if (platform === 'win32') return { arm64: 'yt-dlp_win_arm64.zip', ia32: 'yt-dlp_win_x86.zip' }[arch] ?? 'yt-dlp_win.zip';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    const musl = isMusl();
    if (arch === 'x64') return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
    if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
  }
  return null;
}

const override = () => {
  const p = process.env.YTDLP_PATH?.trim();
  return p ? path.resolve(ROOT, p) : null;
};

/** "2026.10.26" / "2026.10.26.1" -> comparable number arrays. */
const versionParts = (v) => String(v).split('.').map((n) => Number(n) || 0);
function newer(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Installed folder builds, newest first: [{ version, dir, exe }]. */
function installedFolders() {
  let names = [];
  try {
    names = fs.readdirSync(BIN);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(DIR_PREFIX) && /^\d+(\.\d+)+$/.test(n.slice(DIR_PREFIX.length)))
    .map((n) => ({ version: n.slice(DIR_PREFIX.length), dir: path.join(BIN, n), exe: path.join(BIN, n, 'yt-dlp.exe') }))
    .filter((f) => fs.existsSync(f.exe))
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
}

/** The yt-dlp binary to run. */
export function ytDlpPath() {
  return override() ?? current ?? (WINDOWS ? installedFolders()[0]?.exe : null) ?? path.join(BIN, WINDOWS ? 'yt-dlp.exe' : 'yt-dlp');
}

// ---------- downloading ----------

async function download(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Node's fetch hides the real network error in `cause`.
    throw new Error(`download of ${path.basename(url)} failed (${err.cause?.code || err.cause?.message || err.message})`);
  }
}

/** Latest release tag, read from where github.com/.../releases/latest redirects to (no API rate limit). */
async function latestVersion() {
  const res = await fetch(`${REPO}/latest`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const tag = res.url.match(/\/tag\/([^/?#]+)$/)?.[1];
  if (!tag) throw new Error(`could not read the latest version (${res.status})`);
  return decodeURIComponent(tag);
}

/** Downloads `asset` of release `version` and checks it against the release's SHA2-256SUMS. */
async function verifiedAsset(version, asset) {
  const base = `${REPO}/download/${encodeURIComponent(version)}/`;
  const [data, sums] = await Promise.all([download(base + asset), download(`${base}SHA2-256SUMS`)]);
  const expected = sums
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`no checksum listed for ${asset}`);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error(`checksum mismatch for ${asset}; not installing it`);
  return data;
}

/** Downloads and unpacks the Windows folder build of `version` into bin/yt-dlp-<version>/. */
async function installFolder(version, log) {
  const asset = assetName();
  const target = path.join(BIN, DIR_PREFIX + version);
  const exe = path.join(target, 'yt-dlp.exe');
  if (fs.existsSync(exe)) return exe;

  log.info(`Downloading yt-dlp ${version} (${asset})...`);
  const data = await verifiedAsset(version, asset);
  const tmp = `${target}.tmp`;
  const zip = `${tmp}.zip`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  try {
    await fsp.writeFile(zip, data);
    // tar.exe ships with Windows 10 and 11 and unpacks zip files.
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await execFileAsync(tar, ['-xf', zip, '-C', tmp], { windowsHide: true, timeout: 120_000 });
    // The zip has yt-dlp.exe at the top, or inside one folder.
    let root = tmp;
    if (!fs.existsSync(path.join(root, 'yt-dlp.exe'))) {
      const [sub] = (await fsp.readdir(tmp, { withFileTypes: true })).filter((d) => d.isDirectory());
      if (sub && fs.existsSync(path.join(tmp, sub.name, 'yt-dlp.exe'))) root = path.join(tmp, sub.name);
      else throw new Error('yt-dlp.exe not found in the zip');
    }
    await fsp.rename(root, target);
  } finally {
    await fsp.rm(zip, { force: true }).catch(() => {});
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  log.info(`yt-dlp ${version} installed in ${path.relative(ROOT, target)}`);
  return exe;
}

/** Downloads the single-file build (non-Windows) to bin/yt-dlp. */
async function installBinary(log) {
  const asset = assetName();
  const target = path.join(BIN, 'yt-dlp');
  log.info(`Downloading yt-dlp (${asset})...`);
  const data = await verifiedAsset(await latestVersion(), asset);
  await fsp.mkdir(BIN, { recursive: true });
  const tmp = `${target}.download`;
  await fsp.writeFile(tmp, data, { mode: 0o755 });
  await fsp.rename(tmp, target);
  log.info(`yt-dlp saved to ${path.relative(ROOT, target)}`);
  return target;
}

/**
 * Deletes folder builds other than the one in use, and the old one-file yt-dlp.exe.
 * Only called at startup, before any yt-dlp process runs.
 */
async function removeOldBuilds(log) {
  const keep = path.dirname(current ?? '');
  const old = installedFolders().filter((f) => f.dir !== keep).map((f) => f.dir);
  old.push(path.join(BIN, 'yt-dlp.exe'));
  for (const target of old) {
    if (!fs.existsSync(target)) continue;
    try {
      await fsp.rm(target, { recursive: true, force: true });
      log.debug?.(`Removed old yt-dlp: ${path.relative(ROOT, target)}`);
    } catch {
      // Still in use by a running song; removed on a later update or start.
    }
  }
}

// ---------- public ----------

/**
 * Makes sure yt-dlp is installed and returns its path.
 * On Windows, switches an old one-file install to the faster folder build. If that download
 * fails, the existing yt-dlp.exe keeps working.
 */
export async function ensureYtDlp(log = console) {
  const custom = override();
  if (custom) {
    if (!fs.existsSync(custom)) throw new Error(`YTDLP_PATH points to ${custom}, which doesn't exist`);
    return (current = custom);
  }
  if (!assetName()) {
    throw new Error(`No standalone yt-dlp build for ${process.platform}/${process.arch}. Install yt-dlp yourself and set YTDLP_PATH.`);
  }

  if (!WINDOWS) {
    const bin = path.join(BIN, 'yt-dlp');
    return (current = fs.existsSync(bin) ? bin : await installBinary(log));
  }

  const installed = installedFolders()[0];
  if (installed) {
    current = installed.exe;
    await removeOldBuilds(log);
    return current;
  }
  try {
    current = await installFolder(await latestVersion(), log);
    await removeOldBuilds(log);
    return current;
  } catch (err) {
    const legacy = path.join(BIN, 'yt-dlp.exe');
    if (!fs.existsSync(legacy)) throw err;
    log.warn(`Could not install the faster yt-dlp folder build (${err.message}); using the old yt-dlp.exe.`);
    return (current = legacy);
  }
}

/**
 * Updates yt-dlp if a newer release exists. Safe while songs play: the new version goes into its
 * own folder and is used from the next song on. Never throws; returns a short status line.
 */
export async function updateYtDlp(log = console) {
  try {
    const custom = override();
    if (custom || !WINDOWS || !installedFolders().length) {
      // Single binary (or your own yt-dlp): it updates itself.
      const { stdout } = await execFileAsync(ytDlpPath(), ['-U'], { windowsHide: true, timeout: 120_000 });
      const line = stdout.trim().split(/\r?\n/).pop() || 'update check done';
      log.info(`yt-dlp: ${line}`);
      return line;
    }
    const installed = installedFolders()[0];
    const latest = await latestVersion();
    if (!newer(latest, installed.version)) {
      log.info(`yt-dlp ${installed.version} is up to date.`);
      return `up to date (${installed.version})`;
    }
    current = await installFolder(latest, log);
    // The old folder is NOT deleted here: a song that's downloading may still be loading files
    // from it. It's removed on the next start, when nothing can be using it.
    log.info(`yt-dlp updated: ${installed.version} -> ${latest}. New songs use it right away.`);
    return `updated to ${latest}`;
  } catch (err) {
    const msg = err.stderr?.trim().split(/\r?\n/).pop() || err.message;
    log.warn(`yt-dlp update skipped: ${msg}`);
    return `update failed: ${msg}`;
  }
}
