// Sound profiles: ffmpeg audio filter chains applied while encoding.
// Every chain except "pure" ends with loudness normalization (same volume for every song,
// about -14 LUFS like Spotify/YouTube) and a limiter so boosted bass never distorts.

// loudnorm outputs 192 kHz internally; resample right after so the limiter runs at 48 kHz (4x less CPU).
const LOUDNESS = 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000';
const LIMITER = 'alimiter=limit=0.92:attack=5:release=50:level=0';

export const PROFILES = {
  pure: {
    label: 'Pure',
    emoji: '💎',
    description: 'Original audio, untouched (Opus passthrough when possible).',
    filters: null,
  },
  hifi: {
    label: 'HiFi',
    emoji: '🎧',
    description: 'A little more bass, crisper highs, equal loudness for every song.',
    filters: ['bass=g=3:f=90:w=0.6', 'treble=g=2:f=9000:w=0.5', LOUDNESS, LIMITER].join(','),
  },
  bass: {
    label: 'Bass',
    emoji: '🔊',
    description: 'Strong, punchy bass without the boom.',
    filters: ['bass=g=7:f=80:w=0.5', 'equalizer=f=250:t=q:w=1:g=-1.5', 'treble=g=1:f=9000:w=0.5', LOUDNESS, LIMITER].join(','),
  },
  vocal: {
    label: 'Vocal',
    emoji: '🎤',
    description: 'Clearer vocals, great for Bollywood and lyric-heavy songs.',
    filters: ['bass=g=-1:f=100:w=0.6', 'equalizer=f=3000:t=q:w=1:g=3', 'treble=g=1.5:f=8000:w=0.5', LOUDNESS, LIMITER].join(','),
  },
};

export const DEFAULT_PROFILE = 'hifi';

export function getProfile(name) {
  return PROFILES[name] ?? PROFILES[DEFAULT_PROFILE];
}

export const MAX_VOLUME = 150;

export const clampVolume = (v) => Math.round(Math.min(MAX_VOLUME, Math.max(0, Number.isFinite(v) ? v : 100)));

/**
 * The ffmpeg filter chain for a profile at a volume. Volume goes right before the limiter, so a
 * boost above 100% gets louder without ever clipping. At 100% the chain is unchanged (and the
 * "pure" profile stays untouched passthrough).
 */
export function buildFilters(name, volume = 100) {
  const base = getProfile(name).filters;
  if (volume === 100) return base;
  const vol = `volume=${(volume / 100).toFixed(2)}`;
  return base ? base.replace(LIMITER, `${vol},${LIMITER}`) : `${vol},${LIMITER}`;
}

// Opus at 160 kbps matches YouTube's best audio. Boosted channels allow more.
export const MIN_ENCODE_BITRATE = 160_000;
export const MAX_ENCODE_BITRATE = 384_000;

export function encodeBitrate(channelBitrate) {
  return Math.min(MAX_ENCODE_BITRATE, Math.max(MIN_ENCODE_BITRATE, channelBitrate || 0));
}
