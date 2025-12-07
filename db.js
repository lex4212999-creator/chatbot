// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'qa.db');

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS qa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

function addQA(question, answer) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO qa (question, answer) VALUES (?, ?)`,
      [question, answer],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, question, answer });
      }
    );
  });
}

function listQA() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, question, answer, created_at FROM qa ORDER BY id DESC`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function findBestMatch(userText) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, question, answer FROM qa`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

module.exports = { db, addQA, listQA, findBestMatch };
