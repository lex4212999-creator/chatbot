// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const { WhatsAppService } = require('./whatsapp');
const { addQA, listQA, db_stok, db_admin } = require('./db');
const db = require('./db');

const { bestAnswer, parseAvailabilityRequest, parseBookingRequest } = require('./nlp');
const nlpRunner = require('./nlp-runner');

const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'data', 'session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'data', 'uploads') });

let sessions = {};


app.post('/api/upload-excel', upload.single('file'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    // masukkan ke tabel products
    const stmt = db_stok.prepare(`INSERT INTO products (name, spec, price) VALUES (?, ?, ?)`);
    rows.forEach(r => {
      stmt.run(r.Name, r.Spec, r.Price);
    });
    stmt.finalize();

    fs.unlinkSync(filePath); // hapus file setelah diproses
    res.json({ success: true, count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload Excel gagal', details: err.message });
  }
});

const client = new WhatsAppService(SESSION_PATH);
const { MessageMedia } = require('whatsapp-web.js');

// Push QR & status ke frontend
client.on('qr', (qr) => {
  io.emit('qr', { qr });
});
client.on('status', (status) => {
  io.emit('status', status);
});

// Handle pesan masuk
client.onMessage(async (msg) => {
  const text = (msg.body || '').trim();
  const from = msg.from;

  // helper: resolve motor input (id, plate, or jenis). returns {found} or {ambiguous: [...] } or null
  const resolveMotor = async (motorVal) => {
    if (!motorVal) return null;
    const asId = parseInt(String(motorVal).trim(), 10);
    if (!isNaN(asId)) {
      const byId = (db.getMotorById) ? await db.getMotorById(asId).catch(() => null) : null;
      if (byId) return { found: byId };
    }
    if (!db.listMotors) return null;
    const motors = await db.listMotors().catch(() => []);
    const val = String(motorVal || '').toLowerCase().trim();
    // exact plate match
    let found = motors.find(m => (m.plate || '').toLowerCase() === val);
    if (found) return { found };
    // exact jenis match
    found = motors.find(m => (m.jenis || '').toLowerCase() === val);
    if (found) return { found };
    // substring jenis match (e.g., user sends 'vario')
    const candidates = motors.filter(m => {
      const jenis = (m.jenis || '').toLowerCase();
      return jenis.includes(val) || val.includes(jenis);
    });
    if (candidates.length >= 1) return { found: candidates[0] };
    // plate contains
    found = motors.find(m => (m.plate || '').toLowerCase().includes(val));
    if (found) return { found };
    return null;
  };

  // admin login (do not require prior session)
  if (text.startsWith('/admin login')) {
    const parts = text.replace('/admin login', '').split('|').map(p => p.trim()).filter(Boolean);
    const user = parts[0] || '';
    const pass = parts[1] || '';
    db_admin.get(`SELECT * FROM admin WHERE user = ? AND password = ?`, [user, pass], (err, row) => {
      if (err) {
        console.error('Admin login error', err);
        return client.sendMessage(from, 'Error saat login admin.');
      }
      if (row) {
        sessions[from] = { authenticated: true };
        client.sendMessage(from, 'Login admin berhasil.');
      } else {
        client.sendMessage(from, 'Login gagal. Nomor atau password salah.');
      }
    });
    return;
  }

  // handle pending admin confirmations (e.g. reply 'yes')
  if (sessions[from] && sessions[from].pendingAction) {
    const pending = sessions[from].pendingAction;
    if (text.toLowerCase() === 'yes') {
      if (pending === 'clear_schedules') {
        try {
          const result = await db.clearSchedules ? await db.clearSchedules() : await require('./db').clearSchedules();
          delete sessions[from].pendingAction;
          await client.sendMessage(from, `Berhasil menghapus ${result.changes} baris dari tabel jadwal.`);
          return;
        } catch (err) {
          delete sessions[from].pendingAction;
          console.error('Confirm clear schedules error', err);
          return client.sendMessage(from, 'Gagal mengosongkan jadwal: ' + (err.message || err));
        }
      }
    }
    // If reply is not 'yes', fall through to admin commands or QA.
  }
  

  // Handle in-progress conversational flows (booking form & photo upload)
  // Also detect an unsolicited filled form (multiline "Label: value") and
  // start the photo-upload flow only when the user sends a valid form.
  if (!(sessions[from] && sessions[from].flow)) {
    const linesPreview = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (linesPreview.length >= 3) {
      const data = {};
      for (const line of linesPreview) {
        const m = line.match(/^\s*([^:]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const val = m[2].trim();
        data[key] = val;
      }
      const mapKey = (k) => {
        const kk = k.toLowerCase();
        if (/motor id|jenis motor|jenis/i.test(kk)) return 'motor';
        if (/mulai tgl|mulai tanggal|mulai tgl sewa|mulai tgl/i.test(kk)) return 'tgl_antar';
        if (/mulai jam|mulai jam sewa|mulai jam/i.test(kk)) return 'jam_antar';
        if (/antar dimana|antar di|antar lokasi|antar/i.test(kk)) return 'lokasi_antar';
        if (/selesai tgl|selesai tanggal|selesai tgl sewa|tgl selesai/i.test(kk)) return 'tgl_ambil';
        if (/selesai jam|selesai jam sewa|jam selesai/i.test(kk)) return 'jam_ambil';
        if (/ambil motor di|ambil di|lokasi ambil|ambil/i.test(kk)) return 'lokasi_ambil';
        if (/motor mau dipaki|motor mau dipakai|dipakai kemana|tujuan/i.test(kk)) return 'usage_place';
        if (/instagram|ig/i.test(kk)) return 'instagram';
        if (/nama lengkap|nama ktp|nama/i.test(kk)) return 'name';
        if (/ktp kota|kota ktp|ktp kota mana/i.test(kk)) return 'ktp_city';
        if (/no wa kedua|wa kedua|wa 2|no wa 2/i.test(kk)) return 'wa_2';
        if (/no wa|wa|no hp|handphone/i.test(kk)) return 'wa_1';
        if (/domisili|alamat/i.test(kk)) return 'domicile';
        return null;
      };
      const form = {};
      for (const k of Object.keys(data)) {
        const fk = mapKey(k);
        if (fk) form[fk] = data[k];
      }
      // perform validation similar to the explicit form flow
      const required = ['motor','tgl_antar','jam_antar','tgl_ambil','jam_ambil','name','wa_1'];
      const missing = required.filter(r => !form[r]);
      if (missing.length) {
        // enter interactive missing-field collection flow instead of aborting
        if (!sessions[from]) sessions[from] = {};
        sessions[from].flow = 'waiting_missing';
        sessions[from].missing = missing.slice();
        sessions[from].partialForm = form;
        await client.sendMessage(from, `Ada field yang belum terisi: ${missing.join(', ')}. Silakan kirim nilai untuk field tersebut satu-per-baris sebagai 'Label: nilai' atau kirim semua sekaligus. Ketik 'cancel' untuk membatalkan.`);
        return;
      }
      // resolve motor by id, plate, or jenis (support 'vario' etc.)
      const motorVal = form['motor'];
      const resolved = await resolveMotor(motorVal);
      if (!resolved) return client.sendMessage(from, `Motor '${motorVal}' tidak ditemukan. Gunakan ID, jenis (mis. vario) atau plate yang muncul di daftar.`);
      const motorObj = resolved.found;
      // date/time validation
      const isValidDate = (d) => /^(?:\d{1,2}\/\d{1,2}|\d{1,2})$/.test(d);
      const isValidTime = (t) => /^\d{1,2}[:.]\d{2}$/.test(t);
      if (!isValidDate(form.tgl_antar) || !isValidDate(form.tgl_ambil)) return client.sendMessage(from, 'Format hari tidak valid (gunakan D atau DD/MM).');
      if (!isValidTime(form.jam_antar) || !isValidTime(form.jam_ambil)) return client.sendMessage(from, 'Format jam tidak valid (gunakan HH:MM).');

      // all good: start photo flow
      if (!sessions[from]) sessions[from] = {};
      sessions[from].form = {
        motorId: motorObj.id || null,
        jenis: motorObj.jenis || '',
        plate: motorObj.plate || '',
        delivery_day: form.tgl_antar,
        delivery_time: form.jam_antar,
        pickup_day: form.tgl_ambil,
        pickup_time: form.jam_ambil,
        pickup: form.lokasi_antar || form.lokasi_ambil || '',
        dropoff: form.lokasi_ambil || form.lokasi_antar || '',
        usage_place: form.usage_place || '',
        instagram: form.instagram || '',
        customer: form.name,
        ktp_city: form.ktp_city || '',
        domicile: form.domicile || '',
        WA_1: form.wa_1 || '',
        WA_2: form.wa_2 || ''
      };
      sessions[from].flow = 'waiting_photos';
      sessions[from].photos = [];
      await client.sendMessage(from, 'Data diterima dan valid. Silakan fotokan KTP dan jaminan (NPWP/KK/kartu nama). Kirim foto sekarang.');
      return;
    }
  }

  if (sessions[from] && sessions[from].flow) {
    const flow = sessions[from].flow;
    // interactive collection of missing fields
    if (flow === 'waiting_missing') {
      const textLower = (text || '').trim().toLowerCase();
      if (textLower === 'cancel') {
        delete sessions[from].flow; delete sessions[from].missing; delete sessions[from].partialForm;
        return client.sendMessage(from, 'Pengisian form dibatalkan. Jika ingin mulai ulang, kirim form lengkap lagi.');
      }
      const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const data = {};
      for (const line of lines) {
        const m = line.match(/^\s*([^:]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const val = m[2].trim();
        data[key] = val;
      }
      const mapKey = (k) => {
        const kk = k.toLowerCase();
        if (/motor id|jenis motor|jenis/i.test(kk)) return 'motor';
        if (/mulai tgl|mulai tanggal|mulai tgl sewa|mulai tgl/i.test(kk)) return 'tgl_antar';
        if (/mulai jam|mulai jam sewa|mulai jam/i.test(kk)) return 'jam_antar';
        if (/antar dimana|antar di|antar lokasi|antar/i.test(kk)) return 'lokasi_antar';
        if (/selesai tgl|selesai tanggal|selesai tgl sewa|tgl selesai/i.test(kk)) return 'tgl_ambil';
        if (/selesai jam|selesai jam sewa|jam selesai/i.test(kk)) return 'jam_ambil';
        if (/ambil motor di|ambil di|lokasi ambil|ambil/i.test(kk)) return 'lokasi_ambil';
        if (/motor mau dipaki|motor mau dipakai|dipakai kemana|tujuan/i.test(kk)) return 'usage_place';
        if (/instagram|ig/i.test(kk)) return 'instagram';
        if (/nama lengkap|nama ktp|nama/i.test(kk)) return 'name';
        if (/ktp kota|kota ktp|ktp kota mana/i.test(kk)) return 'ktp_city';
        if (/no wa kedua|wa kedua|wa 2|no wa 2/i.test(kk)) return 'wa_2';
        if (/no wa|wa|no hp|handphone/i.test(kk)) return 'wa_1';
        if (/domisili|alamat/i.test(kk)) return 'domicile';
        return null;
      };
      const partial = sessions[from].partialForm || {};
      for (const k of Object.keys(data)) {
        const fk = mapKey(k);
        if (fk) partial[fk] = data[k];
      }
      sessions[from].partialForm = partial;
      sessions[from].missing = (sessions[from].missing || []).filter(mf => !!mf && !partial[mf]);
      if (sessions[from].missing.length) {
        return client.sendMessage(from, `Masih kurang: ${sessions[from].missing.join(', ')}. Silakan lanjut kirim nilai-nilainya.`);
      }
      // finalize and continue to photo flow
      try {
        const form = sessions[from].partialForm || {};
        const motorVal = form['motor'];
        const resolved = await resolveMotor(motorVal);
        if (!resolved) return client.sendMessage(from, `Motor '${motorVal}' tidak ditemukan. Gunakan ID, jenis (mis. vario) atau plate yang muncul di daftar.`);
        const motorObj = resolved.found;
        const isValidDate = (d) => /^(?:\d{1,2}\/\d{1,2}|\d{1,2})$/.test(d);
        const isValidTime = (t) => /^\d{1,2}[:.]\d{2}$/.test(t);
        if (!isValidDate(form.tgl_antar) || !isValidDate(form.tgl_ambil)) return client.sendMessage(from, 'Format hari tidak valid (gunakan D atau DD/MM).');
        if (!isValidTime(form.jam_antar) || !isValidTime(form.jam_ambil)) return client.sendMessage(from, 'Format jam tidak valid (gunakan HH:MM).');
        sessions[from].form = {
          motorId: motorObj.id || null,
          jenis: motorObj.jenis || '',
          plate: motorObj.plate || '',
          delivery_day: form.tgl_antar,
          delivery_time: form.jam_antar,
          pickup_day: form.tgl_ambil,
          pickup_time: form.jam_ambil,
          pickup: form.lokasi_antar || form.lokasi_ambil || '',
          dropoff: form.lokasi_ambil || form.lokasi_antar || '',
          usage_place: form.usage_place || '',
          instagram: form.instagram || '',
          customer: form.name,
          ktp_city: form.ktp_city || '',
          domicile: form.domicile || '',
          WA_1: form.wa_1 || '',
          WA_2: form.wa_2 || ''
        };
        sessions[from].flow = 'waiting_photos';
        sessions[from].photos = [];
        delete sessions[from].missing; delete sessions[from].partialForm;
        await client.sendMessage(from, 'Data lengkap. Silakan fotokan KTP dan jaminan (NPWP/KK/kartu nama). Kirim foto sekarang.');
        return;
      } catch (err) {
        console.error('Finalize missing-fields error', err);
        return client.sendMessage(from, 'Gagal memproses data tambahan: ' + (err && err.message));
      }
    }
    // expecting pipe-separated form from user
    if (flow === 'waiting_form') {
      // parse multiline labeled form
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const data = {};
      for (const line of lines) {
        const m = line.match(/^\s*([^:]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const val = m[2].trim();
        data[key] = val;
      }
      const mapKey = (k) => {
        const kk = k.toLowerCase();
        if (/motor id|jenis motor|jenis/i.test(kk)) return 'motor';
        if (/mulai tgl|mulai tanggal|mulai tgl sewa|mulai tgl/i.test(kk)) return 'tgl_antar';
        if (/mulai jam|mulai jam sewa|mulai jam/i.test(kk)) return 'jam_antar';
        if (/antar dimana|antar di|antar lokasi|antar/i.test(kk)) return 'lokasi_antar';
        if (/selesai tgl|selesai tanggal|selesai tgl sewa|tgl selesai/i.test(kk)) return 'tgl_ambil';
        if (/selesai jam|selesai jam sewa|jam selesai/i.test(kk)) return 'jam_ambil';
        if (/ambil motor di|ambil di|lokasi ambil|ambil/i.test(kk)) return 'lokasi_ambil';
        if (/motor mau dipaki|motor mau dipakai|dipakai kemana|tujuan/i.test(kk)) return 'usage_place';
        if (/instagram|ig/i.test(kk)) return 'instagram';
        if (/nama lengkap|nama ktp|nama/i.test(kk)) return 'name';
        if (/ktp kota|kota ktp|ktp kota mana/i.test(kk)) return 'ktp_city';
        if (/no wa kedua|wa kedua|wa 2|no wa 2/i.test(kk)) return 'wa_2';
        if (/no wa|wa|no hp|handphone/i.test(kk)) return 'wa_1';
        if (/domisili|alamat/i.test(kk)) return 'domicile';
        return null;
      };
      const form = {};
      for (const k of Object.keys(data)) {
        const fk = mapKey(k);
        if (fk) form[fk] = data[k];
      }
      // require core fields (at least motor, dates/times, name, wa)
      const required = ['motor','tgl_antar','jam_antar','tgl_ambil','jam_ambil','name','wa_1'];
      for (const r of required) {
        if (!form[r]) return client.sendMessage(from, `Field '${r}' belum terisi atau label salah. Pastikan mengikuti template form.`);
      }
      // resolve motor input (id, plate, or jenis)
      const motorVal = form['motor'];
      const resolved = await resolveMotor(motorVal);
      if (!resolved) return client.sendMessage(from, `Motor '${motorVal}' tidak ditemukan. Gunakan ID, jenis (mis. vario) atau plate yang muncul di daftar.`);
      const motorObj = resolved.found;
      // validate dates and times
      const isValidDate = (d) => /^(?:\d{1,2}\/\d{1,2}|\d{1,2})$/.test(d);
      const isValidTime = (t) => /^\d{1,2}[:.]\d{2}$/.test(t);
      if (!isValidDate(form.tgl_antar) || !isValidDate(form.tgl_ambil)) return client.sendMessage(from, 'Format hari tidak valid (gunakan D atau DD/MM).');
      if (!isValidTime(form.jam_antar) || !isValidTime(form.jam_ambil)) return client.sendMessage(from, 'Format jam tidak valid (gunakan HH:MM).');
      if (!form.name) return client.sendMessage(from, 'Nama tidak boleh kosong.');
      if (!form.domicile) return client.sendMessage(from, 'Domisili tidak boleh kosong.');
      // store normalized form
      sessions[from].form = {
        motorId: motorObj.id || null,
        jenis: motorObj.jenis || '',
        plate: motorObj.plate || '',
        delivery_day: form.tgl_antar,
        delivery_time: form.jam_antar,
        pickup_day: form.tgl_ambil,
        pickup_time: form.jam_ambil,
        pickup: form.lokasi_antar || form.lokasi_ambil || '',
        dropoff: form.lokasi_ambil || form.lokasi_antar || '',
        usage_place: form.usage_place || '',
        instagram: form.instagram || '',
        customer: form.name,
        ktp_city: form.ktp_city || '',
        domicile: form.domicile || '',
        WA_1: form.wa_1 || '',
        WA_2: form.wa_2 || ''
      };
      sessions[from].flow = 'waiting_photos';
      sessions[from].photos = [];
      await client.sendMessage(from, 'Data diterima dan valid. Silakan fotokan KTP dan jaminan (NPWP/KK/kartu nama). Kirim foto sekarang.');
      return;
    }
    // expecting image(s)
    if (flow === 'waiting_photos') {
      const isImage = (msg && ((msg.mimetype && msg.mimetype.startsWith('image')) || msg.type === 'image' || msg.isMedia));
      if (!isImage) {
        return client.sendMessage(from, "Tolong kirim foto KTP dan jaminan (NPWP/KK/kartu nama). Jika sudah mengirim, tunggu sejenak.");
      }
      let savedPath = null;
      try {
        // prefer msg.downloadMedia() on the incoming message object
        if (msg && typeof msg.downloadMedia === 'function') {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'jpg';
            const filename = `${Date.now()}_${from.replace(/\D/g, '')}.${ext}`;
            const full = path.join(__dirname, 'data', 'uploads', filename);
            fs.writeFileSync(full, media.data, 'base64');
            savedPath = full;
          } else {
            savedPath = 'received_media_empty';
          }
        } else if (msg && (msg.mimetype || msg.isMedia)) {
          // fallback: some message objects expose mimetype/data directly
          try {
            const data = msg.data || msg._data || null;
            const ext = (msg.mimetype && msg.mimetype.split('/')[1]) || 'jpg';
            const filename = `${Date.now()}_${from.replace(/\D/g, '')}.${ext}`;
            const full = path.join(__dirname, 'data', 'uploads', filename);
            if (data) fs.writeFileSync(full, data, 'base64');
            savedPath = full;
          } catch (e) {
            savedPath = 'received_media_unknown';
          }
        } else {
          savedPath = 'received_media_unknown';
        }
      } catch (err) {
        console.error('Saving media error', err);
        savedPath = 'error_saving_media';
      }
      sessions[from].photos.push(savedPath);
      // persist form to schedules table (store WA_1/WA_2 if provided)
      try {
        const item = {
          vehicle_type: sessions[from].form.jenis || '',
          motor_id: sessions[from].form.motorId || null,
          plate: sessions[from].form.plate || '',
          delivery_day: sessions[from].form.delivery_day || '',
          delivery_time: sessions[from].form.delivery_time || '',
          pickup_day: sessions[from].form.pickup_day || '',
          pickup_time: sessions[from].form.pickup_time || '',
          pickup: sessions[from].form.pickup || '',
          dropoff: sessions[from].form.dropoff || '',
          customer: sessions[from].form.customer || '',
          total_price: sessions[from].form.total_price || '',
          entry_text: '',
          WA_1: sessions[from].form.WA_1 || '',
          WA_2: sessions[from].form.WA_2 || ''
        };
        // compute daily form number (1..150) based on today's created rows
        let todayCount = 0;
        try {
          todayCount = await new Promise((res) => db.db.get("SELECT COUNT(*) as c FROM schedules WHERE DATE(created_at) = DATE('now','localtime')", [], (err, row) => { if (err) return res(0); return res(row && row.c ? row.c : 0); }));
        } catch (e) { todayCount = 0; }
        const nextNoForm = (Number(todayCount) % 150) + 1;
        item.no_form = String(nextNoForm);
        item.client_jid = from;
        // persist no_form into session form for admin message
        sessions[from].form.no_form = item.no_form;
        await db.addSchedule(item).catch(() => null);
      } catch (err) {
        console.error('Saving schedule from user form failed', err);
      }
      await client.sendMessage(from, 'Terima kasih, foto diterima.');
      io.emit('admin_review', { from, form: sessions[from].form, photos: sessions[from].photos });
      // forward form + photos to all admin users from admin table
      try {
        const envAdminRaw = process.env.ADMIN_NUMBER || process.env.ADMIN || null;
        const phoneRaw = String(from || '').split('@')[0];
        const noid = phoneRaw.replace(/[^0-9]/g, '');
        const form = sessions[from].form || {};
        const msgLines = [];
        msgLines.push('Verifikasi booking baru:');
        msgLines.push(`No Form: ${sessions[from].form.no_form || ''}`);
        msgLines.push(`Nama: ${form.customer || ''}`);
        msgLines.push(`No WA (pengirim): ${noid}`);
        msgLines.push(`WA_1 (input): ${sessions[from].form.WA_1 || ''}`);
        msgLines.push(`WA_2 (input): ${sessions[from].form.WA_2 || ''}`);
        msgLines.push(`Jenis motor: ${form.jenis || ''}`);
        msgLines.push(`jam antar: ${form.delivery_time || ''}`);
        msgLines.push(`tgl antar: ${form.delivery_day || ''}`);
        msgLines.push(`lokasi antar: ${form.pickup || ''}`);
        msgLines.push(`jam ambil: ${form.pickup_time || ''}`);
        msgLines.push(`tgl ambil: ${form.pickup_day || ''}`);
        msgLines.push(`lok ambil: ${form.dropoff || ''}`);
        msgLines.push('Ketik /admin nota <no_form> untuk membuat nota dan mengirimkannya ke customer.');

        const sendTo = async (uRaw) => {
          if (!uRaw) return;
          let u = String(uRaw).trim();
          // normalize numeric env var to WhatsApp id
          if (!u.includes('@')) {
            const digits = u.replace(/[^0-9]/g, '');
            if (!digits) return;
            u = `${digits}@c.us`;
          }
          try {
            await client.client.sendMessage(u, msgLines.join('\n'));
            for (const p of sessions[from].photos || []) {
              try {
                if (!p || typeof p !== 'string') continue;
                const fs = require('fs');
                if (!fs.existsSync(p)) continue;
                const media = MessageMedia.fromFilePath(p);
                await client.client.sendMessage(u, media);
              } catch (e) {
                console.error('Send photo to admin error', e && e.message);
              }
            }
          } catch (e) {
            console.error('Forward to admin failed for', u, e && e.message);
          }
        };

        if (envAdminRaw) {
          await sendTo(envAdminRaw);
        } else {
          // fallback to admin table
          db_admin.all(`SELECT user FROM admin`, [], async (err, admins) => {
            if (err || !admins || !admins.length) return;
            for (const a of admins) {
              await sendTo(a && a.user);
            }
          });
        }
      } catch (e) {
        console.error('Error forwarding to admins', e && e.message);
      }
      sessions[from].flow = 'submitted';
      return;
    }
  }

  // If message is an admin command group, require session
  if (text.startsWith('/admin')) {
    if (!sessions[from]) return client.sendMessage(from, 'Anda belum login admin. Gunakan: /admin login | user | pass');

    // QA admin CRUD via chat
    if (text.startsWith('/admin add qa')) {
      const rest = text.replace('/admin add qa', '').trim();
      const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
      if (parts.length < 2) return client.sendMessage(from, 'Format: /admin add qa | pertanyaan | jawaban');
      const question = parts[0];
      const answer = parts[1];
      try {
        const row = await addQA(question, answer);
        return client.sendMessage(from, `QA ditambahkan. ID ${row.id}`);
      } catch (err) {
        console.error('Add QA error', err);
        return client.sendMessage(from, 'Gagal menambah QA: ' + err.message);
      }
    }

    if (text.startsWith('/admin update qa')) {
      const rest = text.replace('/admin update qa', '').trim();
      const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
      if (parts.length < 3) {
        try {
          const rows = await listQA();
          if (!rows.length) return client.sendMessage(from, 'Format: /admin update qa | id | pertanyaan baru | jawaban baru\n\nBelum ada QA.');
          const reply = rows.map(r => `${r.id}. ${r.question} (${r.answer})`).join('\n');
          return client.sendMessage(from, 'Format: /admin update qa | id | pertanyaan | jawaban baru\n\nDaftar QA:\n' + reply);
        } catch (err) {
          console.error('List QA error', err);
          return client.sendMessage(from, 'Gagal membaca QA: ' + err.message);
        }
      }
      const id = parts[0];
      const question = parts[1];
      const answer = parts[2];
      try {
        const result = await db.updateQA(id, question, answer);
        if (result.changes === 0) return client.sendMessage(from, 'QA tidak ditemukan.');
        const rows = await listQA();
        const reply = rows.map(r => `${r.id}. ${r.question} (${r.answer})`).join('\n');
        return client.sendMessage(from, `QA ID ${id} berhasil diupdate.\n\nDaftar QA:\n${reply}`);
      } catch (err) {
        console.error('Update QA error', err);
        return client.sendMessage(from, 'Gagal update QA: ' + err.message);
      }
    }

    if (text.startsWith('/admin delete qa')) {
      const rest = text.replace('/admin delete qa', '').trim();
      const id = rest.split('|').map(p => p.trim()).filter(Boolean)[0] || rest;
      if (!id) {
        try {
          const rows = await listQA();
          if (!rows.length) return client.sendMessage(from, 'Belum ada QA.');
          const reply = rows.map(r => `${r.id}. ${r.question} (${r.answer})`).join('\n');
          return client.sendMessage(from, 'Format: /admin delete qa | id\n\nDaftar QA:\n' + reply);
        } catch (err) {
          console.error('List QA error', err);
          return client.sendMessage(from, 'Gagal membaca QA: ' + err.message);
        }
      }
      try {
        const result = await db.deleteQA(id);
        if (result.changes === 0) return client.sendMessage(from, 'QA tidak ditemukan.');
        const rows = await listQA();
        const reply = rows.map(r => `${r.id}. ${r.question} (${r.answer})`).join('\n');
        return client.sendMessage(from, `QA ID ${id} berhasil dihapus.\n\nDaftar QA:\n${reply}`);
      } catch (err) {
        console.error('Delete QA error', err);
        return client.sendMessage(from, 'Gagal hapus QA: ' + err.message);
      }
    }

    if (text.startsWith('/admin read qa')) {
      const rest = text.replace('/admin read qa', '').trim();
      const id = rest.split('|').map(p => p.trim()).filter(Boolean)[0] || (rest || '');
      try {
        if (id) {
          const row = await db.getQA(id);
          if (!row) return client.sendMessage(from, 'QA tidak ditemukan.');
          return client.sendMessage(from, `ID ${row.id}\nQ: ${row.question}\nA: ${row.answer}\nDibuat: ${row.created_at}`);
        } else {
          const rows = await listQA();
          if (!rows.length) return client.sendMessage(from, 'Belum ada QA.');
          const reply = rows.map(r => `${r.id}. ${r.question} (${r.answer})`).join('\n');
          return client.sendMessage(from, `Daftar QA:\n${reply}`);
        }
      } catch (err) {
        console.error('Read QA error', err);
        return client.sendMessage(from, 'Gagal membaca QA: ' + err.message);
      }
    }

    // Admin user management (create/list/update/delete admin)
    if (/^\/admin add\s*\|/.test(text)) {
      const parts = text.split('|');
      const user = (parts[0].replace('/admin add', '') || '').trim();
      const password = (parts[1] || '').trim();
      if (!user || !password) return client.sendMessage(from, 'Format: /admin add | user | password');
      db_admin.run(`INSERT INTO admin (user, password) VALUES (?, ?)`, [user, password], err => {
        if (err) return client.sendMessage(from, 'Gagal menambah admin: ' + err.message);
        client.sendMessage(from, `Admin ${user} berhasil ditambahkan.`);
      });
      return;
    }

    if (text.trim() === '/admin list') {
      db_admin.all(`SELECT id, user, password , created_at FROM admin`, [], (err, rows) => {
        if (err) return client.sendMessage(from, 'Error membaca admin.');
        if (rows.length === 0) return client.sendMessage(from, 'Belum ada admin.');
        const reply = rows.map(r => `${r.id}. ${r.user} (dibuat ${r.created_at})`).join('\n');
        client.sendMessage(from, `Daftar admin:\n${reply}`);
      });
      return;
    }

    if (text.startsWith('/admin update ') && !text.startsWith('/admin update motor')) {
      const parts = text.split('|').map(p => p.trim());
      const idPart = (parts[0] || '').replace('/admin update ', '').trim();
      const newPass = parts[1] || '';
      if (!idPart || !newPass) return client.sendMessage(from, 'Format: /admin update | id | newpassword');
      db_admin.run(`UPDATE admin SET password = ? WHERE id = ?`, [newPass, idPart], function(err) {
        if (err) return client.sendMessage(from, 'Gagal update: ' + err.message);
        if (this.changes === 0) return client.sendMessage(from, 'Admin tidak ditemukan.');
        client.sendMessage(from, `Password admin ID ${idPart} berhasil diubah.`);
      });
      return;
    }

    // Delete schedules for yesterday: '/admin delete jadwal kemarin'
    if (text.startsWith('/admin delete jadwal kemarin')) {
      try {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const dd = String(yesterday.getDate()).padStart(2, '0');
        const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
        const dayStr = `${dd}/${mm}`;
        const result = await db.deleteSchedulesByPickupDay ? await db.deleteSchedulesByPickupDay(dayStr) : await require('./db').deleteSchedulesByPickupDay(dayStr);
        if (result.changes === 0) return client.sendMessage(from, `Tidak ada jadwal dengan hari jemput ${dayStr}.`);
        return client.sendMessage(from, `Berhasil menghapus ${result.changes} jadwal dengan hari jemput ${dayStr}.`);
      } catch (err) {
        console.error('Delete jadwal kemarin error', err);
        return client.sendMessage(from, 'Gagal menghapus jadwal kemarin: ' + (err.message || err));
      }
    }

    // Delete schedules yesterday and earlier: '/admin delete jadwal -1'
    if (text.startsWith('/admin delete jadwal -1')) {
      try {
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const cutoff = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999);

        const ddmmToDate = (ddmm, bulanHint) => {
          if (!ddmm) return null;
          const s = String(ddmm).trim();
          let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
          m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
          if (m) { const day = parseInt(m[1],10); const month = parseInt(m[2],10); const year = m[3] ? (m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10)) : (new Date()).getFullYear(); return new Date(year, month-1, day); }
          m = s.match(/^(\d{1,2})$/);
          if (m) { const day = parseInt(m[1],10); let month = (new Date()).getMonth()+1; let year = (new Date()).getFullYear(); if (bulanHint) { const bhm = String(bulanHint).match(/^(\d{1,2})(?:\/(\d{2,4}))?$/); if (bhm) { month = parseInt(bhm[1],10); if (bhm[2]) year = bhm[2].length===2?2000+parseInt(bhm[2],10):parseInt(bhm[2],10); } } return new Date(year, month-1, day); }
          return null;
        };

        const rows = await db.listAllSchedules ? await db.listAllSchedules() : await db.listSchedules();
        const toDelete = [];
        for (const r of rows) {
          const pdRaw = r.pickup_day || r.start_date || null;
          if (!pdRaw) continue;
          const pd = ddmmToDate(pdRaw, r.bulan);
          if (!pd) continue;
          // compare date (end of day)
          const pdEnd = new Date(pd.getFullYear(), pd.getMonth(), pd.getDate(), 23,59,59,999);
          if (pdEnd.getTime() <= cutoff.getTime()) {
            toDelete.push(r.id);
          }
        }
        if (!toDelete.length) return client.sendMessage(from, 'Tidak ada jadwal dengan pickup_day <= kemarin.');
        let totalDeleted = 0;
        for (const id of toDelete) {
          try {
            const resDel = await db.deleteSchedule(id);
            if (resDel && resDel.changes) totalDeleted += resDel.changes;
          } catch (e) { /* ignore single errors */ }
        }
        return client.sendMessage(from, `Berhasil menghapus ${totalDeleted} jadwal dengan pickup_day <= kemarin.`);
      } catch (err) {
        console.error('Delete jadwal -1 error', err);
        return client.sendMessage(from, 'Gagal menghapus jadwal -1: ' + (err && err.message));
      }
    }

    // Admin: list schedules by delivery day '/admin jadwal antar <day> | <motorId|plate>'
    if (text.startsWith('/admin jadwal antar')) {
      try {
        const rest = text.replace('/admin jadwal antar', '').trim();
        if (!rest) return client.sendMessage(from, "Format: /admin jadwal antar <day> atau '/admin jadwal antar <day> | <motorId|plate>'");
        const parts = rest.split('|').map(p=>p.trim()).filter(Boolean);
        const dayInput = parts[0];
        const motorFilter = parts[1] || null;
        const dayMatch = (s) => {
          if (!s) return false;
          const m1 = s.match(/^(\d{1,2})\/(\d{1,2})$/);
          if (m1) return (parseInt(m1[1],10) === parseInt(dayInput,10)) || (dayInput.includes('/') && dayInput === s);
          const m2 = s.match(/^(\d{1,2})$/);
          if (m2) return parseInt(m2[1],10) === parseInt(dayInput,10);
          return false;
        };
        const rows = await db.listAllSchedules ? await db.listAllSchedules() : await db.listSchedules();
        const filtered = rows.filter(r => dayMatch(r.delivery_day));
        const byMotor = {};
        for (const r of filtered) {
          const key = r.motor_id != null ? String(r.motor_id) : (r.motor_plate || r.plate || 'unknown');
          if (motorFilter) {
            if (!(String(r.motor_id) === motorFilter || (r.motor_plate||'').toLowerCase() === motorFilter.toLowerCase() || (r.plate||'').toLowerCase() === motorFilter.toLowerCase())) continue;
          }
          if (!byMotor[key]) byMotor[key] = { motor_id: r.motor_id, plate: r.motor_plate || r.plate || '', rows: [] };
          byMotor[key].rows.push(r);
        }
        if (Object.keys(byMotor).length === 0) return client.sendMessage(from, `Tidak ada jadwal antar untuk hari ${dayInput}.`);
        const out = [];
        for (const k of Object.keys(byMotor).sort((a,b)=> (byMotor[a].motor_id||0) - (byMotor[b].motor_id||0))) {
          const g = byMotor[k];
          out.push(`${g.motor_id != null ? g.motor_id : g.plate} ${g.plate}`.trim());
          g.rows.sort((a,b)=> a.id - b.id);
          for (let i=0;i<g.rows.length;i++) {
            const s = g.rows[i];
            out.push(`- ${s.id}. ${s.customer || ''} | ANTAR: ${s.delivery_day||''} ${s.delivery_time||''} | ${s.dropoff || s.location || ''}`);
          }
        }
        return client.sendMessage(from, `Jadwal antar untuk ${dayInput}:\n${out.join('\n')}`);
      } catch (err) {
        console.error('jadwal antar error', err);
        return client.sendMessage(from, 'Gagal membaca jadwal antar: ' + (err.message || err));
      }
    }

    // Admin: list schedules by pickup day '/admin jadwal ambil <day> | <motorId|plate>'
    if (text.startsWith('/admin jadwal ambil')) {
      try {
        const rest = text.replace('/admin jadwal ambil', '').trim();
        if (!rest) return client.sendMessage(from, "Format: /admin jadwal ambil <day> atau '/admin jadwal ambil <day> | <motorId|plate>'");
        const parts = rest.split('|').map(p=>p.trim()).filter(Boolean);
        const dayInput = parts[0];
        const motorFilter = parts[1] || null;
        const dayMatch = (s) => {
          if (!s) return false;
          const m1 = s.match(/^(\d{1,2})\/(\d{1,2})$/);
          if (m1) return (parseInt(m1[1],10) === parseInt(dayInput,10)) || (dayInput.includes('/') && dayInput === s);
          const m2 = s.match(/^(\d{1,2})$/);
          if (m2) return parseInt(m2[1],10) === parseInt(dayInput,10);
          return false;
        };
        const rows = await db.listAllSchedules ? await db.listAllSchedules() : await db.listSchedules();
        const filtered = rows.filter(r => dayMatch(r.pickup_day));
        const byMotor = {};
        for (const r of filtered) {
          const key = r.motor_id != null ? String(r.motor_id) : (r.motor_plate || r.plate || 'unknown');
          if (motorFilter) {
            if (!(String(r.motor_id) === motorFilter || (r.motor_plate||'').toLowerCase() === motorFilter.toLowerCase() || (r.plate||'').toLowerCase() === motorFilter.toLowerCase())) continue;
          }
          if (!byMotor[key]) byMotor[key] = { motor_id: r.motor_id, plate: r.motor_plate || r.plate || '', rows: [] };
          byMotor[key].rows.push(r);
        }
        if (Object.keys(byMotor).length === 0) return client.sendMessage(from, `Tidak ada jadwal ambil untuk hari ${dayInput}.`);
        const out = [];
        for (const k of Object.keys(byMotor).sort((a,b)=> (byMotor[a].motor_id||0) - (byMotor[b].motor_id||0))) {
          const g = byMotor[k];
          out.push(`${g.motor_id != null ? g.motor_id : g.plate} ${g.plate}`.trim());
          g.rows.sort((a,b)=> a.id - b.id);
          for (let i=0;i<g.rows.length;i++) {
            const s = g.rows[i];
            out.push(`- ${s.id}. ${s.customer || ''} | AMBIL: ${s.pickup_day||''} ${s.pickup_time||''} | ${s.pickup || ''}`);
          }
        }
        return client.sendMessage(from, `Jadwal ambil untuk ${dayInput}:\n${out.join('\n')}`);
      } catch (err) {
        console.error('jadwal ambil error', err);
        return client.sendMessage(from, 'Gagal membaca jadwal ambil: ' + (err.message || err));
      }
    }

    // Clear all schedules: '/admin clear schedules' or '/admin clear jadwal'
    if (text.startsWith('/admin clear schedules') || text.startsWith('/admin clear jadwal')) {
      try {
        const rest = text.replace('/admin clear schedules', '').replace('/admin clear jadwal', '').replace(/^\|/, '').trim();
        // If caller provided immediate confirmation in same message, perform it.
        if (/^yes$/i.test(rest)) {
          const result = await db.clearSchedules ? await db.clearSchedules() : await require('./db').clearSchedules();
          return client.sendMessage(from, `Berhasil menghapus ${result.changes} baris dari tabel jadwal.`);
        }
        // Otherwise set a pending action and ask admin to reply 'yes'
        if (!sessions[from]) sessions[from] = { authenticated: true };
        sessions[from].pendingAction = 'clear_schedules';
        return client.sendMessage(from, "Konfirmasi pengosongan jadwal: balas 'yes' untuk melanjutkan, atau 'no' untuk membatalkan.");
      } catch (err) {
        console.error('Clear schedules error', err);
        return client.sendMessage(from, 'Gagal mengosongkan jadwal: ' + (err.message || err));
      }
    }

    if (text.startsWith('/admin delete')) {
      // Only treat as admin-delete when the remainder is a numeric id or pipe+id.
      // This avoids swallowing more specific commands like '/admin delete schedule' or '/admin delete jadwal kemarin'.
      const rest = text.replace('/admin delete', '').trim();
      const id = rest.replace(/^\|/, '').trim();
      if (/^\d+$/.test(id)) {
        db_admin.run(`DELETE FROM admin WHERE id = ?`, [id], function(err) {
          if (err) return client.sendMessage(from, 'Gagal hapus: ' + err.message);
          if (this.changes === 0) return client.sendMessage(from, 'Admin tidak ditemukan.');
          client.sendMessage(from, `Admin ID ${id} berhasil dihapus.`);
        });
        return;
      }
      // Not an admin-id delete, continue so other more specific '/admin delete ...' handlers can match.
    }

    if (text.startsWith('/admin add schedule')) {
      // Accept only compact slash-separated format (no '|' legacy):
      // motorId / antarDay-ambilDay / antarTime-ambilTime / antarLoc-ambilLoc / customer / price
      // example: 1/1-1/07.00-07.00/balapan-balapan/aziz/100
      const rest = text.replace('/admin add schedule', '').trim();
      const parts = rest.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length < 6) return client.sendMessage(from, 'Format: motorId/antarDay-ambilDay/antarTime-ambilTime/antarLoc-ambilLoc/customer/price');
      const motorIdRaw = parts[0];
      const motorId = parseInt(motorIdRaw, 10);
      if (!motorId) return client.sendMessage(from, 'Motor ID tidak valid (gunakan id dari tabel motor).');

      const dayPair = parts[1].split('-').map(s => s.trim());
      const timePair = parts[2].split('-').map(s => s.trim());
      const locPair = parts[3].split('-').map(s => s.trim());
      const customer = parts[4] || '';
      const price = parts[5] || '';

      // flexible day parser: accepts 'D' or 'DD/MM'
      const ddmmFlexible = (ddmm) => {
        if (!ddmm) return null;
        const a = ddmm.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (a) {
          const day = parseInt(a[1], 10);
          const month = parseInt(a[2], 10);
          if (month < 1 || month > 12) return null;
          const now = new Date();
          const year = now.getFullYear();
          const daysInMonth = new Date(year, month, 0).getDate();
          if (day < 1 || day > daysInMonth) return null;
          return new Date(year, month - 1, day);
        }
        const b = ddmm.match(/^(\d{1,2})$/);
        if (b) {
          const day = parseInt(b[1], 10);
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth() + 1;
          const daysInMonth = new Date(year, month, 0).getDate();
          if (day < 1 || day > daysInMonth) return null;
          return new Date(year, month - 1, day);
        }
        return null;
      };
      const timeToMinutes = (t) => {
        if (!t) return null;
        const m = t.match(/(\d{1,2})[:\.](\d{2})/);
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      };

      const antar_day = dayPair[0] || '';
      const ambil_day = dayPair[1] || dayPair[0] || '';
      const antar_time = timePair[0] || '';
      const ambil_time = timePair[1] || timePair[0] || '';
      const dropoff_loc = locPair[0] || '';
      const pickup_loc = locPair[1] || locPair[0] || '';

      const dDay = ddmmFlexible(antar_day);
      const dMin = timeToMinutes(antar_time);
      const pDay = ddmmFlexible(ambil_day);
      const pMin = timeToMinutes(ambil_time);
      if (!dDay || dMin == null) return client.sendMessage(from, 'Format antar (hari/jam) tidak valid. Gunakan D atau DD/MM dan HH:MM.');
      if (!pDay || pMin == null) return client.sendMessage(from, 'Format ambil (hari/jam) tidak valid. Gunakan D atau DD/MM dan HH:MM.');
      if (dMin < 6 * 60) return client.sendMessage(from, 'Jam antar minimal 06:00.');
      if (pMin > 23 * 60) return client.sendMessage(from, 'Jam ambil maksimal 23:00.');

      const ddt = new Date(dDay.getTime()); ddt.setHours(0, 0, 0, 0); ddt.setMinutes(dMin);
      const pdt = new Date(pDay.getTime()); pdt.setHours(0, 0, 0, 0); pdt.setMinutes(pMin);
      const newDeliveryAbs = Math.floor(ddt.getTime() / 60000);

      try {
        const motor = await db.getMotorById(motorId).catch(() => null);
        if (!motor) return client.sendMessage(from, `Motor ID ${motorId} tidak ditemukan.`);

        const latest = await db.getLatestScheduleByMotorId(motorId).catch(() => null);
        if (latest) {
          const lastPickupDay = latest.pickup_day || latest.start_date || null;
          const lastPickupTime = latest.pickup_time || latest.start_time || null;
          if (lastPickupDay && lastPickupTime) {
            const lpd = ddmmFlexible(lastPickupDay);
            const lpm = timeToMinutes(lastPickupTime);
            if (lpd && lpm != null) {
              const ldt = new Date(lpd.getTime()); ldt.setHours(0, 0, 0, 0); ldt.setMinutes(lpm);
              const lastPickupAbs = Math.floor(ldt.getTime() / 60000);
              const MIN_GAP = 30;
              if (newDeliveryAbs < lastPickupAbs + MIN_GAP) {
                return client.sendMessage(from, `Delivery (antar) must be at least ${MIN_GAP} minutes after last pickup for motor ID ${motorId}`);
              }
              const lastDayOnly = new Date(lpd.getFullYear(), lpd.getMonth(), lpd.getDate());
              const newDayOnly = new Date(ddt.getFullYear(), ddt.getMonth(), ddt.getDate());
              if (newDayOnly.getTime() < lastDayOnly.getTime()) return client.sendMessage(from, 'Delivery day must be same or after last pickup day for this motor.');
            }
          }
        }

        const item = {
          name: '',
          vehicle_type: motor.jenis || '',
          motor_id: motorId,
          plate: motor.plate || '',
          delivery_day: antar_day, delivery_time: antar_time,
          pickup_day: ambil_day, pickup_time: ambil_time,
          pickup: pickup_loc, dropoff: dropoff_loc,
          total_price: price, entry_text: '', customer
        };
        const row = await db.addSchedule(item);
        return client.sendMessage(from, `Jadwal tersimpan. ID ${row.id}`);
      } catch (err) {
        console.error('Add schedule via admin chat error', err);
        return client.sendMessage(from, 'Gagal menyimpan jadwal: ' + (err.message || 'server error'));
      }
    }

    // Admin: add booking with explicit bulan (month) stored but hidden until day arrives
    if (text.startsWith('/admin add boking')) {
      // Format (slash-separated): motorId/antarDay-ambilDay/antarTime-ambilTime/antarLoc-ambilLoc/customer/price/bulan
      const rest = text.replace('/admin add boking', '').trim();
      const parts = rest.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length < 7) return client.sendMessage(from, 'Format: motorId/antarDay-ambilDay/antarTime-ambilTime/antarLoc-ambilLoc/customer/price/bulan (bulan contoh: 02 or 02/2026)');
      const motorIdRaw = parts[0];
      const motorId = parseInt(motorIdRaw, 10);
      if (!motorId) return client.sendMessage(from, 'Motor ID tidak valid (gunakan id dari tabel motor).');

      const dayPair = parts[1].split('-').map(s => s.trim());
      const timePair = parts[2].split('-').map(s => s.trim());
      const locPair = parts[3].split('-').map(s => s.trim());
      const customer = parts[4] || '';
      const price = parts[5] || '';
      const bulanRaw = parts[6] || '';

      // reuse parsers from schedule handler
      const ddmmFlexible = (ddmm) => {
        if (!ddmm) return null;
        const a = ddmm.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (a) {
          const day = parseInt(a[1], 10);
          const month = parseInt(a[2], 10);
          if (month < 1 || month > 12) return null;
          const now = new Date();
          const year = now.getFullYear();
          const daysInMonth = new Date(year, month, 0).getDate();
          if (day < 1 || day > daysInMonth) return null;
          return new Date(year, month - 1, day);
        }
        const b = ddmm.match(/^(\d{1,2})$/);
        if (b) {
          const day = parseInt(b[1], 10);
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth() + 1;
          const daysInMonth = new Date(year, month, 0).getDate();
          if (day < 1 || day > daysInMonth) return null;
          return new Date(year, month - 1, day);
        }
        return null;
      };
      const timeToMinutes = (t) => {
        if (!t) return null;
        const m = t.match(/(\d{1,2})[:\.](\d{2})/);
        if (!m) return null;
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      };

      const antar_day = dayPair[0] || '';
      const ambil_day = dayPair[1] || dayPair[0] || '';
      const antar_time = timePair[0] || '';
      const ambil_time = timePair[1] || timePair[0] || '';
      const dropoff_loc = locPair[0] || '';
      const pickup_loc = locPair[1] || locPair[0] || '';

      const dDay = ddmmFlexible(antar_day);
      const dMin = timeToMinutes(antar_time);
      const pDay = ddmmFlexible(ambil_day);
      const pMin = timeToMinutes(ambil_time);
      if (!dDay || dMin == null) return client.sendMessage(from, 'Format antar (hari/jam) tidak valid. Gunakan D atau DD/MM dan HH:MM.');
      if (!pDay || pMin == null) return client.sendMessage(from, 'Format ambil (hari/jam) tidak valid. Gunakan D atau DD/MM dan HH:MM.');

      try {
        const motor = await db.getMotorById(motorId).catch(() => null);
        if (!motor) return client.sendMessage(from, `Motor ID ${motorId} tidak ditemukan.`);

        const item = {
          name: '',
          vehicle_type: motor.jenis || '',
          motor_id: motorId,
          plate: motor.plate || '',
          delivery_day: antar_day, delivery_time: antar_time,
          pickup_day: ambil_day, pickup_time: ambil_time,
          pickup: pickup_loc, dropoff: dropoff_loc,
          total_price: price, entry_text: '', customer, bulan: bulanRaw
        };
        const row = await db.addSchedule(item);
        return client.sendMessage(from, `Booking tersimpan (bulan ${bulanRaw}). ID ${row.id}`);
      } catch (err) {
        console.error('Add booking via admin chat error', err);
        return client.sendMessage(from, 'Gagal menyimpan booking: ' + (err.message || 'server error'));
      }
    }

    // motor management via chat
    if (text.startsWith('/admin add motor')) {
      const rest = text.replace('/admin add motor', '').split('|').map(s => s.trim()).filter(Boolean);
      const jenis = rest[0] || '';
      const plate = rest[1] || '';
      if (!plate) return client.sendMessage(from, 'Format: /admin add motor | jenis | plate');
      try {
        const row = await db.addMotor(jenis, plate);
        return client.sendMessage(from, `Motor ditambahkan. ID ${row.id} | ${row.jenis} | ${row.plate}`);
      } catch (err) {
        console.error('Add motor error', err);
        return client.sendMessage(from, 'Gagal menambah motor: ' + err.message);
      }
    }

    if (text.startsWith('/admin update motor')) {
      const rest = text.replace('/admin update motor', '').split('|').map(s => s.trim()).filter(Boolean);
      const id = rest[0] || '';
      const jenis = rest[1] || '';
      const plate = rest[2] || '';
      const harga_24 = rest[3] || '';
      const harga_12 = rest[4] || '';
      if (!id) return client.sendMessage(from, 'Format: /admin update motor | id | jenis | plate | harga_24 | harga_12');
      try {
        const result = await db.updateMotor ? await db.updateMotor(id, jenis, plate, harga_24, harga_12) : await require('./db').updateMotor(id, jenis, plate, harga_24, harga_12);
        if (result.changes === 0) return client.sendMessage(from, 'Motor tidak ditemukan atau tidak ada perubahan.');
        const row = await db.getMotorById(id).catch(() => null);
        return client.sendMessage(from, `Motor ID ${id} berhasil diupdate.\n${row ? `Jenis: ${row.jenis} | Plate: ${row.plate} | 24h: ${row.harga_24||''} | 12h: ${row.harga_12||''}` : ''}`);
      } catch (err) {
        console.error('Update motor error', err);
        return client.sendMessage(from, 'Gagal update motor: ' + (err.message || err));
      }
    }

    // Admin: edit motor id (change primary key). Format: /admin edit motor | oldId | newId
    if (text.startsWith('/admin edit motor')) {
      const rest = text.replace('/admin edit motor', '').split('|').map(s => s.trim()).filter(Boolean);
      const oldId = rest[0] || '';
      const newId = rest[1] || '';
      if (!oldId || !newId) return client.sendMessage(from, 'Format: /admin edit motor | oldId | newId');
      try {
        const result = await db.changeMotorId ? await db.changeMotorId(oldId, newId) : await require('./db').changeMotorId(oldId, newId);
        return client.sendMessage(from, `Motor ID ${oldId} berhasil diubah menjadi ${newId}.`);
      } catch (err) {
        console.error('Edit motor id error', err);
        return client.sendMessage(from, 'Gagal edit motor id: ' + (err && err.message || err));
      }
    }

    if (text.startsWith('/admin list motors')) {
      try {
        const rows = await db.listMotors();
        if (!rows.length) return client.sendMessage(from, 'Belum ada motor.');
        const reply = rows.map(r => `${r.id}. ${r.jenis} | ${r.plate} | 24h: ${r.harga_24 || '-'} | 12h: ${r.harga_12 || '-'}`).join('\n');
        return client.sendMessage(from, `Daftar motor:\n${reply}`);
      } catch (err) {
        console.error('List motors error', err);
        return client.sendMessage(from, 'Gagal membaca motors: ' + err.message);
      }
    }

    if (text.startsWith('/admin read motor')) {
      const id = text.replace('/admin read motor', '').split('|').map(s=>s.trim()).filter(Boolean)[0] || '';
      if (!id) return client.sendMessage(from, 'Format: /admin read motor | id');
      try {
        const row = await db.getMotorById(id);
        if (!row) return client.sendMessage(from, 'Motor tidak ditemukan.');
        return client.sendMessage(from, `ID ${row.id}\nJenis: ${row.jenis}\nPlate: ${row.plate}\nDibuat: ${row.created_at}`);
      } catch (err) {
        console.error('Read motor error', err);
        return client.sendMessage(from, 'Gagal membaca motor: ' + err.message);
      }
    }

    if (text.startsWith('/admin delete motor')) {
      const id = text.replace('/admin delete motor', '').split('|').map(s=>s.trim()).filter(Boolean)[0] || '';
      if (!id) return client.sendMessage(from, 'Format: /admin delete motor | id');
      try {
        const result = await db.deleteMotor(id);
        if (result.changes === 0) return client.sendMessage(from, 'Motor tidak ditemukan.');
        return client.sendMessage(from, `Motor ID ${id} berhasil dihapus.`);
      } catch (err) {
        console.error('Delete motor error', err);
        return client.sendMessage(from, 'Gagal hapus motor: ' + err.message);
      }
    }

    // clear DB (schedules, motors, products, qa) - destructive
    if (text.startsWith('/admin clear db')) {
      try {
        await db.clearData();
        return client.sendMessage(from, 'Database motors, products, dan QA telah dikosongkan. Jadwal (schedules) TIDAK dikosongkan. Gunakan /admin delete schedule | id untuk menghapus jadwal tertentu.');
      } catch (err) {
        console.error('Clear DB error', err);
        return client.sendMessage(from, 'Gagal mengosongkan DB: ' + err.message);
      }
    }

    // schedule management via chat
    if (text.startsWith('/admin list schedules')) {
      try {
        const rows = await db.listAllSchedules ? await db.listAllSchedules() : await db.listSchedules();
        if (!rows.length) return client.sendMessage(from, 'Belum ada jadwal.');

        // Group by motor_id (use motor_plate if present), motors ordered by motor_id ascending
        const groups = {};
        const order = [];
        for (const r of rows) {
          const key = r.motor_id != null ? String(r.motor_id) : (r.motor_plate || r.plate || 'unknown');
          if (!groups[key]) {
            groups[key] = { motor_id: r.motor_id, plate: r.motor_plate || r.plate || '', rows: [] };
            order.push(key);
          }
          groups[key].rows.push(r);
        }

        // For each group, sort by schedule id ascending (should already be), then enumerate
        const parts = [];
        for (const key of order) {
          const g = groups[key];
          // header: motorId plate
          const headerId = g.motor_id != null ? g.motor_id : g.plate || key;
          parts.push(`${headerId} ${g.plate}`.trim());
          // enumerate schedules and display composite id motorId.index
          g.rows.sort((a,b) => a.id - b.id);
          for (let i = 0; i < g.rows.length; i++) {
            const s = g.rows[i];
            const seq = i + 1;
            const compositeId = (g.motor_id != null) ? `${g.motor_id}.${seq}` : `${g.plate || key}.${seq}`;
            const deliveryWhen = `${s.delivery_day||''} ${s.delivery_time||''}`.trim();
            const pickupWhen = `${s.pickup_day||''} ${s.pickup_time||''}`.trim();
            const deliveryLoc = s.dropoff || s.location || '';
            const pickupLoc = s.pickup || '';
            const customer = s.customer || '';
            const price = s.total_price || s.price || '';
            parts.push(`- ${compositeId} | ANTAR: ${deliveryWhen} (${deliveryLoc}) -> AMBIL: ${pickupWhen} (${pickupLoc}) | ${customer} | ${price}`);
          }
        }

        return client.sendMessage(from, `Daftar jadwal (grouped):\n${parts.join('\n')}`);
      } catch (err) {
        console.error('List schedules error', err);
        return client.sendMessage(from, 'Gagal membaca jadwal: ' + err.message);
      }
    }

    if (text.startsWith('/admin delete schedule')) {
      const id = text.replace('/admin delete schedule', '').split('|').map(s=>s.trim()).filter(Boolean)[0] || text.replace('/admin delete schedule','').trim();
      if (!id) return client.sendMessage(from, 'Format: /admin delete schedule | id');
      try {
        const result = await db.deleteSchedule(id);
        if (result.changes === 0) return client.sendMessage(from, 'Jadwal tidak ditemukan.');
        return client.sendMessage(from, `Jadwal ID ${id} berhasil dihapus.`);
      } catch (err) {
        console.error('Delete schedule error', err);
        return client.sendMessage(from, 'Gagal hapus jadwal: ' + err.message);
      }
    }

    // Admin: generate invoice/nota for a schedule: /admin nota <scheduleId>
    if (text.startsWith('/admin nota')) {
      const rest = text.replace('/admin nota', '').trim();
      const id = rest.split('|').map(s=>s.trim()).filter(Boolean)[0] || rest;
      if (!id) return client.sendMessage(from, 'Format: /admin nota | <scheduleId>');
      try {
        const rows = await db.listAllSchedules();
        const schedule = (rows || []).find(r => String(r.id) === String(id) || String(r.no_form) === String(id));
        if (!schedule) return client.sendMessage(from, `Jadwal ID ${id} tidak ditemukan.`);

        const ddmmToDate = (ddmm, bulanHint) => {
          if (!ddmm) return null;
          const s = String(ddmm).trim();
          let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
          m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
          if (m) { const day = parseInt(m[1],10); const month = parseInt(m[2],10); const year = m[3] ? (m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10)) : (new Date()).getFullYear(); return new Date(year, month-1, day); }
          m = s.match(/^(\d{1,2})$/);
          if (m) { const day = parseInt(m[1],10); const now = new Date(); let month = now.getMonth()+1; let year = now.getFullYear(); if (bulanHint) { const bhm = String(bulanHint).match(/^(\d{1,2})(?:\/(\d{2,4}))?$/); if (bhm) { month = parseInt(bhm[1],10); if (bhm[2]) year = bhm[2].length===2?2000+parseInt(bhm[2],10):parseInt(bhm[2],10); } } return new Date(year, month-1, day); }
          return null;
        };
        const timeToMinutes = (t) => { if (!t) return null; const mm = String(t).match(/(\d{1,2})[:\. ]?(\d{2})?/); if (!mm) return null; const hh = parseInt(mm[1],10); const mn = mm[2]?parseInt(mm[2],10):0; return hh*60+mn; };

        const startDate = (schedule.delivery_day && schedule.delivery_time) ? (() => { const d = ddmmToDate(schedule.delivery_day, schedule.bulan); const m = timeToMinutes(schedule.delivery_time); if (!d || m==null) return null; const dt = new Date(d.getTime()); dt.setHours(0,0,0,0); dt.setMinutes(m); return dt; })() : null;
        const endDate = (schedule.pickup_day && schedule.pickup_time) ? (() => { const d = ddmmToDate(schedule.pickup_day, schedule.bulan); const m = timeToMinutes(schedule.pickup_time); if (!d || m==null) return null; const dt = new Date(d.getTime()); dt.setHours(0,0,0,0); dt.setMinutes(m); return dt; })() : null;
        if (!startDate || !endDate) return client.sendMessage(from, 'Tidak dapat menentukan tanggal/jam antar atau ambil pada jadwal ini.');
        const diffMs = endDate.getTime() - startDate.getTime();
        if (diffMs <= 0) return client.sendMessage(from, 'Waktu ambil harus setelah waktu antar.');
        const totalHours = Math.ceil(diffMs / (1000*3600));

        // compute blocks: full 24h blocks, remaining (if >0) count as one 12h block
        const full24 = Math.floor(totalHours / 24);
        const rem = totalHours - full24*24;
        const use12 = rem > 0 ? 1 : 0;

        // get motor pricing
        const motor = await db.getMotorById(schedule.motor_id || schedule.motorId || schedule.motor_id).catch(()=>null);
        const raw24 = motor && motor.harga_24 ? String(motor.harga_24) : '';
        const raw12 = motor && motor.harga_12 ? String(motor.harga_12) : '';
        const parsePrice = (s) => { if (!s) return 0; const n = String(s).replace(/[^0-9]/g,''); return n ? parseInt(n,10) : 0; };
        const harga24 = parsePrice(raw24);
        const harga12 = parsePrice(raw12);
        const ongkir = parseInt(process.env.DEFAULT_ONGKIR || '20000', 10) || 20000;

        const subtotal = full24 * harga24 + use12 * harga12;
        const total = subtotal + ongkir;

        const lines = [];
        lines.push(`Nota untuk jadwal ID ${schedule.id}:`);
        lines.push(`Nama: ${schedule.customer || schedule.name || ''}`);
        lines.push(`Motor: ${schedule.motor_jenis || schedule.vehicle_type || ''}`);
        lines.push(`Dari: ${schedule.delivery_day || ''} ${schedule.delivery_time || ''}`);
        lines.push(`Sampai: ${schedule.pickup_day || ''} ${schedule.pickup_time || ''}`);
        lines.push(`Durasi (jam): ${totalHours}`);
        lines.push(`Perhitungan: ${full24} x 24 jam @ ${harga24} = ${full24 * harga24}` + (use12 ? ` ; + 1 x 12 jam @ ${harga12} = ${harga12}` : ''));
        lines.push(`Subtotal: ${subtotal}`);
        lines.push(`Ongkir: ${ongkir}`);
        lines.push(`TOTAL: ${total}`);
        // send the nota to customer using stored client_jid (WhatsApp id) if available, else fallback to WA_1
        const targetJid = schedule.client_jid || (schedule.WA_1 ? `${String(schedule.WA_1).replace(/[^0-9]/g,'')}@c.us` : null);
        if (!targetJid) return client.sendMessage(from, 'Tidak ada nomor WA customer tersimpan pada jadwal ini.');
        try {
          await client.client.sendMessage(targetJid, lines.join('\n'));
          return client.sendMessage(from, `Nota dikirim ke customer: ${targetJid}`);
        } catch (e) {
          console.error('Failed to send nota to customer', e && e.message);
          return client.sendMessage(from, 'Gagal mengirim nota ke customer: ' + (e && e.message));
        }
      } catch (err) {
        console.error('Admin nota error', err);
        return client.sendMessage(from, 'Gagal menghasilkan nota: ' + (err && err.message));
      }
    }

    // Unknown /admin command
    return client.sendMessage(from, 'Perintah admin tidak dikenal.');
  }

  // Non-admin: normal QA matching
  try {
    // Booking intent (e.g. "mau boking tgl 12/01" or "booking tanggal 2026-01-12 jam 10")
    const booking = parseBookingRequest(text);
    if (booking) {
      await client.sendMessage(from, 'Saya cek dlu ya kak');

      const startMs = booking.start ? booking.start.getTime() : Date.now();
      try {
        const rows = await db.listAllSchedules();
        const motors = await db.listMotors();

        const ddmmToDate = (ddmm, bulanHint) => {
          if (!ddmm) return null;
          const s = String(ddmm).trim();
          let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
          m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
          if (m) { const day = parseInt(m[1],10); const month = parseInt(m[2],10); const year = m[3] ? (m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10)) : (new Date()).getFullYear(); return new Date(year, month-1, day); }
          m = s.match(/^(\d{1,2})$/);
          if (m) { const day = parseInt(m[1],10); const now = new Date(); let month = now.getMonth()+1; let year = now.getFullYear(); if (bulanHint) { const bhm = String(bulanHint).match(/^(\d{1,2})(?:\/(\d{2,4}))?$/); if (bhm) { month = parseInt(bhm[1],10); if (bhm[2]) year = bhm[2].length===2?2000+parseInt(bhm[2],10):parseInt(bhm[2],10); } } return new Date(year, month-1, day); }
          return null;
        };
        const timeToMinutes = (t) => { if (!t) return null; const mm = String(t).match(/(\d{1,2})[:\.]?(\d{2})?/); if (!mm) return null; const hh = parseInt(mm[1],10); const mn = mm[2]?parseInt(mm[2],10):0; return hh*60+mn; };

        const scheduleStartDate = (r) => {
          if (r.pickup_day && r.pickup_time) { const pd = ddmmToDate(r.pickup_day, r.bulan); const pm = timeToMinutes(r.pickup_time); if (pd && pm != null) { const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm); return d; } }
          if (r.start_date && r.start_time) { const sd = ddmmToDate(r.start_date, r.bulan); const sm = timeToMinutes(r.start_time); if (sd && sm != null) { const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm); return d; } }
          if (r.delivery_day && r.delivery_time) { const dd = ddmmToDate(r.delivery_day, r.bulan); const dm = timeToMinutes(r.delivery_time); if (dd && dm != null) { const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm); return d; } }
          if (r.end_date && r.end_time) { const ed = ddmmToDate(r.end_date, r.bulan); const em = timeToMinutes(r.end_time); if (ed && em != null) { const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em); return d; } }
          return null;
        };

        const today = new Date(startMs);
        const todayDay = today.getDate(); const todayMonth = today.getMonth(); const todayYear = today.getFullYear();

        const bookedMotorIds = new Set();
        const bookedByJenis = {};
        const bookedEarliestPickupByJenis = {};
        const schedulePickupDate = (r) => {
          if (r.pickup_day && r.pickup_time) { const pd = ddmmToDate(r.pickup_day, r.bulan); const pm = timeToMinutes(r.pickup_time); if (pd && pm != null) { const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm); return d; } }
          if (r.start_date && r.start_time) { const sd = ddmmToDate(r.start_date, r.bulan); const sm = timeToMinutes(r.start_time); if (sd && sm != null) { const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm); return d; } }
          if (r.delivery_day && r.delivery_time) { const dd = ddmmToDate(r.delivery_day, r.bulan); const dm = timeToMinutes(r.delivery_time); if (dd && dm != null) { const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm); return d; } }
          if (r.end_date && r.end_time) { const ed = ddmmToDate(r.end_date, r.bulan); const em = timeToMinutes(r.end_time); if (ed && em != null) { const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em); return d; } }
          return null;
        };
        for (const r of rows) {
          const sd = scheduleStartDate(r); if (!sd) continue;
          if (sd.getDate() === todayDay && sd.getMonth() === todayMonth && sd.getFullYear() === todayYear) {
            if (r.motor_id) bookedMotorIds.add(String(r.motor_id));
            const jenis = (r.motor_jenis || r.vehicle_type || 'Lainnya').toString();
            bookedByJenis[jenis] = (bookedByJenis[jenis] || 0) + 1;
            const pickupDt = schedulePickupDate(r);
            if (pickupDt) {
              const cur = bookedEarliestPickupByJenis[jenis];
              if (!cur || pickupDt.getTime() < cur.getTime()) bookedEarliestPickupByJenis[jenis] = pickupDt;
            }
          }
        }

        const totalByJenis = {};
        const motorMap = {};
        for (const m of motors) { motorMap[String(m.id)] = m; totalByJenis[m.jenis || 'Lainnya'] = (totalByJenis[m.jenis || 'Lainnya'] || 0) + 1; }

        const availableMotorIds = [];
        for (const m of motors) { if (!bookedMotorIds.has(String(m.id))) availableMotorIds.push(m.id); }

        const availableByJenis = {};
        for (const id of availableMotorIds) { const m = motorMap[String(id)]; if (!m) continue; availableByJenis[m.jenis || 'Lainnya'] = (availableByJenis[m.jenis || 'Lainnya'] || 0) + 1; }

        // const parts = [];
        // parts.push('Daftar motor tersedia hari ini:');
        // const formatHM = (d) => { if (!d) return null; const hh = String(d.getHours()).padStart(2,'0'); const mm = String(d.getMinutes()).padStart(2,'0'); return `${hh}:${mm}`; };
        // for (const k of Object.keys(totalByJenis).sort()) {
        //   const avail = availableByJenis[k] || 0; const booked = bookedByJenis[k] || (totalByJenis[k] - avail);
        //   const earliest = bookedEarliestPickupByJenis[k] || null;
        //   if (earliest) {
        //     const ready = new Date(earliest.getTime() + 30*60000);
        //     parts.push(`${k}: ${avail} tersedia (${booked} diboking paling cepat ambil ${formatHM(earliest)} (ready ${formatHM(ready)}))`);
        //   } else {
        //     parts.push(`${k}: ${avail} tersedia (${booked} diboking)`);
        //   }
        // }

        // await client.sendMessage(from, parts.join('\n'));

        // send greeting + harga list only; do NOT prompt form or set flow here
        try {
          const priceLines = (motors || []).map(m => `${m.id}. ${m.jenis || ''} | ${m.plate || ''} | 24h: ${m.harga_24 || '-'} | 12h: ${m.harga_12 || '-'}`);
          await client.sendMessage(from, 'Halo, selamat siang.\nHarga motor:\n' + priceLines.join('\n'));
          const formTpl = 'Silakan isi formulir sewa berikut (balas dengan format "Label: nilai" per baris):\nJenis motor:\nMulai Tgl sewa:\nMulai jam sewa:\nAntar dimana:\nSelesai tgl sewa:\nSelesai jam sewa:\nAmbil motor di:\nMotor mau dipaki kemana:\nInstagram aktif:\nNama lengkap KTP:\nKTP kota mana:\nNO WA:\nNO WA kedua:';
          await client.sendMessage(from, formTpl);
          await client.sendMessage(from, 'baik selamat siang kak\nSilahkan jawab pertanyaan diatas sebelum order');
        } catch (e) {
          console.error('Error sending price message', e);
        }

        if (!sessions[from]) sessions[from] = {};
        sessions[from].availableMotors = availableMotorIds;
      } catch (err) {
        console.error('Booking availability error', err);
        await client.sendMessage(from, 'Gagal mencari ketersediaan untuk tanggal itu: ' + (err.message || err));
      }
      return;
    }

    // Availability intent (e.g. "apa ada motor ready", "motor tersedia dari jam 10 untuk 12 jam")
    const avail = parseAvailabilityRequest(text);
    if (avail) {
      const startMs = avail.start ? avail.start.getTime() : Date.now();
      try {
        const rows = await db.listAllSchedules();
        const motors = await db.listMotors();

        const ddmmToDate = (ddmm, bulanHint) => {
          if (!ddmm) return null;
          const s = String(ddmm).trim();
          let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
          m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
          if (m) { const day = parseInt(m[1],10); const month = parseInt(m[2],10); const year = m[3] ? (m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10)) : (new Date()).getFullYear(); return new Date(year, month-1, day); }
          m = s.match(/^(\d{1,2})$/);
          if (m) { const day = parseInt(m[1],10); const now = new Date(); let month = now.getMonth()+1; let year = now.getFullYear(); if (bulanHint) { const bhm = String(bulanHint).match(/^(\d{1,2})(?:\/(\d{2,4}))?$/); if (bhm) { month = parseInt(bhm[1],10); if (bhm[2]) year = bhm[2].length===2?2000+parseInt(bhm[2],10):parseInt(bhm[2],10); } } return new Date(year, month-1, day); }
          return null;
        };
        const timeToMinutes = (t) => { if (!t) return null; const mm = String(t).match(/(\d{1,2})[:\.]?(\d{2})?/); if (!mm) return null; const hh = parseInt(mm[1],10); const mn = mm[2]?parseInt(mm[2],10):0; return hh*60+mn; };

        const scheduleStartDate = (r) => {
          if (r.pickup_day && r.pickup_time) { const pd = ddmmToDate(r.pickup_day, r.bulan); const pm = timeToMinutes(r.pickup_time); if (pd && pm != null) { const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm); return d; } }
          if (r.start_date && r.start_time) { const sd = ddmmToDate(r.start_date, r.bulan); const sm = timeToMinutes(r.start_time); if (sd && sm != null) { const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm); return d; } }
          if (r.delivery_day && r.delivery_time) { const dd = ddmmToDate(r.delivery_day, r.bulan); const dm = timeToMinutes(r.delivery_time); if (dd && dm != null) { const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm); return d; } }
          if (r.end_date && r.end_time) { const ed = ddmmToDate(r.end_date, r.bulan); const em = timeToMinutes(r.end_time); if (ed && em != null) { const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em); return d; } }
          return null;
        };

        const today = new Date(startMs);
        const todayDay = today.getDate(); const todayMonth = today.getMonth(); const todayYear = today.getFullYear();

        const bookedMotorIds = new Set();
        const bookedByJenis = {};
        const bookedEarliestPickupByJenis = {};
        const schedulePickupDate = (r) => {
          if (r.pickup_day && r.pickup_time) { const pd = ddmmToDate(r.pickup_day, r.bulan); const pm = timeToMinutes(r.pickup_time); if (pd && pm != null) { const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm); return d; } }
          if (r.start_date && r.start_time) { const sd = ddmmToDate(r.start_date, r.bulan); const sm = timeToMinutes(r.start_time); if (sd && sm != null) { const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm); return d; } }
          if (r.delivery_day && r.delivery_time) { const dd = ddmmToDate(r.delivery_day, r.bulan); const dm = timeToMinutes(r.delivery_time); if (dd && dm != null) { const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm); return d; } }
          if (r.end_date && r.end_time) { const ed = ddmmToDate(r.end_date, r.bulan); const em = timeToMinutes(r.end_time); if (ed && em != null) { const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em); return d; } }
          return null;
        };
        for (const r of rows) {
          const sd = scheduleStartDate(r); if (!sd) continue;
          if (sd.getDate() === todayDay && sd.getMonth() === todayMonth && sd.getFullYear() === todayYear) {
            if (r.motor_id) bookedMotorIds.add(String(r.motor_id));
            const jenis = (r.motor_jenis || r.vehicle_type || 'Lainnya').toString();
            bookedByJenis[jenis] = (bookedByJenis[jenis] || 0) + 1;
            const pickupDt = schedulePickupDate(r);
            if (pickupDt) {
              const cur = bookedEarliestPickupByJenis[jenis];
              if (!cur || pickupDt.getTime() < cur.getTime()) bookedEarliestPickupByJenis[jenis] = pickupDt;
            }
          }
        }

        const totalByJenis = {};
        const motorMap = {};
        for (const m of motors) { motorMap[String(m.id)] = m; totalByJenis[m.jenis || 'Lainnya'] = (totalByJenis[m.jenis || 'Lainnya'] || 0) + 1; }

        const availableMotorIds = [];
        for (const m of motors) { if (!bookedMotorIds.has(String(m.id))) availableMotorIds.push(m.id); }

        const availableByJenis = {};
        for (const id of availableMotorIds) { const m = motorMap[String(id)]; if (!m) continue; availableByJenis[m.jenis || 'Lainnya'] = (availableByJenis[m.jenis || 'Lainnya'] || 0) + 1; }

        // const parts = [];
        // parts.push('Daftar motor tersedia hari ini:');
        // const formatHM = (d) => { if (!d) return null; const hh = String(d.getHours()).padStart(2,'0'); const mm = String(d.getMinutes()).padStart(2,'0'); return `${hh}:${mm}`; };
        // for (const k of Object.keys(totalByJenis).sort()) {
        //   const avail = availableByJenis[k] || 0; const booked = bookedByJenis[k] || (totalByJenis[k] - avail);
        //   const earliest = bookedEarliestPickupByJenis[k] || null;
        //   if (earliest) {
        //     const ready = new Date(earliest.getTime() + 30*60000);
        //     parts.push(`${k}: ${avail} tersedia (${booked} diboking paling cepat ambil ${formatHM(earliest)} (ready ${formatHM(ready)}))`);
        //   } else {
        //     parts.push(`${k}: ${avail} tersedia (${booked} diboking)`);
        //   }
        // }

        // await client.sendMessage(from, parts.join('\n'));
        try {
          const priceLines = (motors || []).map(m => `${m.id}. ${m.jenis || ''} | ${m.plate || ''} | 24h: ${m.harga_24 || '-'} | 12h: ${m.harga_12 || '-'}`);
          await client.sendMessage(from, 'Halo, selamat siang.\nHarga motor:\n \n*BEAT*\nHARGA 24 JAM 80.000\n12 JAM : 60.000\nBiaya Antar Jemput :20.000\n\n*SCOPPY*\nHARGA 24 JAM 90.000\n12 JAM : 70.000\nBiaya Antar Jemput : 20.000\n\n*Vario*\nHARGA 24 JAM 100.000\n12 JAM : 80.000\nBiaya Antar Jemput : 20.000\n\n*NMAX/PCX*\nHARGA 24 JAM 130.000\n12 JAM : 110.000\nBiaya Antar Jemput : 20.000\n' );
          const formTpl = 'Silakan isi formulir sewa berikut (balas dengan format "Label: nilai" per baris):\nJenis motor:\nMulai Tgl sewa:\nMulai jam sewa:\nAntar dimana:\nSelesai tgl sewa:\nSelesai jam sewa:\nAmbil motor di:\nMotor mau dipaki kemana:\nInstagram aktif:\nNama lengkap KTP:\nKTP kota mana:\nNO WA:\nNO WA kedua:';
          await client.sendMessage(from, formTpl);
          await client.sendMessage(from, 'baik selamat siang kak\nSilahkan jawab pertanyaan diatas sebelum order');
        } catch (e) { console.error('Error sending form messages', e); }
        if (!sessions[from]) sessions[from] = {};
        sessions[from].availableMotors = availableMotorIds;
      } catch (err) {
        console.error('Availability lookup error', err);
        await client.sendMessage(from, 'Gagal mencari ketersediaan motor: ' + (err.message || err));
      }
      return;
    }

    // Use trained NLP model for non-admin conversations; support DB-driven intents
    try {
      const res = await nlpRunner.processText(text);
      const intent = res && res.intent ? String(res.intent) : 'None';

      // handle DB-driven intent: list motors
      if (intent === 'list.motors' || /list\.motors/.test(intent)) {
        try {
          const motors = await db.listMotors();
          if (!motors || motors.length === 0) {
            await client.sendMessage(from, 'Belum ada data motor.');
          } else {
            const lines = motors.map(m => `${m.id}. ${m.jenis || ''} | ${m.plate || ''}`);
            await client.sendMessage(from, `Daftar motor (${motors.length}):\n` + lines.join('\n'));
          }
        } catch (e) {
          console.error('DB listMotors error', e);
          await client.sendMessage(from, 'Gagal mengambil daftar motor.');
        }
        return;
      }

      // fallback to model-provided answer (if any)
      const answer = await nlpRunner.getAnswer(text);
      if (answer) {
        await client.sendMessage(from, answer);
      } else {
        await client.sendMessage(from, 'Maaf, saya belum mengerti. Coba ulangi dengan kata lain atau hubungi admin.');
      }
    } catch (e) {
      console.error('NLP reply error', e);
      await client.sendMessage(from, 'Terjadi kesalahan saat memproses pesan.');
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

// API update QA
app.put('/api/qa/:id', async (req, res) => {
  const id = req.params.id;
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer required' });
  try {
    const result = await db.updateQA ? await db.updateQA(id, question, answer) : await require('./db').updateQA(id, question, answer);
    if (result.changes === 0) return res.status(404).json({ error: 'QA not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// API delete QA
app.delete('/api/qa/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.deleteQA ? await db.deleteQA(id) : await require('./db').deleteQA(id);
    if (result.changes === 0) return res.status(404).json({ error: 'QA not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// API status WA
app.get('/api/status', (req, res) => {
  // Status terbaru dikirim via socket. Endpoint ini sederhana saja.
  res.json({ ok: true });
});

// Minimal schedules endpoints: add and list
app.get('/api/schedules', async (req, res) => {
  try {
    const rows = await db.listSchedules();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// Full schedules listing (excludes future 'bulan' bookings until their day arrives)
app.get('/api/schedules/full', async (req, res) => {
  try {
    if (!db.listSchedulesFull) return res.status(500).json({ error: 'DB missing listSchedulesFull' });
    const rows = await db.listSchedulesFull();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// list distinct plates for dropdown
app.get('/api/plates', async (req, res) => {
  try {
    if (!db.listPlates) return res.json([]);
    const rows = await db.listPlates();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// motors endpoints: list and add
app.get('/api/motors', async (req, res) => {
  try {
    const rows = await db.listPlates();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// Update motor by id
app.put('/api/motors/:id', async (req, res) => {
  const id = req.params.id;
  const { jenis, plate, harga_24, harga_12 } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const result = await db.updateMotor ? await db.updateMotor(id, jenis || '', plate || '', harga_24 || '', harga_12 || '') : null;
    if (result && result.changes === 0) return res.status(404).json({ error: 'Motor not found or no change' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

// Change motor id (oldId -> newId) and update schedules.motor_id
app.post('/api/motors/change-id', async (req, res) => {
  try {
    const { oldId, newId } = req.body || {};
    if (!oldId || !newId) return res.status(400).json({ error: 'oldId and newId required' });
    if (isNaN(Number(oldId)) || isNaN(Number(newId))) return res.status(400).json({ error: 'IDs must be numeric' });
    const result = await db.changeMotorId ? await db.changeMotorId(oldId, newId) : await require('./db').changeMotorId(oldId, newId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err && err.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const item = req.body || {};
    // basic validation: need vehicle_type, plate and name
    if (!item.vehicle_type) return res.status(400).json({ error: 'vehicle_type required' });
    const plate = (item.plate || '').trim();
    if (!plate) return res.status(400).json({ error: 'plate required' });
    if (!item.name) return res.status(400).json({ error: 'name is required' });

    // helper parsers (existing)
    const parsePeriodToDates = (p) => {
      // Returns { startDate: Date|null, endDate: Date|null }
      if (!p) return { startDate: null, endDate: null };
      const raw = p.replace(/\s+/g,'');
      const parts = raw.split('-');
      const now = new Date();
      const thisYear = now.getFullYear();
      const thisMonth = now.getMonth() + 1; // 1-12

      const parsePart = (part) => {
        // supports dd/mm or d
        const m1 = part.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (m1) {
          const day = parseInt(m1[1],10);
          const month = parseInt(m1[2],10);
          return new Date(thisYear, month - 1, day);
        }
        const m2 = part.match(/^(\d{1,2})$/);
        if (m2) {
          const day = parseInt(m2[1],10);
          return new Date(thisYear, thisMonth - 1, day);
        }
        return null;
      };

      const startDate = parsePart(parts[0]);
      let endDate = null;
      if (parts.length > 1) endDate = parsePart(parts[1]);
      if (!endDate && startDate) endDate = startDate;
      return { startDate, endDate };
    };
    const toMinutes = (hhmm) => {
      if (!hhmm) return null;
      const m = hhmm.match(/(\d{1,2})[:\.]?(\d{2})?/);
      if (!m) return null;
      const hh = parseInt(m[1],10);
      const mm = m[2] ? parseInt(m[2],10) : 0;
      return hh*60 + mm;
    };
    const parseTimeRange = (t) => {
      if (!t) return { startMin: null, endMin: null };
      const parts = t.split(/[-–—\/]/).map(s=>s.trim()).filter(Boolean);
      if (parts.length === 1) {
        const s = toMinutes(parts[0]);
        return { startMin: s, endMin: s };
      }
      const s = toMinutes(parts[0]);
      const e = toMinutes(parts[1]);
      return { startMin: s, endMin: e };
    };

    const parseEntryText = (txt) => {
      const parts = (txt||'').split('/').map(p=>p.trim()).filter(Boolean);
      let period=''; let time=''; let pickup=''; let dropoff=''; let customer=''; let price='';
      // detect period (first part like 1-2)
      if (parts.length>0 && /^(\d+)(?:-\d+)?$/.test(parts[0].replace(/\s+/g,''))) {
        period = parts.shift();
      }
      // detect time part (contains digits and ':' or '.') and maybe '-'
      const timeIdx = parts.findIndex(p=>/\d{1,2}[:\.]?\d{0,2}(?:\s*[-–—\/]\s*\d{1,2}[:\.]?\d{0,2})?/.test(p));
      if (timeIdx !== -1) {
        time = parts.splice(timeIdx,1)[0];
      }
      // detect price if numeric at end
      if (parts.length && /^\d+$/.test(parts[parts.length-1])) {
        price = parts.pop();
      }
      // remaining parts may include customer and pickup-dropoff
      if (parts.length) {
        // look for pickup-dropoff pattern
        const locIdx = parts.findIndex(p=>/[-–—]/.test(p));
        if (locIdx !== -1) {
          const p = parts.splice(locIdx,1)[0];
          const [a,b] = p.split(/[-–—]/).map(s=>s.trim());
          pickup = a || '';
          dropoff = b || a || '';
        }
      }
      if (!pickup && parts.length) {
        // if single location string remains
        pickup = parts.shift() || '';
        dropoff = pickup;
      }
      if (parts.length) {
        customer = parts.join(' / ');
      }
      return { period, time, pickup, dropoff, customer, price };
    };
    // if entry_text present, parse it to fill fields; otherwise accept explicit fields from client
    if (item.entry_text) {
      const parsed = parseEntryText(item.entry_text);
      item.period = item.period || parsed.period;
      item.time = item.time || parsed.time;
      item.pickup = parsed.pickup || item.pickup;
      item.dropoff = parsed.dropoff || item.dropoff;
      item.customer = item.customer || parsed.customer;
      item.price = item.price || parsed.price;
    }

    // Accept pickup/delivery day (DD/MM) and time (HH:MM). Validate delivery >= last pickup + 30min and delivery day not before last pickup day.
    const ddmmToDate = (ddmm) => {
      if (!ddmm) return null;
      const m = ddmm.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (!m) return null;
      const day = parseInt(m[1],10);
      const month = parseInt(m[2],10);
      if (month < 1 || month > 12) return null;
      const now = new Date();
      const year = now.getFullYear();
      const daysInMonth = new Date(year, month, 0).getDate();
      if (day < 1 || day > daysInMonth) return null;
      return new Date(year, month - 1, day);
    };
    const timeToMinutes = (t) => {
      if (!t) return null;
      const m = t.match(/(\d{1,2})[:\.](\d{2})/);
      if (!m) return null;
      return parseInt(m[1],10)*60 + parseInt(m[2],10);
    };

    // map explicit pickup/dropoff and price fields
    if (item.pickup_explicit) item.pickup = item.pickup_explicit;
    if (item.dropoff_explicit) item.dropoff = item.dropoff_explicit;
    if (item.total_price) item.price = item.total_price;

    // Build new absolute minutes for pickup/delivery if provided
    let newPickupAbs = null;
    let newDeliveryAbs = null;
    if (item.pickup_day && item.pickup_time) {
      const pd = ddmmToDate(item.pickup_day);
      const pm = timeToMinutes(item.pickup_time);
      if (!pd || pm == null) return res.status(400).json({ error: 'Invalid pickup day/time' });
      const pdt = new Date(pd.getTime()); pdt.setHours(0,0,0,0); pdt.setMinutes(pm);
      newPickupAbs = Math.floor(pdt.getTime()/60000);
    } else if (item.start_date && item.start_time) {
      const sd = ddmmToDate(item.start_date) || null;
      const sm = timeToMinutes(item.start_time);
      if (sd && sm != null) {
        const sdt = new Date(sd.getTime()); sdt.setHours(0,0,0,0); sdt.setMinutes(sm);
        newPickupAbs = Math.floor(sdt.getTime()/60000);
      }
    }
    if (item.delivery_day && item.delivery_time) {
      const dd = ddmmToDate(item.delivery_day);
      const dm = timeToMinutes(item.delivery_time);
      if (!dd || dm == null) return res.status(400).json({ error: 'Invalid delivery day/time' });
      const ddt = new Date(dd.getTime()); ddt.setHours(0,0,0,0); ddt.setMinutes(dm);
      newDeliveryAbs = Math.floor(ddt.getTime()/60000);
    } else if (item.end_date && item.end_time) {
      const ed = ddmmToDate(item.end_date) || null;
      const em = timeToMinutes(item.end_time);
      if (ed && em != null) {
        const edt = new Date(ed.getTime()); edt.setHours(0,0,0,0); edt.setMinutes(em);
        newDeliveryAbs = Math.floor(edt.getTime()/60000);
      }
    }

    // enforce delivery (antar/start) earliest 06:00 and pickup (ambil/end) latest 23:00
    if (newDeliveryAbs != null) {
      // get minutes of day for delivery_time
      const delM = timeToMinutes(item.delivery_time || item.end_time || '');
      if (delM != null && delM < 6*60) return res.status(400).json({ error: 'Delivery (antar) earliest is 06:00' });
    }
    if (newPickupAbs != null) {
      const pickM = timeToMinutes(item.pickup_time || item.start_time || '');
      if (pickM != null && pickM > 23*60) return res.status(400).json({ error: 'Pickup (ambil) latest is 23:00' });
    }

    // get latest existing schedule for this motor or plate and perform conflict check if possible
    let latest = null;
    if (item.motor_id) {
      latest = await db.getLatestScheduleByMotorId(item.motor_id).catch(() => null);
    } else {
      latest = await db.getLatestScheduleByPlate(plate).catch(() => null);
    }
    if (latest) {
      const lastPickupDay = latest.pickup_day || latest.start_date || null;
      const lastPickupTime = latest.pickup_time || latest.start_time || null;
      if (lastPickupDay && lastPickupTime) {
        const lpd = ddmmToDate(lastPickupDay);
        const lpm = timeToMinutes(lastPickupTime);
        if (lpd && lpm != null) {
          const ldt = new Date(lpd.getTime()); ldt.setHours(0,0,0,0); ldt.setMinutes(lpm);
          const lastPickupAbs = Math.floor(ldt.getTime()/60000);
          // if delivery time provided, enforce >= last pickup + 30 minutes
          if (newDeliveryAbs != null) {
            const MIN_GAP = 30;
            if (newDeliveryAbs < lastPickupAbs + MIN_GAP) {
              return res.status(400).json({ error: `Delivery time must be at least ${MIN_GAP} minutes after last pickup for this vehicle` });
            }
          }
          // if delivery day provided, require delivery day >= last pickup day
          if (item.delivery_day) {
            const lastDayOnly = new Date(lpd.getFullYear(), lpd.getMonth(), lpd.getDate());
            const newD = ddmmToDate(item.delivery_day);
            if (newD) {
              const newDayOnly = new Date(newD.getFullYear(), newD.getMonth(), newD.getDate());
              if (newDayOnly.getTime() < lastDayOnly.getTime()) {
                return res.status(400).json({ error: 'Delivery day must be the same day or after the last pickup day for this vehicle' });
              }
            }
          }
        }
      }
    }

    const row = await db.addSchedule(item);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
