// nlp.js
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();

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
  return tokenizer.tokenize(text.toLowerCase()).join(' ');
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

module.exports = { bestAnswer, normalize, textSimilarity };
