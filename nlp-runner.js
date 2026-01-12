const { NlpManager } = require('node-nlp');
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, 'data', 'nlp_model.nlp');

let manager = null;

async function ensureManager() {
  if (manager) return manager;
  manager = new NlpManager({ languages: ['id'], forceNER: true });
  if (fs.existsSync(MODEL_PATH)) {
    try {
      await manager.load(MODEL_PATH);
    } catch (e) {
      console.error('Failed to load NLP model:', e);
    }
  } else {
    console.warn('NLP model not found at', MODEL_PATH, '— run `node nlp-train.js` to create it.');
  }
  return manager;
}

async function getAnswer(text, lang = 'id') {
  const m = await ensureManager();
  if (!m) return null;
  try {
    const res = await m.process(lang, text);
    if (res && res.answer) return res.answer;
    if (res && res.answers && res.answers.length) return res.answers[0].answer;
    return null;
  } catch (e) {
    console.error('NLP process error:', e);
    return null;
  }
}

async function processText(text, lang = 'id') {
  const m = await ensureManager();
  if (!m) return null;
  try {
    return await m.process(lang, text);
  } catch (e) {
    console.error('NLP process error:', e);
    return null;
  }
}

module.exports = { getAnswer, ensureManager, processText };
