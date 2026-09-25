// What language a piece of text is written in, as far as "does this card
// need translating for its reader?" cares. No model call: this runs before
// every notification, and most answers are "no".
//
// The answer is a primary language subtag ("ja", "es", "vi"), or "und" when
// the text is words but not words this can place — a short Latin-script title
// in a language with no list below. "und" is never anybody's language, so a
// card like that is handed to the translator, which is told to return text
// already in the reader's language unchanged. Getting "und" costs one model
// call; guessing wrong costs a reader a card they cannot read. The web
// client keeps a copy of this in web-react/src/utils/language.ts; the two
// must agree about which cards to ask about.

// Scripts that name their language, or near enough that asking the model
// is the right answer to the exceptions. Han and kana are weighed together
// below, because Japanese is written in both.
const SCRIPTS = [
  ["hangul", /[ᄀ-ᇿ㄰-㆏가-힯]/g],
  ["kana", /[぀-ヿㇰ-ㇿｦ-ﾟ]/g],
  ["han", /[㐀-䶿一-鿿豈-﫿]/g],
  ["cyrillic", /[Ѐ-ӿ]/g],
  ["greek", /[Ͱ-Ͽ]/g],
  ["armenian", /[԰-֏]/g],
  ["hebrew", /[֐-׿]/g],
  ["arabic", /[؀-ۿݐ-ݿ]/g],
  ["devanagari", /[ऀ-ॿ]/g],
  ["bengali", /[ঀ-৿]/g],
  ["gurmukhi", /[਀-੿]/g],
  ["gujarati", /[઀-૿]/g],
  ["tamil", /[஀-௿]/g],
  ["telugu", /[ఀ-౿]/g],
  ["kannada", /[ಀ-೿]/g],
  ["malayalam", /[ഀ-ൿ]/g],
  ["sinhala", /[඀-෿]/g],
  ["thai", /[฀-๿]/g],
  ["lao", /[຀-໿]/g],
  ["myanmar", /[က-႟]/g],
  ["georgian", /[Ⴀ-ჿ]/g],
  ["ethiopic", /[ሀ-፿]/g],
  ["khmer", /[ក-៿]/g],
  ["latin", /[A-Za-zÀ-ɏḀ-ỿ]/g],
];

// One CJK character carries about as much as a short Latin word, so a
// Japanese sentence with an English product name in it is still Japanese.
const WEIGHT = { hangul: 3, kana: 3, han: 3 };

const BY_SCRIPT = {
  hangul: "ko", greek: "el", armenian: "hy", hebrew: "he", devanagari: "hi",
  bengali: "bn", gurmukhi: "pa", gujarati: "gu", tamil: "ta", telugu: "te",
  kannada: "kn", malayalam: "ml", sinhala: "si", thai: "th", lao: "lo",
  myanmar: "my", georgian: "ka", ethiopic: "am", khmer: "km",
};

// The most common short words of the Latin-script languages people most
// often work in. A word listed under two languages counts for both.
const WORDS = {
  en: "the a an and of to is are for with this that please we you it on be by from need needs approve can will should our your before has have was not do if or at as approval needed decision review update task new request requested meeting",
  es: "el la los las de del que y en por para con es un una se no al lo como más pero sus esta este favor necesitamos aprobar antes hay son está",
  fr: "le la les des du de et est pour que qui dans un une pas avec sur nous vous il au aux ce cette être merci veuillez avant sont ou",
  de: "der die das und ist nicht mit für den dem ein eine zu von auf wir sie es bitte bis auch im des oder wird werden sind vor",
  pt: "o a os as de do da dos das que e em para com não um uma é por no na se mais você nós favor antes são está",
  it: "il lo la gli le di che e è per con non un una del della sono anche questo questa grazie prima entro",
  nl: "de het een en van is dat niet voor met op te zijn wij je ook naar graag alstublieft deze wordt",
  id: "yang dan di ke dari untuk ini itu dengan tidak kami kita anda akan ada pada mohon sudah bisa sebelum",
  tr: "ve bir bu için ile de da değil ne çok mi ama olarak lütfen var yok önce",
  pl: "i w z na nie się że do jest to jak po dla od proszę czy przed",
  sv: "och att det som en är på för med inte av till har vi ni jag innan",
};
const LEXICON = new Map();
for (const [lang, list] of Object.entries(WORDS)) {
  for (const word of list.split(" ")) {
    if (!LEXICON.has(word)) LEXICON.set(word, []);
    LEXICON.get(word).push(lang);
  }
}

// Letters that belong to a few languages and not to the others.
const MARKS = [
  [/[ñ¿¡]/g, "es", 2],
  [/[ãõ]/g, "pt", 2],
  [/ß/g, "de", 2],
  [/[äöü]/g, "de", 1],
  [/[ığş]/g, "tr", 2],
  [/[łąęśźżń]/g, "pl", 2],
  [/å/g, "sv", 2],
  [/[èêëîïûùœ]/g, "fr", 1],
  [/[ìò]/g, "it", 1],
];

// Vietnamese is Latin script, and its stacked diacritics are its own.
const VIETNAMESE = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;

function count(text, re) {
  return (text.match(re) || []).length;
}

function latinLanguage(text) {
  const lower = text.toLowerCase();
  if (count(lower, VIETNAMESE) >= 2) return "vi";
  const score = {};
  for (const word of lower.match(/\p{L}+/gu) || []) {
    for (const lang of LEXICON.get(word) || []) score[lang] = (score[lang] || 0) + 1;
  }
  for (const [re, lang, weight] of MARKS) {
    const n = count(lower, re);
    if (n) score[lang] = (score[lang] || 0) + weight * Math.min(n, 3);
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  // Two signals, and clearly ahead: anything less is a guess, and a wrong
  // "this is already yours" is the one mistake a reader cannot recover from.
  if (!top || top[1] < 2) return "und";
  if (second && top[1] < second[1] * 1.5) return "und";
  return top[0];
}

export function detectLanguage(text) {
  const sample = String(text || "");
  if (!sample.trim()) return null;
  let best = null;
  let bestScore = 0;
  const counts = {};
  for (const [script, re] of SCRIPTS) {
    counts[script] = count(sample, re);
  }
  // Japanese is han and kana together; han alone is Chinese.
  const cjk = counts.han + counts.kana;
  for (const [script, n] of Object.entries(counts)) {
    if (script === "han" || script === "kana") continue;
    const s = n * (WEIGHT[script] || 1);
    if (s > bestScore) { best = script; bestScore = s; }
  }
  if (cjk * 3 > bestScore) return counts.kana > 0 ? "ja" : "zh";
  if (!best) return null;
  if (best === "latin") return latinLanguage(sample);
  if (best === "cyrillic") {
    if (/[ґєії]/i.test(sample)) return "uk";
    return "ru";
  }
  if (best === "arabic") {
    if (/[ٹڈڑںے]/.test(sample)) return "ur";
    if (/[پچژگی]/.test(sample)) return "fa";
    return "ar";
  }
  return BY_SCRIPT[best] || "und";
}

/// The primary language of a locale tag: "ja-JP", "ja_JP" and "ja" are one
/// reader. Null for anything that is not a tag.
export function primaryLanguage(locale) {
  if (typeof locale !== "string") return null;
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

let names;
/// "Vietnamese" for "vi", for the prompt; null for a code no one speaks
/// ("xx"), which is how a made-up locale is told from a real one.
export function languageName(locale) {
  const code = primaryLanguage(locale);
  if (!code) return null;
  try {
    names ||= new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    const name = names.of(code);
    return name && name.toLowerCase() !== code ? name : null;
  } catch {
    return null;
  }
}
