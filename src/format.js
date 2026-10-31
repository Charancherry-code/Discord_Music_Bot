import { escapeMarkdown } from 'discord.js';

const pad = (n) => String(n).padStart(2, '0');

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function progressBar(positionSec, durationSec, size = 18) {
  if (!durationSec) return '─'.repeat(size);
  const ratio = Math.min(1, Math.max(0, positionSec / durationSec));
  const filled = Math.round(ratio * size);
  return `${'━'.repeat(filled)}●${'─'.repeat(Math.max(0, size - filled))}`;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function cleanTitle(text, max = 80) {
  return escapeMarkdown(truncate(text, max)).replace(/[[\]]/g, '');
}

/** Markdown link to the track when it has a web URL, otherwise just the title. */
export function trackLabel(track, max = 80) {
  const title = cleanTitle(track.title, max);
  return track.url?.startsWith('http') ? `[${title}](<${track.url}>)` : title;
}
