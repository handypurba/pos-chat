const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_AUTOREPLY = () => path.join(app.getPath('userData'), 'auto-reply.json');

const DEFAULT_KONFIG = { aktif: false, aturan: [], balasanDefault: '' };

function muat() {
    const file = FILE_AUTOREPLY();
    if (!fs.existsSync(file)) return { ...DEFAULT_KONFIG };
    try {
        return { ...DEFAULT_KONFIG, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch {
        return { ...DEFAULT_KONFIG };
    }
}

function simpan(konfig) {
    fs.writeFileSync(FILE_AUTOREPLY(), JSON.stringify(konfig, null, 2));
    return konfig;
}

/** Cari balasan yang cocok berdasarkan kata kunci (dicari sebagai substring, tidak peka
 * huruf besar/kecil) pada pesan masuk. Kalau tidak ada yang cocok, pakai balasan default
 * (kalau diisi) — kalau balasan default kosong, tidak membalas sama sekali. */
function cariBalasan(konfig, teksPesanMasuk) {
    const teks = (teksPesanMasuk || '').toLowerCase();
    for (const aturan of konfig.aturan) {
        const kataKunciList = aturan.kataKunci.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (kataKunciList.some((k) => teks.includes(k))) {
            return aturan.balasan;
        }
    }
    return konfig.balasanDefault || null;
}

module.exports = { muat, simpan, cariBalasan };
