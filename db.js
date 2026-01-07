// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'qa.db');
const DB_PATH_stok = process.env.DB_PATH || path.join(__dirname, 'data', 'stok.db');
const DB_PATH_admin = process.env.DB_PATH || path.join(__dirname, 'data', 'admin.db');



const db = new sqlite3.Database(DB_PATH);
const db_stok = new sqlite3.Database(DB_PATH_stok);
const db_admin = new sqlite3.Database(DB_PATH_admin);

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

db_admin.serialize(() => {
  db_admin.run(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);});

db_stok.serialize(() => {
db_stok.run(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    spec TEXT,
    price TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
});
// schedules table for rental scheduling (simple fields)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_type TEXT,
      plate TEXT,
      name TEXT,
      entry_text TEXT,
      period TEXT,
      customer TEXT,
      location TEXT,
      pickup TEXT,
      dropoff TEXT,
      time TEXT,
      price TEXT,
      start_date TEXT,
      end_date TEXT,
      start_time TEXT,
      end_time TEXT,
      total_price TEXT,
      pickup_day TEXT,
      pickup_time TEXT,
      delivery_day TEXT,
      delivery_time TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});
// motors table: store motor id, jenis (type) and plate
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS motors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jenis TEXT,
      plate TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});
// ensure required columns exist (migrate existing table if older schema)
db.all(`PRAGMA table_info(schedules)`, [], (err, cols) => {
  if (err) return console.error('PRAGMA table_info error:', err.message);
  const existing = (cols || []).map(c => c.name);
  const required = ['period','customer','location','time','price','entry_text','vehicle_type','plate','pickup','dropoff','start_date','end_date','start_time','end_time','total_price','name','pickup_day','pickup_time','delivery_day','delivery_time'];
  // include booking month column to support future bookings
  if (!existing.includes('bulan')) required.push('bulan');
  const toAdd = required.filter(c => !existing.includes(c));
  toAdd.forEach(col => {
    db.run(`ALTER TABLE schedules ADD COLUMN ${col} TEXT`, (e) => {
      if (e) console.error(`Failed to add column ${col}:`, e.message);
      else console.log(`Added missing column ${col} to schedules`);
    });
  });

  // add motor_id column if missing
  if (!existing.includes('motor_id')) {
    db.run(`ALTER TABLE schedules ADD COLUMN motor_id INTEGER`, (e) => {
      if (e) console.error('Failed to add motor_id to schedules:', e.message);
      else console.log('Added motor_id column to schedules');
    });
  }

  // migrate distinct plates into motors table and update schedules.motor_id
  db.all(`SELECT DISTINCT plate FROM schedules WHERE plate IS NOT NULL AND plate != ''`, [], (err, plates) => {
    if (err) return console.error('Failed to read distinct plates for migration:', err && err.message);
    plates.forEach(p => {
      const plateVal = p.plate;
      // check if motor already exists
      db.get(`SELECT id FROM motors WHERE plate = ?`, [plateVal], (err2, row2) => {
        if (err2) return console.error('Motor lookup error:', err2.message);
        if (row2 && row2.id) {
          db.run(`UPDATE schedules SET motor_id = ? WHERE plate = ?`, [row2.id, plateVal]);
        } else {
          db.run(`INSERT INTO motors (jenis, plate) VALUES (?, ?)`, ['', plateVal], function (e3) {
            if (e3) return console.error('Insert motor error:', e3.message);
            const mid = this.lastID;
            db.run(`UPDATE schedules SET motor_id = ? WHERE plate = ?`, [mid, plateVal]);
          });
        }
      });
    });
  });

  // seed with 10 sample entries (only if empty)
  db.get(`SELECT COUNT(*) as c FROM schedules`, [], (err2, row) => {
    if (err2) return console.error('seed check error', err2.message);
    if (row && row.c === 0) {
      const samples = [
        { vehicle_type: 'NMAX', plate: 'NMAX PUTIH 5292', entry_text: '2-4/sektio mukti wibowo/jw naungan/07.00/380', period: '2-4', customer: 'sektio mukti wibowo', location: 'jw naungan', time: '07.00', price: '380' },
        { vehicle_type: 'NMAX', plate: 'NMAX BIRU 3848 HU', entry_text: '3-4/beni/helin/19.00/150', period: '3-4', customer: 'beni', location: 'helin', time: '19.00', price: '150' },
        { vehicle_type: 'PCX', plate: 'PCX 6636 ES', entry_text: '2-3/slamet ari wibowo/balapan/09.30-09.00/200', period: '2-3', customer: 'slamet ari wibowo', location: 'balapan', time: '09.30-09.00', price: '200' },
        { vehicle_type: 'PCX', plate: 'PCX 6636 ES', entry_text: '3-3/ribhky amino saleh/purwosari-balapan/08.00-19.00/170', period: '3-3', customer: 'ribhky amino saleh', location: 'purwosari-balapan', time: '08.00-19.00', price: '170' },
        { vehicle_type: 'VARIO', plate: 'VARIO HITAM 4793 BAF', entry_text: '2-5/nanda putri andriani/lorin/15.00-12.00/330', period: '2-5', customer: 'nanda putri andriani', location: 'lorin', time: '15.00-12.00', price: '330' },
        { vehicle_type: 'VARIO', plate: 'VARIO MERAH 5306 APB', entry_text: '3-3/daffa ahmad reyhan/balapan/09.15-18.00/140', period: '3-3', customer: 'daffa ahmad reyhan', location: 'balapan', time: '09.15-18.00', price: '140' },
        { vehicle_type: 'SCOOPY', plate: 'SCOOPY 6382 BNE', entry_text: '3-3/nuraini putri salsabilla/balapan/09.00-17.00/130', period: '3-3', customer: 'nuraini putri salsabilla', location: 'balapan', time: '09.00-17.00', price: '130' },
        { vehicle_type: 'SCOOPY', plate: 'SCOOPY 6824 ATB', entry_text: '3-3/novendra bara mukti/cititrans-balapan/08.00-17.00/120', period: '3-3', customer: 'novendra bara mukti', location: 'cititrans-balapan', time: '08.00-17.00', price: '120' },
        { vehicle_type: 'BEAT', plate: 'BEAT 5756 BEE', entry_text: '2-4/lili agus supriyanto/orchid/14.00-08.00/230', period: '2-4', customer: 'lili agus supriyanto', location: 'orchid', time: '14.00-08.00', price: '230' },
        { vehicle_type: 'BEAT', plate: 'BEAT 6972 JC', entry_text: '2-4/asti eristiasa/dpalma/14.00/230', period: '2-4', customer: 'asti eristiasa', location: 'dpalma', time: '14.00', price: '230' }
      ];
          const stmt = db.prepare(`INSERT INTO schedules (vehicle_type, plate, name, entry_text, period, customer, location, pickup, dropoff, time, price, start_date, end_date, start_time, end_time, total_price, pickup_day, pickup_time, delivery_day, delivery_time, bulan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          samples.forEach(s => stmt.run(s.vehicle_type, s.plate, s.name || '', s.entry_text, s.period, s.customer, s.location, s.pickup || '', s.dropoff || '', s.time, s.price, s.start_date || '', s.end_date || '', s.start_time || '', s.end_time || '', s.total_price || '', s.pickup_day || '', s.pickup_time || '', s.delivery_day || '', s.delivery_time || '', s.bulan || ''));
      stmt.finalize();
      console.log('Seeded schedules table with sample data.');
    }
  });
});

db.all(`SELECT id, user, password, created_at FROM admin`, [], (err, rows) => {
  if (err) {
    console.error('Error membaca tabel admin:', err.message);
    return;
  }

  if (rows.length === 0) {
    console.log('Belum ada data admin.');
  } else {
    console.log('Daftar admin:');
    rows.forEach(row => {
      console.log(`${row.id}. ${row.user} | ${row.password} | ${row.created_at}`);
    });
  }

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

function updateQA(id, question, answer) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE qa SET question = ?, answer = ? WHERE id = ?`,
      [question, answer, id],
      function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes });
      }
    );
  });
}

function deleteQA(id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM qa WHERE id = ?`, [id], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function getQA(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, question, answer, created_at FROM qa WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

// minimal schedules CRUD: add and list
function addSchedule(item) {
  return new Promise((resolve, reject) => {
    const { vehicle_type, motor_id, plate, name, entry_text, period, customer, location, pickup, dropoff, time, price, start_date, end_date, start_time, end_time, total_price, pickup_day, pickup_time, delivery_day, delivery_time, bulan } = item;
    db.run(
      `INSERT INTO schedules (vehicle_type, motor_id, plate, name, entry_text, period, customer, location, pickup, dropoff, time, price, start_date, end_date, start_time, end_time, total_price, pickup_day, pickup_time, delivery_day, delivery_time, bulan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vehicle_type, motor_id || null, plate || '', name || '', entry_text || '', period || '', customer || '', location || '', pickup || '', dropoff || '', time || '', price || '', start_date || '', end_date || '', start_time || '', end_time || '', total_price || '', pickup_day || '', pickup_time || '', delivery_day || '', delivery_time || '', bulan || ''],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, ...item });
      }
    );
  });
}

function listSchedules() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT s.id, s.vehicle_type, s.motor_id, m.jenis as motor_jenis, m.plate as motor_plate, s.plate, s.name, s.entry_text, s.period, s.customer, s.location, s.pickup, s.dropoff, s.time, s.price, s.start_date, s.end_date, s.start_time, s.end_time, s.total_price, s.pickup_day, s.pickup_time, s.delivery_day, s.delivery_time, s.bulan, s.created_at FROM schedules s LEFT JOIN motors m ON s.motor_id = m.id ORDER BY s.id DESC LIMIT 100`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function listAllSchedules() {
  return new Promise((resolve, reject) => {
    // order by motor_id (ascending, nulls last) then by schedule id ascending
    db.all(`SELECT s.id, s.vehicle_type, s.motor_id, m.jenis as motor_jenis, m.plate as motor_plate, s.plate, s.name, s.entry_text, s.period, s.customer, s.location, s.pickup, s.dropoff, s.time, s.price, s.start_date, s.end_date, s.start_time, s.end_time, s.total_price, s.pickup_day, s.pickup_time, s.delivery_day, s.delivery_time, s.bulan, s.created_at FROM schedules s LEFT JOIN motors m ON s.motor_id = m.id ORDER BY COALESCE(s.motor_id, 999999), s.motor_id, s.id ASC`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Return schedules for full listing: exclude future 'bulan' bookings until their day arrives.
function listSchedulesFull() {
  return new Promise(async (resolve, reject) => {
    try {
      const rows = await listAllSchedules();
      const ddmmToDate = (ddmm, bulanHint) => {
        if (!ddmm) return null;
        const s = String(ddmm).trim();
        // yyyy-mm-dd
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10) - 1, parseInt(m[3],10));
        // dd/mm or dd/mm/yyyy
        m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (m) {
          const day = parseInt(m[1], 10);
          const month = parseInt(m[2], 10);
          const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10)) : (new Date()).getFullYear();
          return new Date(year, month - 1, day);
        }
        // single day like '9' -> use bulanHint if present, otherwise current month/year
        m = s.match(/^(\d{1,2})$/);
        if (m) {
          const day = parseInt(m[1],10);
          let month = (new Date()).getMonth() + 1;
          let year = (new Date()).getFullYear();
          if (bulanHint) {
            const bh = String(bulanHint).trim();
            const bhm = bh.match(/^(\d{1,2})(?:\/(\d{2,4}))?$/);
            if (bhm) {
              month = parseInt(bhm[1],10);
              if (bhm[2]) year = bhm[2].length === 2 ? 2000 + parseInt(bhm[2],10) : parseInt(bhm[2],10);
            }
          }
          return new Date(year, month - 1, day);
        }
        return null;
      };
      const timeToMinutes = (t) => {
        if (!t) return null;
        const mm = String(t).match(/(\d{1,2})[:\.]?(\d{2})?/);
        if (!mm) return null;
        const hh = parseInt(mm[1], 10);
        const mn = mm[2] ? parseInt(mm[2], 10) : 0;
        return hh * 60 + mn;
      };

      const computeStartDate = (r) => {
        let d = null; let m = null;
        if (r.start_date && r.start_time) { d = ddmmToDate(r.start_date, r.bulan); m = timeToMinutes(r.start_time); }
        if (!d && r.pickup_day && r.pickup_time) { d = ddmmToDate(r.pickup_day, r.bulan); m = timeToMinutes(r.pickup_time); }
        if (!d && r.delivery_day && r.delivery_time) { d = ddmmToDate(r.delivery_day, r.bulan); m = timeToMinutes(r.delivery_time); }
        if (!d) return null;
        const dt = new Date(d.getTime());
        if (m != null) dt.setHours(0,0,0,0), dt.setMinutes(m);
        return dt;
      };

      const today = new Date();
      const todayDay = today.getDate();
      const todayMonth = today.getMonth() + 1;

      const filtered = rows.filter(r => {
        const bulan = (r.bulan || '').toString().trim();
        if (!bulan) return true; // normal schedule, show
        // for bookings with bulan set: only show when the start date equals today
        const sd = computeStartDate(r);
        if (!sd) return false;
        return sd.getDate() === todayDay && (sd.getMonth() + 1) === todayMonth;
      });

      // sort by computed start datetime (best-effort) then id
      const withTs = filtered.map(r => {
        const sd = computeStartDate(r);
        return { r, ts: sd ? sd.getTime() : 0 };
      });
      withTs.sort((a,b) => {
        if (a.ts === b.ts) return a.r.id - b.r.id;
        if (a.ts === 0) return 1;
        if (b.ts === 0) return -1;
        return a.ts - b.ts;
      });
      resolve(withTs.map(x => x.r));
    } catch (e) {
      reject(e);
    }
  });
}

function getLatestScheduleByPlate(plate) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, vehicle_type, motor_id, plate, name, entry_text, period, customer, location, pickup, dropoff, time, price, start_date, end_date, start_time, end_time, total_price, pickup_day, pickup_time, delivery_day, delivery_time, bulan, created_at FROM schedules WHERE plate = ? ORDER BY id DESC LIMIT 1`, [plate], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getLatestScheduleByMotorId(motorId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT s.id, s.vehicle_type, s.motor_id, m.jenis as motor_jenis, m.plate as motor_plate, s.plate, s.name, s.entry_text, s.period, s.customer, s.location, s.pickup, s.dropoff, s.time, s.price, s.start_date, s.end_date, s.start_time, s.end_time, s.total_price, s.pickup_day, s.pickup_time, s.delivery_day, s.delivery_time, s.bulan, s.created_at FROM schedules s LEFT JOIN motors m ON s.motor_id = m.id WHERE s.motor_id = ? ORDER BY s.id DESC LIMIT 1`, [motorId], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getMotorById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, jenis, plate, created_at FROM motors WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function addMotor(jenis, plate) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO motors (jenis, plate) VALUES (?, ?)`, [jenis || '', plate || ''], function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, jenis: jenis || '', plate: plate || '' });
    });
  });
}

function listMotors() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, jenis, plate, created_at FROM motors ORDER BY id`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// Find available motors within a time window starting at `startMs` (milliseconds) for `hours` hours.
function findAvailableMotorsWindow(startMs, hours) {
  return new Promise(async (resolve, reject) => {
    try {
      const motors = await listMotors();
      const schedules = await listAllSchedules();

      const windowStart = Number(startMs) || Date.now();
      const windowEnd = windowStart + (Number(hours) || 12) * 3600 * 1000;

      // helper to parse date-like strings into Date (supports D, DD/MM, DD/MM/YYYY, YYYY-MM-DD)
      // If `bulanHint` provided (e.g. row.bulan) and ddmm is single-day like '9', use that month/year.
      const ddmmToDate = (ddmm, bulanHint) => {
        if (!ddmm) return null;
        const s = String(ddmm).trim();
        // yyyy-mm-dd
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10) - 1, parseInt(m[3],10));
        // dd/mm or dd/mm/yyyy
        m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (m) {
          const day = parseInt(m[1],10);
          const month = parseInt(m[2],10);
          const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10)) : (new Date()).getFullYear();
          return new Date(year, month - 1, day);
        }
        // single day like '9' -> use bulanHint if present, otherwise current month/year
        m = s.match(/^(\d{1,2})$/);
        if (m) {
          const day = parseInt(m[1],10);
          let month = (new Date()).getMonth() + 1;
          let year = (new Date()).getFullYear();
          if (bulanHint) {
            const bh = String(bulanHint).trim();
            const bhm = bh.match(/^(\d{1,2})(?:\/(\d{2,4}))?$/);
            if (bhm) {
              month = parseInt(bhm[1],10);
              if (bhm[2]) year = bhm[2].length === 2 ? 2000 + parseInt(bhm[2],10) : parseInt(bhm[2],10);
            }
          }
          return new Date(year, month - 1, day);
        }
        return null;
      };
      const timeToMinutes = (t) => {
        if (!t) return null;
        const mm = String(t).match(/(\d{1,2})[:\.]?(\d{2})?/);
        if (!mm) return null;
        const hh = parseInt(mm[1], 10);
        const mn = mm[2] ? parseInt(mm[2], 10) : 0;
        return hh * 60 + mn;
      };

      const scheduleIntervalMs = (row) => {
        // Determine start (pickup/start) and end (delivery/end) as Date in ms.
        let startDate = null, endDate = null;
        if (row.pickup_day && row.pickup_time) {
          const pd = ddmmToDate(row.pickup_day, row.bulan);
          const pm = timeToMinutes(row.pickup_time);
          if (pd && pm != null) {
            const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm);
            startDate = d;
          }
        }
        if (!startDate && row.start_date && row.start_time) {
          const sd = ddmmToDate(row.start_date, row.bulan);
          const sm = timeToMinutes(row.start_time);
          if (sd && sm != null) {
            const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm);
            startDate = d;
          }
        }

        if (row.delivery_day && row.delivery_time) {
          const dd = ddmmToDate(row.delivery_day, row.bulan);
          const dm = timeToMinutes(row.delivery_time);
          if (dd && dm != null) {
            const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm);
            endDate = d;
          }
        }
        if (!endDate && row.end_date && row.end_time) {
          const ed = ddmmToDate(row.end_date, row.bulan);
          const em = timeToMinutes(row.end_time);
          if (ed && em != null) {
            const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em);
            endDate = d;
          }
        }

        // If only one side is present, treat as point-in-time (start==end)
        if (startDate && !endDate) endDate = new Date(startDate.getTime());
        if (!startDate && endDate) startDate = new Date(endDate.getTime());
        if (!startDate && !endDate) return null;
        return { startMs: startDate.getTime(), endMs: endDate.getTime() };
      };

      const available = [];
      for (const m of motors) {
        const motorSchedules = schedules.filter(s => (s.motor_id != null && String(s.motor_id) === String(m.id)) || ((s.motor_plate || s.plate || '') && (s.motor_plate || s.plate || '').toLowerCase() === (m.plate || '').toLowerCase()));
        let busy = false;
        for (const s of motorSchedules) {
          const iv = scheduleIntervalMs(s);
          if (!iv) continue;
          if (iv.endMs >= windowStart && iv.startMs <= windowEnd) { busy = true; break; }
        }
        if (!busy) available.push(m);
      }

      resolve(available);
    } catch (e) {
      reject(e);
    }
  });
}

function deleteMotor(id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM motors WHERE id = ?`, [id], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function clearData() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Do NOT delete schedules here — user requested manual deletion via chat.
      db.run(`DELETE FROM motors`, (e2) => {
        if (e2) return reject(e2);
        db.run(`DELETE FROM products`, (e3) => {
          if (e3) return reject(e3);
          db.run(`DELETE FROM qa`, (e4) => {
            if (e4) return reject(e4);
            resolve({ success: true });
          });
        });
      });
    });
  });
}

function clearSchedules() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM schedules`, function(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function deleteSchedule(id) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM schedules WHERE id = ?`, [id], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function deleteSchedulesByPickupDay(dayString) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM schedules WHERE pickup_day = ? OR start_date = ?`, [dayString, dayString], function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

function listPlates() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT id, jenis, plate FROM motors ORDER BY id LIMIT 200`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}



module.exports = { db,db_stok,db_admin, addQA, listQA, findBestMatch, updateQA, deleteQA, getQA, addSchedule, listSchedules, listAllSchedules, listSchedulesFull, getLatestScheduleByPlate, getLatestScheduleByMotorId, getMotorById, addMotor, listMotors, deleteMotor, clearData, deleteSchedule, deleteSchedulesByPickupDay, clearSchedules, listPlates, findAvailableMotorsWindow };
