const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { normalisasiNomor } = require('./nomor');

/**
 * Daftar "jangan kirim" untuk broadcast: nomor yang minta berhenti (membalas "stop"/"berhenti"),
 * atau yang sengaja dikeluarkan owner (mis. diduga memblokir, bukan nomor WA). Laporan spam dan
 * blokir dari penerima adalah pemicu banned terbesar, jadi nomor di daftar ini DILEWATI di semua
 * jalur pengiriman (manual, follow-up, job dari server).
 */
const FILE = () => path.join(app.getPath('userData'), 'jangan-kirim.json');

function muat() {
    const file = FILE();
    if (!fs.existsSync(file)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function simpan(daftar) {
    fs.writeFileSync(FILE(), JSON.stringify(daftar, null, 2));
}

function ada(nomor) {
    const n = normalisasiNomor(nomor);
    return !!n && muat().some((e) => e.nomor === n);
}

function tambah(nomor, alasan, nama = '') {
    const n = normalisasiNomor(nomor);
    if (!n) return false;
    const daftar = muat();
    if (daftar.some((e) => e.nomor === n)) return false;
    daftar.push({ nomor: n, nama, alasan, waktu: new Date().toISOString() });
    simpan(daftar);
    return true;
}

function hapus(nomor) {
    const n = normalisasiNomor(nomor);
    simpan(muat().filter((e) => e.nomor !== n));
}

/** Teks pesan masuk yang artinya "tolong berhenti kirim" — sengaja pendek-saja (<=80 karakter)
 * supaya kalimat panjang yang kebetulan memuat kata "stop" tidak salah ditandai. */
const POLA_BERHENTI = /\b(stop|berhenti|unsubscribe|unsub)\b|jangan\s+(di)?(kirim|chat|hubungi|spam)|(hapus|keluarkan)\s+(nomor|kontak|saya)|tidak\s+(usah|perlu)\s+(kirim|chat)/i;

function teksMintaBerhenti(teks) {
    const bersih = String(teks || '').trim();
    return bersih.length > 0 && bersih.length <= 80 && POLA_BERHENTI.test(bersih);
}

module.exports = { muat, ada, tambah, hapus, teksMintaBerhenti };
