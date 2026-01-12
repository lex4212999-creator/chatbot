// nlp-train.js
// Training script for chatbot intents using node-nlp
// Usage:
//   npm install node-nlp
//   node nlp-train.js

const { NlpManager } = require('node-nlp');
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, 'data', 'nlp_model.nlp');

async function train() {
  const manager = new NlpManager({ languages: ['id'], forceNER: true });


  // No Sim
  manager.addDocument('id', 'Kak saya gak punya sim c', 'No.sim');
  manager.addDocument('id', 'maaf klo tidak ada sim C bagaimana', 'No.sim');
  manager.addDocument('id', 'ka gk ada sim C', 'No.sim');
  manager.addDocument('id', 'saya tidak membawa sim c', 'No.sim');
  manager.addDocument('id', 'klo belum punya sim c gimana ka?', 'No.sim');
  manager.addDocument('id', 'gk ada sim c', 'No.sim');

  manager.addAnswer('id', 'No.sim', 'Tanpa Sim c \n Iya Bisa Kak Tapi apabila terjadi pelanggaran lalu lintas,penyewa yang bertanggung jawab  ya kak');

  
  // Bensin
  manager.addDocument('id', 'kak untuk bensin gimana', 'bensin');
  manager.addDocument('id', 'kak untuk bensinya bagaimana', 'bensin');
  manager.addDocument('id', 'kalo bensin gimana', 'bensin');
  manager.addDocument('id', 'kak tanya untuk bensinnya', 'bensin');
  manager.addDocument('id', 'ka apa sudah include bensin', 'bensin');
  manager.addDocument('id', 'kak ini suda diisi bensin?', 'bensin');
  manager.addDocument('id', 'ini bensin suda full ya', 'bensin');
  manager.addDocument('id', 'kak apa sudah bisa diisi bensin', 'bensin');

  manager.addAnswer('id', 'bensin', 'Untuk BBM sudah kita isi secukupnya ya kak, apabila ingin melakukan perjalanan jauh  silahkan diisi sendiri sesuai kebutuhan Kak');

  
  manager.addDocument('id', 'kak ini bukti tfnya', 'bukti.TF');
  manager.addDocument('id', 'kak saya sudah TF', 'bukti.TF');
  manager.addDocument('id', 'kak ini TF anya', 'bukti.TF');
  manager.addDocument('id', 'Sudah TF min', 'bukti.TF');
  manager.addDocument('id', 'Done Tf min', 'bukti.TF');
  manager.addDocument('id', 'min sudah TF', 'bukti.TF');

  manager.addAnswer('id', 'bukti.TF', 'Baik kak, Mohon disimpan bukti TFnya ya kak, mungkin nanti bagian antar jemput minta buat laporan');

  // Down Payment
  manager.addDocument('id', 'Kak kalo saya dp dlu bagaimana', 'DP');
  manager.addDocument('id', 'min ini kalo dp aturanya bagaimana', 'DP');
  manager.addDocument('id', 'ini kalo saya dp apa bisa direfund', 'DP');
  manager.addDocument('id', 'klo dp 50% apa bisa', 'DP');
  manager.addDocument('id', 'ini saya DP y min', 'DP');
  manager.addDocument('id', 'ini saya dp kak', 'DP');

  manager.addAnswer('id', 'DP', 'Baik kak, \n Untuk DP apabila cancel dihari H, uang tidak bisa direfund\n Apabla cancel di 1 Hari sebelum hari H, uang bisa direfund');

  
  // No.Dp
  manager.addDocument('id', 'kak ini tanpa dp apa bisa', 'No.DP');
  manager.addDocument('id', 'kak ini saya langsung bayar di hari H apa bisa', 'No.DP');
  manager.addDocument('id', 'Kak ini saya bayar pas ketemuan', 'No.DP');
  manager.addDocument('id', 'Boleh tanpa DP', 'No.DP');
  manager.addDocument('id', 'Saya bayar besok ya', 'No.DP');
  manager.addDocument('id', 'Kak kalo gk dp apa bisa', 'No.DP');

  manager.addAnswer('id', 'No.DP', 'Baik ka Bisa. \n untuk tanpa DP. Pembayaran setelah menerima motor ya kak. \n ');

  // Jam.operasional
  manager.addDocument('id', 'kak rentalnya bukak jam berapa?', 'Jam.operasional');
  manager.addDocument('id', 'ini kak rentalnya apa 24 jam', 'Jam.operasional');
  manager.addDocument('id', 'Kak klo diambil jam 12 apa bisa', 'Jam.operasional');
  manager.addDocument('id', 'kak Buka paling awal jam berapa', 'Jam.operasional');
  manager.addDocument('id', 'Kak paling terlambat ambil jam berapa', 'Jam.operasional');
  manager.addDocument('id', 'Min, mau sewa jam 5 pagi apa bisa', 'Jam.operasional');

  manager.addAnswer('id', 'Jam.operasional', 'Jam Operasinal Antar + Jemput kita ka \n 06.00-23.00');

  // GREETING
  manager.addDocument('id', 'halo', 'greetings.hello');
  manager.addDocument('id', 'hai', 'greetings.hello');
  manager.addDocument('id', 'selamat pagi', 'greetings.hello');
  manager.addDocument('id', 'selamat siang', 'greetings.hello');
  manager.addDocument('id', 'selamat sore', 'greetings.hello');
  manager.addDocument('id', 'halo kak', 'greetings.hello');

  manager.addAnswer('id', 'greetings.hello', 'Halo! Ada yang bisa saya bantu?');

  // THANKS
  manager.addDocument('id', 'makasih', 'thanks');
  manager.addDocument('id', 'terima kasih', 'thanks');
  manager.addAnswer('id', 'thanks', 'Sama-sama!');

  // AVAILABILITY intents
  manager.addDocument('id', 'apa ada motor ready', 'availability.query');
  manager.addDocument('id', 'motor ready?', 'availability.query');
  manager.addDocument('id', 'ada motor tersedia', 'availability.query');
  manager.addDocument('id', 'motor tersedia dari jam 10', 'availability.query');
  manager.addDocument('id', 'motor tersedia untuk 12 jam', 'availability.query');
  manager.addDocument('id', 'apakah ada motor pada tanggal 12/01', 'availability.query');
  manager.addDocument('id', 'ada gak motor', 'availability.query');

  manager.addAnswer('id', 'availability.query', 'Cek ketersediaan dulu ya. Saya cari motor yang tersedia...');

  // BOOKING intents (user wants to make a booking)
  manager.addDocument('id', 'mau booking tanggal 12/01', 'booking.request');
  manager.addDocument('id', 'saya mau pesan motor tanggal 12/01 jam 07:00', 'booking.request');
  manager.addDocument('id', 'booking tanggal 2026-01-12 jam 10', 'booking.request');
  manager.addDocument('id', 'mau boking tgl 12/01', 'booking.request');
  manager.addDocument('id', 'pesan motor', 'booking.request');
  manager.addDocument('id', 'ingin sewa motor besok', 'booking.request');

  manager.addAnswer('id', 'booking.request', 'Baik, untuk membuat booking silakan isi form berikut:\n\nIsi form dlu ka\njenis motor:\ntgl antar :\njam Antar :\nLokasi Antar :\ntgl ambil:\njam Ambil:\nLokasi Ambil:\nNama:\nDomisili:\n\nKirim balasan lengkap seperti format di atas.');

  // FORM PROVIDE: user fills the labeled multiline form (we treat as intent when they submit)
  manager.addDocument('id', 'jenis motor', 'form.provide');
  manager.addDocument('id', 'tgl antar', 'form.provide');
  manager.addDocument('id', 'jam antar', 'form.provide');
  manager.addDocument('id', 'lokasi antar', 'form.provide');
  manager.addDocument('id', 'tgl ambil', 'form.provide');
  manager.addDocument('id', 'jam ambil', 'form.provide');
  manager.addDocument('id', 'lokasi ambil', 'form.provide');
  manager.addDocument('id', 'nama', 'form.provide');
  manager.addDocument('id', 'domisili', 'form.provide');

  // Short guidance responses
  manager.addAnswer('id', 'form.provide', 'Terima kasih, data diterima. Saya akan memvalidasi isian dulu.');

  // CONFIRMATION
  manager.addDocument('id', 'ya', 'confirm.yes');
  manager.addDocument('id', 'iya', 'confirm.yes');
  manager.addDocument('id', 'yes', 'confirm.yes');
  manager.addAnswer('id', 'confirm.yes', 'Terima kasih.');

  manager.addDocument('id', 'tidak', 'confirm.no');
  manager.addDocument('id', 'gak', 'confirm.no');
  manager.addAnswer('id', 'confirm.no', 'Baik, dibatalkan.');

  // IDENTITY & DOCUMENTS
  manager.addDocument('id', 'saya kirim foto ktp', 'identity.provide');
  manager.addDocument('id', 'kirim foto ktp', 'identity.provide');
  manager.addDocument('id', 'saya kirim npwp', 'identity.provide');
  manager.addDocument('id', 'kirim kk', 'identity.provide');
  manager.addAnswer('id', 'identity.provide', 'Silakan kirim foto KTP dan jaminan (NPWP/KK/kartu nama).');

  // ADMIN / CONTROL intents (optional)
  manager.addDocument('id', '/admin login', 'admin.login');
  manager.addDocument('id', '/admin list', 'admin.list');
  manager.addAnswer('id', 'admin.login', 'Perintah login admin dikenali.');

  // List motors intent (will be handled by server to query DB)
  manager.addDocument('id', 'list motor', 'list.motors');
  manager.addDocument('id', 'daftar motor', 'list.motors');
  manager.addDocument('id', 'motor apa saja', 'list.motors');
  manager.addDocument('id', 'daftar kendaraan', 'list.motors');
  manager.addDocument('id', 'list kendaraan', 'list.motors');
  manager.addDocument('id', 'list motor apa saja', 'list.motors');
  manager.addAnswer('id', 'list.motors', 'Mencari daftar motor...');

  // FALLBACK handled by manager automatically; we also add a friendly reply
  manager.addAnswer('id', 'None', 'Maaf, saya tidak mengerti. Bisa ulangi dengan kata lain?');

  console.log('Training NLP model with intents...');
  await manager.train();
  console.log('Training finished. Saving model to', MODEL_PATH);

  // ensure data directory exists
  const dataDir = path.dirname(MODEL_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  await manager.save(MODEL_PATH);
  console.log('Model saved. Test examples:');

  const tests = [
    'halo',
    'apa ada motor ready',
    'mau booking tanggal 12/01',
    'saya kirim foto ktp',
    'makasih'
  ];
  for (const t of tests) {
    const resp = await manager.process('id', t);
    console.log('>', t, '=>', resp.intent, resp.score, resp.answer || (resp.answers && resp.answers[0] && resp.answers[0].answer));
  }
}

train().catch(err => {
  console.error('Training failed', err);
  process.exit(1);
});
