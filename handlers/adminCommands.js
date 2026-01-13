const utils = require('../lib/utils');

async function handleAdmin({ from, text, msg, client, db, sessions, db_admin, MessageMedia, io }) {
  // admin login
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
        sessions[from] = Object.assign(sessions[from] || {}, { authenticated: true });
        client.sendMessage(from, 'Login admin berhasil.');
      } else {
        client.sendMessage(from, 'Login gagal. Nomor atau password salah.');
      }
    });
    return true;
  }

  // pendingAction handling
  if (sessions[from] && sessions[from].pendingAction) {
    const pending = sessions[from].pendingAction;
    if (text.toLowerCase() === 'yes') {
      if (pending === 'clear_schedules') {
        try {
          const result = await (db.clearSchedules ? db.clearSchedules() : require('../db').clearSchedules());
          delete sessions[from].pendingAction;
          await client.sendMessage(from, `Berhasil menghapus ${result.changes} baris dari tabel jadwal.`);
          return true;
        } catch (err) {
          delete sessions[from].pendingAction;
          console.error('Confirm clear schedules error', err);
          return client.sendMessage(from, 'Gagal mengosongkan jadwal: ' + (err.message || err));
        }
      }
    }

    if (pending && typeof pending === 'object' && pending.action === 'choose_motor') {
      const p = pending;
      const t = text.trim().toLowerCase();
      if (t === 'cancel') {
        delete sessions[from].pendingAction;
        await client.sendMessage(from, 'Penugasan jadwal dibatalkan.');
        return true;
      }
      const chosenId = parseInt(text.trim(), 10);
      if (isNaN(chosenId)) { await client.sendMessage(from, 'Silakan balas dengan ID motor yang valid atau ketik "cancel".'); return true; }
      try {
        const rows = await (db.listAllSchedules ? db.listAllSchedules() : db.listSchedules());
        const motors = await db.listMotors();
        const motor = motors.find(m => Number(m.id) === Number(chosenId));
        if (!motor) { await client.sendMessage(from, `Motor ID ${chosenId} tidak ditemukan dalam kandidat.`); return true; }

        const scheduleIntervalMs = (row) => utils.scheduleIntervalMs(row);
        const desired = p.desired;
        const motorSchedules = rows.filter(s => (s.motor_id != null && String(s.motor_id) === String(chosenId)) || ((s.motor_plate || s.plate || '') && (s.motor_plate || s.plate || '').toLowerCase() === (motor.plate || '').toLowerCase()));
        let overlapFound = false;
        for (const s of motorSchedules) {
          const iv = scheduleIntervalMs(s);
          if (!iv) continue;
          if (iv.endMs >= desired.startMs && iv.startMs <= desired.endMs) { overlapFound = true; break; }
        }
        if (overlapFound) { await client.sendMessage(from, `Motor ID ${chosenId} sedang sibuk pada interval yang diminta. Pilih motor lain atau ketik 'cancel'.`); return true; }

        const nota = p.nota || {};
        // try to read persisted dump (if present) to get computed harga/total
        let dump = null;
        try {
          if (nota.no_form && db.getDumpScheduleByNoForm) {
            dump = await db.getDumpScheduleByNoForm(nota.no_form).catch(() => null);
          }
        } catch (e) { dump = null; }

        const final_total = (dump && (dump.total_price || dump.price)) || nota.total_price || nota.price || '';
        const final_wa = (dump && (dump.WA_1 || dump.WA)) || nota.WA_1 || nota.WA || '';

        const item = {
          vehicle_type: motor.jenis || nota.vehicle_type || nota.motor_jenis || '',
          motor_id: motor.id,
          plate: motor.plate || nota.plate || '',
          delivery_day: nota.delivery_day || nota.start_date || '',
          delivery_time: nota.delivery_time || nota.start_time || '',
          pickup_day: nota.pickup_day || nota.end_date || '',
          pickup_time: nota.pickup_time || nota.end_time || '',
          pickup: nota.pickup || '',
          dropoff: nota.dropoff || '',
          total_price: final_total,
          price: (dump && dump.price) || nota.price || '',
          entry_text: nota.entry_text || '',
          customer: nota.customer || nota.name || '',
          WA_1: final_wa,
          no_form: nota.no_form || ''
        };
        const row = await db.addSchedule(item);
        delete sessions[from].pendingAction;
        await client.sendMessage(from, `Jadwal dari nota ${p.no_form} berhasil dibuat. Jadwal ID ${row.id} — Motor: ${motor.id} ${motor.plate}`);
        try {
          const phoneRaw = (nota.WA_1 || nota.WA || '').toString().replace(/[^0-9]/g, '');
          if (phoneRaw) {
            const targetJid = `${phoneRaw}@c.us`;
            await client.client.sendMessage(targetJid, 'Jadwal sudah kita inputkan ka');
          }
        } catch (e) { console.error('Failed to notify customer', e && e.message); }
        return true;
      } catch (err) {
        console.error('Choose motor pending error', err);
        await client.sendMessage(from, 'Gagal memproses pilihan motor: ' + (err && err.message));
        return true;
      }
    }
  }

  return false;
}

module.exports = { handleAdmin };
