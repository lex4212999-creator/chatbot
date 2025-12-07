// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const { WhatsAppService } = require('./whatsapp');
const { addQA, listQA, findBestMatch } = require('./db');
const { bestAnswer } = require('./nlp');

const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'data', 'session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wa = new WhatsAppService(SESSION_PATH);

// Push QR & status ke frontend
wa.on('qr', (qr) => {
  io.emit('qr', { qr });
});
wa.on('status', (status) => {
  io.emit('status', status);
});

// Handle pesan masuk
wa.onMessage(async (msg) => {
  try {
    const text = msg.body || '';
    const qaRows = await findBestMatch(text);
    const answer = bestAnswer(text, qaRows, 0.25);

    if (answer) {
      await wa.sendMessage(msg.from, answer);
    } else {
      await wa.sendMessage(msg.from, 'Maaf, aku belum punya jawaban untuk itu. Tambahkan di dashboard ya.');
    }
  } catch (err) {
    console.error('Message handling error', err);
  }
});

// API daftar QA
app.get('/api/qa', async (req, res) => {
  try {
    const rows = await listQA();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// API tambah QA
app.post('/api/qa', async (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) {
    return res.status(400).json({ error: 'Question and answer required' });
  }
  try {
    const row = await addQA(question, answer);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// API status WA
app.get('/api/status', (req, res) => {
  // Status terbaru dikirim via socket. Endpoint ini sederhana saja.
  res.json({ ok: true });
});
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
