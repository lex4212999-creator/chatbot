const db = require('./db');
(async () => {
  try {
    const now = Date.now();
    console.log('Now:', new Date(now).toString());
    const res = await db.findMotorsAvailability(now, 12, 30, true);
    // Format like chat: group ready by jenis, show busy (pickup time and ready time)
    const formatTime = (ms) => {
      if (!ms) return '-';
      const d = new Date(ms);
      return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };

    const freeCounts = {};
    const busyMap = {};
    for (const r of res) {
      const jenis = (r.jenis || 'Lainnya').toString();
      if (r.status === 'free') freeCounts[jenis] = (freeCounts[jenis] || 0) + 1;
      else {
        if (!busyMap[jenis]) busyMap[jenis] = [];
        const pick = r.nextPickupMs || r.freeAtMs || null;
        if (pick) busyMap[jenis].push(pick);
      }
    }

    console.log('\nMotor yg ready:');
    if (Object.keys(freeCounts).length === 0) console.log('(tidak ada)');
    else Object.keys(freeCounts).sort().forEach(k => console.log(`${k} (${freeCounts[k]})`));

    console.log('\nMotor yg masih diboking tapi ambil hari ini:');
    if (Object.keys(busyMap).length === 0) console.log('(tidak ada)');
    else {
      Object.keys(busyMap).sort().forEach(k => {
        const times = busyMap[k].sort((a,b)=>a-b).map(t=>{
          const pickup = formatTime(t);
          const ready = formatTime(t + 30*60000);
          return `${pickup} (ready ${ready})`;
        });
        console.log(`${k} ${times.join(', ')}`);
      });
    }
    process.exit(0);
  } catch (e) {
    console.error('Error', e);
    process.exit(1);
  }
})();
