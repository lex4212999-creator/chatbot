// lib/utils.js - shared helpers
module.exports = {
  ddmmToDate: (ddmm, bulanHint) => {
    if (!ddmm) return null;
    const s = String(ddmm).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (m) { const day = parseInt(m[1],10); const month = parseInt(m[2],10); const year = m[3] ? (m[3].length===2?2000+parseInt(m[3],10):parseInt(m[3],10)) : (new Date()).getFullYear(); return new Date(year, month-1, day); }
    m = s.match(/^(\d{1,2})$/);
    if (m) { const day = parseInt(m[1],10); let month = (new Date()).getMonth()+1; let year = (new Date()).getFullYear(); if (bulanHint) { const bhm = String(bulanHint).match(/^(\d{1,2})(?:\/(\d{2,4}))?$/); if (bhm) { month = parseInt(bhm[1],10); if (bhm[2]) year = bhm[2].length===2?2000+parseInt(bhm[2],10):parseInt(bhm[2],10); } } return new Date(year, month-1, day); }
    return null;
  },

  timeToMinutes: (t) => { if (!t) return null; const mm = String(t).match(/(\d{1,2})[:\.]?(\d{2})?/); if (!mm) return null; const hh = parseInt(mm[1],10); const mn = mm[2]?parseInt(mm[2],10):0; return hh*60+mn; },

  // resolveMotor accepts a db object exposing getMotorById and listMotors
  resolveMotor: async (db, motorVal) => {
    if (!motorVal) return null;
    const asId = parseInt(String(motorVal).trim(), 10);
    if (!isNaN(asId)) {
      const byId = (db.getMotorById) ? await db.getMotorById(asId).catch(() => null) : null;
      if (byId) return { found: byId };
    }
    if (!db.listMotors) return null;
    const motors = await db.listMotors().catch(() => []);
    const val = String(motorVal || '').toLowerCase().trim();
    let found = motors.find(m => (m.plate || '').toLowerCase() === val);
    if (found) return { found };
    found = motors.find(m => (m.jenis || '').toLowerCase() === val);
    if (found) return { found };
    const candidates = motors.filter(m => { const jenis = (m.jenis || '').toLowerCase(); return jenis.includes(val) || val.includes(jenis); });
    if (candidates.length >= 1) return { found: candidates[0] };
    found = motors.find(m => (m.plate || '').toLowerCase().includes(val));
    if (found) return { found };
    return null;
  },

  // return interval {startMs,endMs,row} or null
  scheduleIntervalMs: (row) => {
    if (!row) return null;
    const { ddmmToDate, timeToMinutes } = module.exports;
    let startDate = null, endDate = null;
    if (row.pickup_day && row.pickup_time) { const pd = ddmmToDate(row.pickup_day, row.bulan); const pm = timeToMinutes(row.pickup_time); if (pd && pm != null) { const d = new Date(pd.getTime()); d.setHours(0,0,0,0); d.setMinutes(pm); startDate = d; } }
    if (!startDate && row.start_date && row.start_time) { const sd = ddmmToDate(row.start_date, row.bulan); const sm = timeToMinutes(row.start_time); if (sd && sm != null) { const d = new Date(sd.getTime()); d.setHours(0,0,0,0); d.setMinutes(sm); startDate = d; } }
    if (row.delivery_day && row.delivery_time) { const dd = ddmmToDate(row.delivery_day, row.bulan); const dm = timeToMinutes(row.delivery_time); if (dd && dm != null) { const d = new Date(dd.getTime()); d.setHours(0,0,0,0); d.setMinutes(dm); endDate = d; } }
    if (!endDate && row.end_date && row.end_time) { const ed = ddmmToDate(row.end_date, row.bulan); const em = timeToMinutes(row.end_time); if (ed && em != null) { const d = new Date(ed.getTime()); d.setHours(0,0,0,0); d.setMinutes(em); endDate = d; } }
    if (startDate && !endDate) endDate = new Date(startDate.getTime());
    if (!startDate && endDate) startDate = new Date(endDate.getTime());
    if (!startDate && !endDate) return null;
    return { startMs: startDate.getTime(), endMs: endDate.getTime(), row };
  }
};
