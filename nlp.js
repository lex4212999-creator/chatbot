// nlp.js
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();

// optional Indonesian stemmer (sastrawi). If not installed, fall back to Porter stemmer.
let sastrawiStemmer = null;
try {
  const { StemmerFactory } = require('sastrawi');
  const factory = new StemmerFactory();
  sastrawiStemmer = factory.createStemmer();
} catch (e) {
  sastrawiStemmer = null;
}

// Lightweight Indonesian stopwords (can be extended)
const stopwords = new Set((
  'yang,di,ke,ke,dan,atau,untuk,pada,ini,itu,ada,tidak,dengan,oleh,karena,agar,atau,saja,harus,apa,siapa,kapan,dimana'
).split(',').map(s => s.trim()).filter(Boolean));

// synonym map to normalize common variations
const synonyms = {
  'boking': 'booking', 'tgl': 'tanggal', 'tgl.': 'tanggal', 'tgl,': 'tanggal', 'siap': 'tersedia', 'ada gak': 'ada', 'gak ada': 'tidak ada'
};

let nlpOptions = { preferSastrawi: !!sastrawiStemmer };

function setNlpOptions(opts) {
  nlpOptions = Object.assign(nlpOptions, opts || {});
}

// Cosine similarity dengan TF-IDF sederhana
function textSimilarity(a, b) {
  const tfidf = new natural.TfIdf();
  tfidf.addDocument(a);
  tfidf.addDocument(b);

  const vocab = new Set();
  tfidf.documents.forEach(doc => {
    Object.keys(doc).forEach(k => vocab.add(k));
  });

  function vec(docIndex) {
    const v = [];
    vocab.forEach(term => {
      v.push(tfidf.tfidf(term, docIndex));
    });
    return v;
  }

  const v1 = vec(0);
  const v2 = vec(1);

  const dot = v1.reduce((sum, val, i) => sum + val * v2[i], 0);
  const mag1 = Math.sqrt(v1.reduce((sum, val) => sum + val * val, 0));
  const mag2 = Math.sqrt(v2.reduce((sum, val) => sum + val * val, 0));
  if (mag1 === 0 || mag2 === 0) return 0;
  return dot / (mag1 * mag2);
}

function normalize(text) {
  let lower = (text || '').toLowerCase();
  // apply synonym replacements
  Object.keys(synonyms).forEach(k => {
    lower = lower.replace(new RegExp('\\b' + k + '\\b', 'gi'), synonyms[k]);
  });
  const tokens = tokenizer.tokenize(lower).map(t => t.replace(/[^a-z0-9\/\:\.\-]+/gi, '')).filter(Boolean);
  // remove stopwords
  const filtered = tokens.filter(t => !stopwords.has(t));
  // apply stemming: prefer sastrawi if option enabled, otherwise Porter
  if (nlpOptions.preferSastrawi && sastrawiStemmer) {
    const stemmed = sastrawiStemmer.stem(filtered.join(' '));
    return tokenizer.tokenize(stemmed).join(' ');
  }
  const stemmedTokens = filtered.map(t => natural.PorterStemmer.stem(t));
  return stemmedTokens.join(' ');
}

function bestAnswer(userText, qaList, threshold = 0.25) {
  const userNorm = normalize(userText);
  let best = { score: 0, answer: null };
  for (const row of qaList) {
    const qNorm = normalize(row.question);
    const score = textSimilarity(userNorm, qNorm);
    if (score > best.score) {
      best = { score, answer: row.answer };
    }
  }
  if (best.score >= threshold) return best.answer;
  return null;
}

// Parse simple availability requests like "apa ada motor ready" or "motor tersedia dari jam 10 untuk 12 jam"
function parseAvailabilityRequest(text) {
  if (!text || typeof text !== 'string') return null;
  let lower = text.toLowerCase();
  // normalize synonyms early
  Object.keys(synonyms).forEach(k => {
    lower = lower.replace(new RegExp('\\b' + k + '\\b', 'gi'), synonyms[k]);
  });
  // quick intent detection: must mention motor and ask about availability
  if (!/motor/.test(lower)) return null;
  if (!/(ready|tersedia|ada|available|siap)/.test(lower)) return null;

  // detect hours window (e.g., '12 jam', '24 jam')
  const hoursMatch = lower.match(/(\d{1,2})\s*jam/);
  let hours = 12;
  if (hoursMatch) {
    const h = parseInt(hoursMatch[1], 10);
    if (!isNaN(h)) hours = h;
  }

  // detect start time: 'dari jam 10' or 'mulai jam 10:30' or 'sekarang'
  // detect date expressions like 'tgl 9', 'tanggal 9/2', 'pada 2026-02-09'
  let start = new Date();
  if (/sekarang/.test(lower)) {
    start = new Date();
  } else {
    const dateMatch = lower.match(/(?:tgl|tanggal|pada)\s*(\d{1,2}(?:[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)?|\d{4}-\d{1,2}-\d{1,2})/);
    if (dateMatch) {
      const raw = dateMatch[1];
      // try yyyy-mm-dd
      const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (ymd) {
        start = new Date(parseInt(ymd[1],10), parseInt(ymd[2],10)-1, parseInt(ymd[3],10));
      } else {
        const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
        if (dmy) {
          const day = parseInt(dmy[1],10);
          const month = parseInt(dmy[2],10);
          const now = new Date();
          const year = dmy[3] ? (dmy[3].length===2 ? 2000+parseInt(dmy[3],10) : parseInt(dmy[3],10)) : now.getFullYear();
          start = new Date(year, month-1, day);
        } else {
          // single day only
          const sd = raw.match(/^(\d{1,2})$/);
          if (sd) {
            const day = parseInt(sd[1],10);
            const now = new Date();
            start = new Date(now.getFullYear(), now.getMonth(), day);
          }
        }
      }
    } else {
      const tmatch = lower.match(/(?:dari|mulai)\s*jam\s*(\d{1,2})(?::|\.)?(\d{2})?/);
      if (tmatch) {
        const hh = parseInt(tmatch[1], 10);
        const mm = tmatch[2] ? parseInt(tmatch[2], 10) : 0;
        if (!isNaN(hh)) {
          const now = new Date();
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm || 0, 0, 0);
        }
      }
    }
  }

  return { start, hours };
}

// Parse booking requests like "mau boking tgl 12/01" or "booking tanggal 2026-01-12 jam 10"
function parseBookingRequest(text) {
  if (!text || typeof text !== 'string') return null;
  let lower = text.toLowerCase();
  // apply synonym normalization
  Object.keys(synonyms).forEach(k => {
    lower = lower.replace(new RegExp('\\b' + k + '\\b', 'gi'), synonyms[k]);
  });
  if (!/(boking|booking|pesan|mau boking|mau booking|mau pesan)/.test(lower)) return null;
  // find date patterns: dd/mm, dd-mm, yyyy-mm-dd
  const dateMatch = lower.match(/(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)|(?:\d{4}[\-]\d{1,2}[\-]\d{1,2})/);
  if (!dateMatch) return null;
  const raw = dateMatch[0];
  let start = null;
  // try yyyy-mm-dd
  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const y = parseInt(ymd[1],10), m = parseInt(ymd[2],10), d = parseInt(ymd[3],10);
    start = new Date(y, m-1, d, 0, 0, 0, 0);
  } else {
    const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
    if (dmy) {
      const day = parseInt(dmy[1],10);
      const month = parseInt(dmy[2],10);
      const now = new Date();
      const year = dmy[3] ? (dmy[3].length === 2 ? 2000 + parseInt(dmy[3],10) : parseInt(dmy[3],10)) : now.getFullYear();
      start = new Date(year, month-1, day, 0, 0, 0, 0);
    }
  }
  if (!start) return null;

  // optional time 'jam HH[:MM]' or 'pukul HH[:MM]'
  let hoursWindow = 24; // default, full day
  const timeMatch = lower.match(/(?:jam|pukul)\s*(\d{1,2})(?::|\.)?(\d{2})?/);
  if (timeMatch) {
    const hh = parseInt(timeMatch[1],10);
    const mm = timeMatch[2] ? parseInt(timeMatch[2],10) : 0;
    start.setHours(hh, mm, 0, 0);
    // if user specified duration like 'untuk 12 jam' or 'selama 24 jam'
    const durMatch = lower.match(/(?:untuk|selama)\s*(\d{1,2})\s*jam/);
    if (durMatch) hoursWindow = parseInt(durMatch[1],10) || 24;
    else hoursWindow = 12; // default shorter window when time provided
  } else {
    // if user wrote 'untuk X jam' without explicit time
    const durMatch2 = lower.match(/(?:untuk|selama)\s*(\d{1,2})\s*jam/);
    if (durMatch2) hoursWindow = parseInt(durMatch2[1],10) || 24;
  }

  return { start, hours: hoursWindow };
}
module.exports = { bestAnswer, normalize, textSimilarity, parseAvailabilityRequest, parseBookingRequest, setNlpOptions };

