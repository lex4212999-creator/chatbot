const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public')); // Untuk file HTML

app.post('/upload-ktp', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).send('Tidak ada file yang diunggah.');

    const inputPath = req.file.path;
    const outputPath = `uploads/processed_${req.file.filename}.png`;

    try {
        // 1. Penjernihan Gambar dengan Sharp
        await sharp(inputPath)
            .resize(1500)
            .grayscale()
            .threshold(125) // Sesuaikan jika terlalu terang/gelap
            .toFile(outputPath);

        // 2. Scan dengan Tesseract
        const { data: { text } } = await Tesseract.recognize(outputPath, 'ind');

        // 3. Regex untuk ambil data
        const nikMatch = text.match(/\d{16}/);
        const namaMatch = text.match(/Nama\s*[:\s]+([^\n]+)/i);

        // Hapus file setelah diproses
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);

        res.json({
            nik: nikMatch ? nikMatch[0] : "Tidak ditemukan",
            nama: namaMatch ? namaMatch[1].trim() : "Tidak ditemukan",
            raw: text
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('Server jalan di http://localhost:3000'));