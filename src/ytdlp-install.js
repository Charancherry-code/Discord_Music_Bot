// Downloads the standalone yt-dlp binary (no Python needed) for the current platform.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

export function ytDlpAssetName() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    const musl = isMusl();
    if (arch === 'x64') return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
    if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
  }
  return null;
}

export function defaultBinaryName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

export async function ensureYtDlp(targetPath, log = console) {
  if (fs.existsSync(targetPath)) return targetPath;

  const asset = ytDlpAssetName();
  if (!asset) {
    throw new Error(
      `No standalone yt-dlp build for ${process.platform}/${process.arch}. Install yt-dlp yourself and set YTDLP_PATH.`,
    );
  }

  log.info(`Downloading yt-dlp (${asset})...`);
  let data;
  try {
    const res = await fetch(RELEASE_BASE + asset, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Node's fetch hides the real network error in `cause`.
    const detail = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`yt-dlp download failed (${detail})`);
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.download`;
  await fsp.writeFile(tmp, data, { mode: 0o755 });
  await fsp.rename(tmp, targetPath);
  log.info(`yt-dlp saved to ${targetPath}`);
  return targetPath;
}
