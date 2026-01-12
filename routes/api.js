const fs = require('fs');
const xlsx = require('xlsx');

module.exports = (app, deps) => {
  const { db, db_stok, db_admin, upload, client, sessions, MessageMedia } = deps;

  // Upload Excel -> products
  app.post('/api/upload-excel', upload.single('file'), async (req, res) => {
    try {
      const filePath = req.file.path;
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet);

      const stmt = db_stok.prepare(`INSERT INTO products (name, spec, price) VALUES (?, ?, ?)`);
      rows.forEach(r => {
        stmt.run(r.Name, r.Spec, r.Price);
      });
      stmt.finalize();

      fs.unlinkSync(filePath);
      res.json({ success: true, count: rows.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload Excel gagal', details: err.message });
    }
  });

  // QA endpoints
  app.get('/api/qa', async (req, res) => {
    try {
      const rows = await (db.listQA ? db.listQA() : require('../db').listQA());
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: 'DB error', details: err.message });
    }
  });

  app.post('/api/qa', async (req, res) => {
    const { question, answer } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
    try {
      const row = await (db.addQA ? db.addQA(question, answer) : require('../db').addQA(question, answer));
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: 'DB error', details: err.message });
    }
  });

  app.put('/api/qa/:id', async (req, res) => {
    const id = req.params.id; const { question, answer } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
    try {
      const result = await (db.updateQA ? db.updateQA(id, question, answer) : require('../db').updateQA(id, question, answer));
      if (result.changes === 0) return res.status(404).json({ error: 'QA not found' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.delete('/api/qa/:id', async (req, res) => {
    const id = req.params.id;
    try {
      const result = await (db.deleteQA ? db.deleteQA(id) : require('../db').deleteQA(id));
      if (result.changes === 0) return res.status(404).json({ error: 'QA not found' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.get('/api/status', (req, res) => res.json({ ok: true }));

  // schedules endpoints
  app.get('/api/schedules', async (req, res) => {
    try {
      const rows = await (db.listSchedules ? db.listSchedules() : require('../db').listSchedules());
      res.json(rows);
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.get('/api/schedules/full', async (req, res) => {
    try {
      if (!db.listSchedulesFull) return res.status(500).json({ error: 'DB missing listSchedulesFull' });
      const rows = await db.listSchedulesFull();
      res.json(rows);
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.delete('/api/schedules/:id', async (req, res) => {
    const id = req.params.id; if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const result = await (db.deleteSchedule ? db.deleteSchedule(id) : require('../db').deleteSchedule(id));
      if (!result || result.changes === 0) return res.status(404).json({ error: 'Schedule not found' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  // plates
  app.get('/api/plates', async (req, res) => {
    try { if (!db.listPlates) return res.json([]); const rows = await db.listPlates(); res.json(rows); } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  // motors
  app.get('/api/motors', async (req, res) => {
    try { const rows = await (db.listPlates ? db.listPlates() : require('../db').listPlates()); res.json(rows); } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.post('/api/motors', async (req, res) => {
    try {
      const { jenis, plate } = req.body || {};
      if (!plate) return res.status(400).json({ error: 'plate required' });
      const { harga_24, harga_12 } = req.body || {};
      const sql = `INSERT INTO motors (jenis, plate, harga_24, harga_12) VALUES (?, ?, ?, ?)`;
      db.db.run(sql, [jenis || '', plate, harga_24 || '', harga_12 || ''], function(err) {
        if (err) return res.status(500).json({ error: 'DB error', details: err.message });
        res.json({ id: this.lastID, jenis: jenis || '', plate });
      });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.put('/api/motors/:id', async (req, res) => {
    const id = req.params.id; const { jenis, plate, harga_24, harga_12 } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const result = await (db.updateMotor ? db.updateMotor(id, jenis || '', plate || '', harga_24 || '', harga_12 || '') : null);
      if (result && result.changes === 0) return res.status(404).json({ error: 'Motor not found or no change' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });

  app.post('/api/motors/change-id', async (req, res) => {
    try {
      const { oldId, newId } = req.body || {};
      if (!oldId || !newId) return res.status(400).json({ error: 'oldId and newId required' });
      if (isNaN(Number(oldId)) || isNaN(Number(newId))) return res.status(400).json({ error: 'IDs must be numeric' });
      const result = await (db.changeMotorId ? db.changeMotorId(oldId, newId) : require('../db').changeMotorId(oldId, newId));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'DB error', details: err && err.message }); }
  });

  // create schedule
  app.post('/api/schedules', async (req, res) => {
    try {
      const item = req.body || {};
      if (!item.vehicle_type) return res.status(400).json({ error: 'vehicle_type required' });
      const plate = (item.plate || '').trim(); if (!plate) return res.status(400).json({ error: 'plate required' });
      if (!item.name) return res.status(400).json({ error: 'name is required' });

      // (parsers and validation copied from original server.js)
      const parsePeriodToDates = (p) => {
        if (!p) return { startDate: null, endDate: null };
        const raw = p.replace(/\s+/g,''); const parts = raw.split('-'); const now = new Date(); const thisYear = now.getFullYear(); const thisMonth = now.getMonth() + 1;
        const parsePart = (part) => { const m1 = part.match(/^(\d{1,2})\/(\d{1,2})$/); if (m1) { const day = parseInt(m1[1],10); const month = parseInt(m1[2],10); return new Date(thisYear, month - 1, day); } const m2 = part.match(/^(\d{1,2})$/); if (m2) { const day = parseInt(m2[1],10); return new Date(thisYear, thisMonth - 1, day); } return null; };
        const startDate = parsePart(parts[0]); let endDate = null; if (parts.length > 1) endDate = parsePart(parts[1]); if (!endDate && startDate) endDate = startDate; return { startDate, endDate };
      };
      const toMinutes = (hhmm) => { if (!hhmm) return null; const m = hhmm.match(/(\d{1,2})[:\.]?(\d{2})?/); if (!m) return null; const hh = parseInt(m[1],10); const mm = m[2] ? parseInt(m[2],10) : 0; return hh*60 + mm; };
      const parseEntryText = (txt) => {
        const parts = (txt||'').split('/').map(p=>p.trim()).filter(Boolean); let period=''; let time=''; let pickup=''; let dropoff=''; let customer=''; let price='';
        if (parts.length>0 && /^(\d+)(?:-\d+)?$/.test(parts[0].replace(/\s+/g,''))) { period = parts.shift(); }
        const timeIdx = parts.findIndex(p=>/\d{1,2}[:\.]?\d{0,2}(?:\s*[-–—\/]\s*\d{1,2}[:\.]?\d{0,2})?/.test(p)); if (timeIdx !== -1) { time = parts.splice(timeIdx,1)[0]; }
        if (parts.length && /^\d+$/.test(parts[parts.length-1])) { price = parts.pop(); }
        if (parts.length) { const locIdx = parts.findIndex(p=>/[-–—]/.test(p)); if (locIdx !== -1) { const p = parts.splice(locIdx,1)[0]; const [a,b] = p.split(/[-–—]/).map(s=>s.trim()); pickup = a || ''; dropoff = b || a || ''; } }
        if (!pickup && parts.length) { pickup = parts.shift() || ''; dropoff = pickup; }
        if (parts.length) { customer = parts.join(' / '); }
        return { period, time, pickup, dropoff, customer, price };
      };
      if (item.entry_text) {
        const parsed = parseEntryText(item.entry_text);
        item.period = item.period || parsed.period; item.time = item.time || parsed.time; item.pickup = parsed.pickup || item.pickup; item.dropoff = parsed.dropoff || item.dropoff; item.customer = item.customer || parsed.customer; item.price = item.price || parsed.price;
      }
      const ddmmToDate = (ddmm) => { if (!ddmm) return null; const m = ddmm.match(/^(\d{1,2})\/(\d{1,2})$/); if (!m) return null; const day = parseInt(m[1],10); const month = parseInt(m[2],10); if (month < 1 || month > 12) return null; const now = new Date(); const year = now.getFullYear(); const daysInMonth = new Date(year, month, 0).getDate(); if (day < 1 || day > daysInMonth) return null; return new Date(year, month - 1, day); };
      const timeToMinutes = (t) => { if (!t) return null; const m = t.match(/(\d{1,2})[:\.](\d{2})/); if (!m) return null; return parseInt(m[1],10)*60 + parseInt(m[2],10); };

      if (item.pickup_explicit) item.pickup = item.pickup_explicit; if (item.dropoff_explicit) item.dropoff = item.dropoff_explicit; if (item.total_price) item.price = item.total_price;

      let newPickupAbs = null; let newDeliveryAbs = null;
      if (item.pickup_day && item.pickup_time) { const pd = ddmmToDate(item.pickup_day); const pm = timeToMinutes(item.pickup_time); if (!pd || pm == null) return res.status(400).json({ error: 'Invalid pickup day/time' }); const pdt = new Date(pd.getTime()); pdt.setHours(0,0,0,0); pdt.setMinutes(pm); newPickupAbs = Math.floor(pdt.getTime()/60000); } else if (item.start_date && item.start_time) { const sd = ddmmToDate(item.start_date) || null; const sm = timeToMinutes(item.start_time); if (sd && sm != null) { const sdt = new Date(sd.getTime()); sdt.setHours(0,0,0,0); sdt.setMinutes(sm); newPickupAbs = Math.floor(sdt.getTime()/60000); } }
      if (item.delivery_day && item.delivery_time) { const dd = ddmmToDate(item.delivery_day); const dm = timeToMinutes(item.delivery_time); if (!dd || dm == null) return res.status(400).json({ error: 'Invalid delivery day/time' }); const ddt = new Date(dd.getTime()); ddt.setHours(0,0,0,0); ddt.setMinutes(dm); newDeliveryAbs = Math.floor(ddt.getTime()/60000); } else if (item.end_date && item.end_time) { const ed = ddmmToDate(item.end_date) || null; const em = timeToMinutes(item.end_time); if (ed && em != null) { const edt = new Date(ed.getTime()); edt.setHours(0,0,0,0); edt.setMinutes(em); newDeliveryAbs = Math.floor(edt.getTime()/60000); } }

      if (newDeliveryAbs != null) { const delM = timeToMinutes(item.delivery_time || item.end_time || ''); if (delM != null && delM < 6*60) return res.status(400).json({ error: 'Delivery (antar) earliest is 06:00' }); }
      if (newPickupAbs != null) { const pickM = timeToMinutes(item.pickup_time || item.start_time || ''); if (pickM != null && pickM > 23*60) return res.status(400).json({ error: 'Pickup (ambil) latest is 23:00' }); }

      let latest = null;
      if (item.motor_id) latest = await db.getLatestScheduleByMotorId(item.motor_id).catch(() => null); else latest = await db.getLatestScheduleByPlate(plate).catch(() => null);
      if (latest) {
        const lastPickupDay = latest.pickup_day || latest.start_date || null; const lastPickupTime = latest.pickup_time || latest.start_time || null;
        if (lastPickupDay && lastPickupTime) {
          const lpd = ddmmToDate(lastPickupDay); const lpm = timeToMinutes(lastPickupTime);
          if (lpd && lpm != null) {
            const ldt = new Date(lpd.getTime()); ldt.setHours(0,0,0,0); ldt.setMinutes(lpm);
            const lastPickupAbs = Math.floor(ldt.getTime()/60000);
            if (newDeliveryAbs != null) { const MIN_GAP = 30; if (newDeliveryAbs < lastPickupAbs + MIN_GAP) return res.status(400).json({ error: `Delivery time must be at least ${MIN_GAP} minutes after last pickup for this vehicle` }); }
            if (item.delivery_day) { const lastDayOnly = new Date(lpd.getFullYear(), lpd.getMonth(), lpd.getDate()); const newD = ddmmToDate(item.delivery_day); if (newD) { const newDayOnly = new Date(newD.getFullYear(), newD.getMonth(), newD.getDate()); if (newDayOnly.getTime() < lastDayOnly.getTime()) return res.status(400).json({ error: 'Delivery day must be the same day or after the last pickup day for this vehicle' }); } }
          }
        }
      }

      const row = await db.addSchedule(item);
      res.json(row);
    } catch (err) { res.status(500).json({ error: 'DB error', details: err.message }); }
  });
};
