// Guesses a song's language from its title and channel, so autoplay can stay in one language.
// Returns null when unsure; callers treat null as "could be anything", never as a mismatch.
//
// Signals, strongest first:
//   1. Script: a title in Telugu, Tamil, Devanagari... script is that language.
//   2. Words: "Telugu", "Tollywood", "[Hindi]", "Punjabi Song"...
//   3. Channels and artists that release almost only one language.
// Romanized titles like "Tum Hi Ho" have no script or keyword, so they rely on signal 3.

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+-\s+topic$/, '').replace(/[^\p{L}\p{N}]+/gu, '');

const LANGUAGES = {
  telugu: {
    script: /[\u0C00-\u0C7F]/,
    words: /\b(telugu|tollywood)\b/i,
    channels: ['adityamusic', 'lahari music', 'mangomusic', 'devisriprasad', 'thaman', 'ssthaman', 'mmkeeravaani', 'mickeyjmeyer', 'anuragkulkarni', 'mangli', 'rammiriyala', 'rahulsipligunj', 'kaalabhairava', 'sidsriramtelugu', 'saregamatelugu', 'tseriestelugu', 'sonymusicsouthtelugu'],
  },
  tamil: {
    script: /[\u0B80-\u0BFF]/,
    words: /\b(tamil|kollywood)\b/i,
    channels: ['thinkmusicindia', 'anirudhravichander', 'yuvanshankarraja', 'harrisjayaraj', 'saregamatamil', 'sonymusicsouthtamil', 'tseriestamil'],
  },
  kannada: {
    script: /[\u0C80-\u0CFF]/,
    words: /\b(kannada|sandalwood)\b/i,
    channels: ['anandaudio', 'pmaudios', 'saregamakannada'],
  },
  malayalam: {
    script: /[\u0D00-\u0D7F]/,
    words: /\b(malayalam|mollywood)\b/i,
    channels: ['muzik247', 'saregamamalayalam', 'mathrubhumimusic'],
  },
  punjabi: {
    script: /[\u0A00-\u0A7F]/,
    words: /\b(punjabi|panjabi)\b/i,
    channels: ['speedrecords', 'whitehillmusic', 'tseriesapnapunjab', 'sidhumoosewala', 'karanaujla', 'apdhillon', 'diljitdosanjh', 'shubh', 'gurusandhu', 'amrindergill', 'babbumaan'],
  },
  bengali: {
    script: /[\u0980-\u09FF]/,
    words: /\b(bengali|bangla)\b/i,
    channels: ['svfmusic', 'amarabanglamusic'],
  },
  marathi: {
    script: null, // shares Devanagari with Hindi; detected by words only
    words: /\b(marathi)\b/i,
    channels: ['zeemusicmarathi', 'everestmarathi'],
  },
  hindi: {
    script: /[\u0900-\u097F]/,
    words: /\b(hindi|bollywood)\b/i,
    channels: ['tseries', 'zeemusiccompany', 'tipsofficial', 'sonymusicindia', 'saregamamusic', 'yrf', 'arijitsingh', 'pritam', 'vishalmishra', 'jubinnautiyal', 'atifaslam', 'sonunigam', 'kumarsanu', 'udit narayan', 'ankittiwari', 'darshanraval', 'armaanmalik', 'badshah', 'nehakakkar', 'sachettandon', 'mithoon', 'amaalmallik', 'mohitchauhan', 'kk', 'sunidhichauhan', 'lata mangeshkar', 'kishorekumar', 'mohammedrafi', 'ashabhosle', 'jasleenroyal', 'papon', 'raghavchaitanya', 'anuvjain', 'vishalshekhar', 'shankarehsaanloy', 'sachinjigar', 'amitabhbhattacharya', 'irshadkamil', 'rahatfatehalikhan', 'shilparao', 'javedakhtar', 'gulzar', 'tanishkbagchi', 'mustafazahid'],
  },
  english: {
    script: null,
    words: /\b(english)\b/i,
    channels: [], // plus any "...VEVO" channel, see below
  },
};

// Marathi before Hindi: both use Devanagari, so the Marathi keyword must win.
const ORDER = ['marathi', 'telugu', 'tamil', 'kannada', 'malayalam', 'punjabi', 'bengali', 'hindi', 'english'];
for (const lang of ORDER) LANGUAGES[lang].channels = new Set(LANGUAGES[lang].channels.map(norm));

export const LANGUAGE_NAMES = ORDER;

/** "telugu", "hindi", ... or null if unsure. */
export function detectLanguage(track) {
  const title = String(track?.title ?? '');
  const author = String(track?.author ?? '');
  const text = `${title} ${author}`;

  for (const lang of ORDER) if (LANGUAGES[lang].script?.test(title)) return lang;
  for (const lang of ORDER) if (LANGUAGES[lang].words.test(text)) return lang;

  // Artist fields often list several people: "Arijit Singh, Pritam & Amitabh Bhattacharya".
  const names = author.split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?)\s*/i).map(norm).filter(Boolean);
  for (const name of names) {
    for (const lang of ORDER) if (LANGUAGES[lang].channels.has(name)) return lang;
  }
  if (/vevo$/i.test(author.trim())) return 'english';
  return null;
}
