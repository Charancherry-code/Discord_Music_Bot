// Spotify links -> track list, without an API key.
// Reads the public embed page (the same data Spotify's own embed player uses). Spotify doesn't
// allow streaming its audio, so each song is later played from YouTube Music by "artist - title".
// Searches happen lazily, right before each song plays (and are cached), so a 100-song
// playlist is added instantly.

const TYPES = ['track', 'album', 'playlist', 'artist'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

export const SPOTIFY_RE = /^(https?:\/\/(open\.spotify\.com|spotify\.link|spotify\.app\.link)\/|spotify:)/i;

/** { type, id } from a Spotify URL or URI, or null. */
export function parseSpotify(input) {
  const uri = input.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]{22})/i);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };
  const url = input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]{22})/i);
  return url ? { type: url[1].toLowerCase(), id: url[2] } : null;
}

/** GET with 3 attempts: slow or flaky connections often fail the first try. */
async function get(url, signal) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`Spotify answered HTTP ${res.status}`);
      if (!res.ok) return Promise.reject(Object.assign(new Error(`Spotify answered HTTP ${res.status}`), { final: true }));
      return { url: res.url, html: await res.text() };
    } catch (err) {
      if (err.final || signal?.aborted) throw err;
      // Node hides the real network error in `cause`.
      lastError = new Error(err.cause?.code ? `network error ${err.cause.code}` : err.message);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

/** Short links (spotify.link) redirect to open.spotify.com, sometimes through an HTML page. */
async function expandShortLink(input, signal) {
  const { url, html } = await get(input, signal);
  return parseSpotify(url) ?? parseSpotify(html.match(/https:\/\/open\.spotify\.com\/[^"'\s<>]+/)?.[0] ?? '');
}

/** Finds the entity JSON in the embed page (Spotify has used three formats over time). */
function extractEntity(html) {
  for (const [, id, body] of html.matchAll(/<script[^>]*id="(__NEXT_DATA__|resource|initial-state)"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      if (id === '__NEXT_DATA__') return JSON.parse(body).props?.pageProps?.state?.data?.entity ?? null;
      const decoded = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
      return id === 'initial-state' ? decoded.data?.entity ?? null : decoded;
    } catch {
      // try the next script
    }
  }
  return null;
}

const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

function largestImage(entity) {
  const list = entity.coverArt?.sources ?? entity.images ?? entity.visualIdentity?.image ?? [];
  return list.reduce((best, img) => ((img.width ?? 0) > (best?.width ?? -1) ? img : best), null)?.url ?? null;
}

/**
 * Returns [{ title, author, duration, thumbnail }] for a Spotify link.
 * Throws an Error with a short, user-friendly message on failure.
 */
export async function getSpotifyTracks(input, signal) {
  let ref = parseSpotify(input);
  if (!ref && /spotify\.(app\.)?link/i.test(input)) ref = await expandShortLink(input, signal);
  if (!ref || !TYPES.includes(ref.type)) throw new Error('only track, album, playlist and artist links are supported');

  const { html } = await get(`https://open.spotify.com/embed/${ref.type}/${ref.id}`, signal);
  const entity = extractEntity(html);
  if (!entity) throw new Error("couldn't read the Spotify page (it may be private or Spotify changed its format)");

  const cover = largestImage(entity);
  const items = Array.isArray(entity.trackList) && entity.trackList.length
    ? entity.trackList.map((t) => ({
        title: clean(t.title ?? t.name),
        author: clean(t.subtitle ?? t.artists?.map((a) => a.name).join(', ')),
        ms: t.duration,
      }))
    : [{ title: clean(entity.title ?? entity.name), author: clean(entity.artists?.map((a) => a.name).join(', ') ?? entity.subtitle), ms: entity.duration }];

  return items
    .filter((t) => t.title)
    .map((t) => ({
      title: t.title,
      author: t.author || null,
      duration: Number.isFinite(t.ms) ? Math.round(t.ms / 1000) : null,
      // Album/single covers apply to every track; playlist covers don't (YouTube's thumbnail is used).
      thumbnail: ref.type === 'playlist' || ref.type === 'artist' ? null : cover,
    }));
}
