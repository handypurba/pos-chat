const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_RIWAYAT = () => path.join(app.getPath('userData'), 'riwayat-broadcast.json');
const MAKSIMAL_DISIMPAN = 100;

function muatSemua() {
    const file = FILE_RIWAYAT();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

/** Simpan 1 kampanye yang baru selesai (dipanggil sekali di akhir kirimBroadcast). */
function simpanKampanye({ template, hasil }) {
    const daftar = muatSemua();
    const ringkasan = { terkirim: 0, gagal: 0, tidak_terdaftar: 0 };
    hasil.forEach((h) => { if (ringkasan[h.status] !== undefined) ringkasan[h.status]++; });

    const kampanye = {
        id: 'kampanye-' + Date.now(),
        waktu: new Date().toISOString(),
        template,
        ringkasan,
        hasil,
    };

    daftar.unshift(kampanye);
    fs.writeFileSync(FILE_RIWAYAT(), JSON.stringify(daftar.slice(0, MAKSIMAL_DISIMPAN), null, 2));
    return kampanye;
}

module.exports = { muatSemua, simpanKampanye };
