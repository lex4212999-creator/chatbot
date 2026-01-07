const fs = require('fs');
const path = require('path');
const db = require('./db');

// Simple parser: expects a raw text file where vehicle headers are lines with an asterisk and plate,
// and schedule lines start with an arrow (➡ or ->). This is a heuristic parser and won't be perfect.

const RAW_PATH = path.join(__dirname, 'data', 'schedule_raw.txt');

function parseRaw(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  let currentVehicle = null;
  for (const line of lines) {
    // vehicle header heuristic: contains plate-like token (numbers + letters) and often starts with '*'
    const headerMatch = line.match(/\*?\s*([A-Z0-9. ]{3,})\s*\*/);
    // better heuristic: lines with word 'BEAT' or vehicle types
    if (/BEAT|SCOOPY|VARIO|NMAX|PCX|SCOOPY/i.test(line) && /\d{2,}/.test(line)) {
      // try extract plate
      const plateMatch = line.match(/([A-Z0-9]{2,}\s?[A-Z0-9]{0,4})/i);
      currentVehicle = { vehicle_type: line.replace(/\*/g, ''), plate: '', entry_text: '', start_date: '', end_date: '', time: '', price: '', notes: '' };
      items.push(currentVehicle);
      continue;
    }
    // schedule lines start with arrow or bullet
    if (/^➡|^->|^-/i.test(line) || /^\u27A1/.test(line)) {
      if (!currentVehicle) continue;
      // remove leading arrow characters
      const entry = line.replace(/^➡+\s*/g, '').replace(/^->+\s*/g, '').replace(/^-/g, '').trim();
      // try to split by '/'
      const parts = entry.split('/').map(p => p.trim());
      const maybeDates = parts[0] || '';
      const name = parts[1] || '';
      const location = parts[2] || '';
      const time = parts[3] || '';
      const price = parts[4] || '';
      const item = {
        vehicle_type: currentVehicle.vehicle_type,
        plate: currentVehicle.plate,
        entry_text: entry,
        start_date: maybeDates,
        end_date: '',
        time: time,
        price: price,
        notes: [name, location].filter(Boolean).join(' / ')
      };
      items.push(item);
    }
  }
  return items;
}

async function run() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error('Place your raw schedule text into', RAW_PATH);
    process.exit(1);
  }
  const raw = fs.readFileSync(RAW_PATH, 'utf8');
  const items = parseRaw(raw);
  console.log('Parsed', items.length, 'items. Inserting...');
  for (const it of items) {
    try {
      await db.addSchedule(it);
    } catch (err) {
      console.error('Insert error', err.message);
    }
  }
  console.log('Import complete.');
}

run().catch(err => console.error(err));
