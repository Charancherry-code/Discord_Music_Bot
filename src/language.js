// Guesses a song's language from its title and channel, so autoplay can stay in one language.
// Returns null when unsure; callers treat null as "could be anything", never as a mismatch.
//
// Signals, strongest first:
//   1. Script: a title in Telugu, Tamil, Devanagari... script is that language.
//   2. Words: "Telugu", "Tollywood", "[Hindi]", "Punjabi Song"...
//   3. Channels and artists that release almost only one language (from the channel field, an
//      "Artist - Song" title, or "| Movie | Arijit Singh" title parts).
//   4. Common words: romanized Hindi ("tum", "dil", "hai") vs English ("the", "you", "my").

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
    channels: ['tseries', 'zeemusiccompany', 'tipsofficial', 'sonymusicindia', 'saregamamusic', 'yrf', 'arijitsingh', 'pritam', 'vishalmishra', 'jubinnautiyal', 'atifaslam', 'sonunigam', 'kumarsanu', 'udit narayan', 'ankittiwari', 'darshanraval', 'armaanmalik', 'badshah', 'nehakakkar', 'sachettandon', 'mithoon', 'amaalmallik', 'mohitchauhan', 'kk', 'sunidhichauhan', 'lata mangeshkar', 'kishorekumar', 'mohammedrafi', 'ashabhosle', 'jasleenroyal', 'papon', 'raghavchaitanya', 'anuvjain', 'vishalshekhar', 'shankarehsaanloy', 'sachinjigar', 'amitabhbhattacharya', 'irshadkamil', 'rahatfatehalikhan', 'shilparao', 'javedakhtar', 'gulzar', 'tanishkbagchi', 'mustafazahid',
      'saregama', 'tipsmusic', 'zeemusic', 'sonymusicindiavevo', 'yrfmusic', 'tseriesbollywoodclassics', 'venusmusic', 'shemaroo', 'shemaroofilmigaane', 'erosnowmusic', 'timesmusic', 'ultrabollywood', 'goldmines', 'goldminesgaane',
      'shreyaghoshal', 'alkayagnik', 'shaan', 'palakmuchhal', 'stebinben', 'yasserdesai', 'aseeskaur', 'tulsikumar', 'dhvanibhanushali', 'amittrivedi', 'vishaldadlani', 'harshdeepkaur', 'sukhwindersingh', 'kailashkher', 'luckyali', 'javedali', 'salimsulaiman', 'himeshreshammiya', 'monalithakur', 'neetimohan', 'shalmalikholgade', 'benny dayal', 'nikhildsouza', 'raftaar', 'seedhemaut', 'krsna', 'emiwaybantai', 'mcstan', 'divine', 'lata', 'abhijeet', 'alka', 'kumaar', 'manojmuntashir', 'sameeranjaan', 'anandbakshi', 'rdburman', 'mukesh', 'jagjitsingh', 'ghulamali', 'nusratfatehalikhan', 'kanikakapoor', 'jonitagandhi', 'akhilsachdeva', 'arkoravmukherjee', 'arko', 'rochakkohli', 'mananbhardwaj', 'vishalmishraofficial', 'bpraak', 'mohammedirfan', 'faheemabdullah', 'javedmohsin', 'payaldev', 'harshitsaxena', 'shashwatsachdev'],
  },
  english: {
    script: null,
    words: /\b(english)\b/i,
    // plus any "...VEVO" channel, see below
    channels: ['theweeknd', 'edsheeran', 'taylorswift', 'justinbieber', 'dualipa', 'postmalone', 'charlieputh', 'selenagomez', 'billieeilish', 'brunomars', 'coldplay', 'imaginedragons', 'maroon5', 'shawnmendes', 'arianagrande', 'harrystyles', 'oliviarodrigo', 'adele', 'sia', 'alanwalker', 'marshmello', 'djsnake', 'drake', 'eminem', 'rihanna', 'katyperry', 'ladygaga', 'onedirection', 'arcticmonkeys', 'lanadelrey', 'sabrinacarpenter', 'glassanimals', 'onerepublic', 'thechainsmokers', 'kendricklamar', 'sza', 'thekidlaroi', 'akon', 'zayn', 'lewiscapaldi', 'jamesarthur', 'calumscott', 'bensonboone', 'avicii', 'kygo', 'davidguetta', 'calvinharris', 'martingarrix', 'linkinpark', 'queen', 'thebeatles', 'michaeljackson', 'beyonce', 'nickiminaj', 'cardib', 'travisscott', 'kanyewest', 'jcole', 'badbunny' /* Spanish, but rarely mixed into Hindi */, 'chappellroan', 'noahkahan', 'hozier', 'gracieabrams', 'teddyswims', 'tatemcrae', 'doechii', 'conangray', 'gayle', 'ellieGoulding', 'jasonderulo', 'pitbull', 'flo rida', 'sammsmith', 'samsmith', 'troyesivan', 'halsey', 'camilacabello', 'normani', 'lizzo', 'meghantrainor', 'ednaxiv', 'atlanticrecords', 'interscope', 'republicrecords', 'columbiarecords', 'ncs', 'nocopyrightsounds'],
  },
};

// Romanized Hindi/Urdu words common in song titles. Short or ambiguous ones (ho, na, ki, main) are left out.
const HINDI_WORDS = new Set(
  'hai hain tum tumhe tumse tujhe tujhse tera teri tere mera meri mere dil dilbar pyaar pyar ishq kya hoon sanam yaar yaara zindagi mohabbat jaana jaane jaan saath kabhi nahi nahin hum humko humse aaj raat baarish sajna sajni piya dhadkan aankhein aankhon khuda rabba chand chalo aaja kaise kyun kahin kuch mujhe mujhse apna apni yeh woh hoga kaun jeena marna dard judaa tanha sapne sapna duniya mahi soniye channa ranjha heeriye bekhayali kesariya raataan lambiyan'.split(' '),
);
// English words that rarely appear in Hindi titles ("love", "baby", "party" do, so they're not here).
const ENGLISH_WORDS = new Set(
  "the you your you're my me i i'm im it it's of don't dont can't cant won't wanna gonna we are is was what when where without never all just like this that be in on to and for how why she he her him they again way down out over more let go back home tonight forever every something someone nothing alone who would could should".split(' '),
);
// Title words that say nothing about the language.
const TITLE_NOISE = /\b(official|video|audio|lyrics?|lyrical|full|song|songs|music|hd|4k|8k|remix|version|live|feat|ft)\b/gi;

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
  const split = (s) => s.split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?)\s*/i).map(norm).filter(Boolean);
  // Title parts that may name the artist: "The Weeknd - Blinding Lights", "Tum Hi Ho | Aashiqui 2 | Arijit Singh".
  const [head, ...rest] = title.split(/\s[|•]\s/);
  const dash = head.match(/^(.{2,40}?)\s+-\s+/);
  const names = [...split(author), ...(dash ? split(dash[1]) : []), ...rest.flatMap(split)];
  for (const name of names) {
    for (const lang of ORDER) if (LANGUAGES[lang].channels.has(name)) return lang;
  }
  if (/vevo$/i.test(author.trim())) return 'english';
  return wordsLanguage(dash ? head.slice(dash[0].length) : head);
}

/** "hindi" or "english" from common words in the song name, or null if the words don't say. */
function wordsLanguage(songName) {
  const words =
    songName
      .toLowerCase()
      .replace(/[([{].*?[)\]}]/g, ' ')
      .replace(TITLE_NOISE, ' ')
      .replace(/[’`]/g, "'")
      .match(/[a-z']+/g) ?? [];
  let hindi = 0;
  let english = 0;
  for (const w of words) {
    if (HINDI_WORDS.has(w)) hindi++;
    else if (ENGLISH_WORDS.has(w)) english++;
  }
  if (hindi >= 1 && english === 0) return 'hindi';
  if (english >= 2 && hindi === 0) return 'english';
  return null;
}
