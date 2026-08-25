const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_KONTAK = () => path.join(app.getPath('userData'), 'kontak-manual.json');
const FILE_GRUP_PELANGGAN = () => path.join(app.getPath('userData'), 'grup-pelanggan.json');

function muatSemua() {
    const file = FILE_KONTAK();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function simpanSemua(daftar) {
    fs.writeFileSync(FILE_KONTAK(), JSON.stringify(daftar, null, 2));
}

/** Grup untuk pelanggan yang berasal dari database POS (id angka) — disimpan terpisah,
 * dipetakan berdasarkan id pelanggan, supaya owner bisa mengelompokkan bebas (dalam/luar
 * kota, pelanggan baru/lama, sering/jarang pesan, dll) tanpa mengubah data di POS. */
function muatGrupPelanggan() {
    const file = FILE_GRUP_PELANGGAN();
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function setGrupPelangganBanyak(idPelangganList, grup) {
    const peta = muatGrupPelanggan();
    idPelangganList.forEach((id) => { peta[id] = grup; });
    fs.writeFileSync(FILE_GRUP_PELANGGAN(), JSON.stringify(peta, null, 2));
    return peta;
}

function tambah({ nama, telepon, grup }) {
    const daftar = muatSemua();
    const kontak = {
        id: 'manual-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        nama,
        telepon: telepon.replace(/\D/g, ''),
        grup: grup || 'Tanpa Grup',
        sumber: 'manual',
    };
    daftar.push(kontak);
    simpanSemua(daftar);
    return kontak;
}

/** Tambah banyak kontak sekaligus (dari import Excel) — 1x tulis file, bukan per baris. */
function tambahBanyak(daftarBaru) {
    const daftar = muatSemua();
    const ditambahkan = daftarBaru.map((k, i) => ({
        id: 'manual-' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 1000),
        nama: k.nama,
        telepon: k.telepon.replace(/\D/g, ''),
        grup: k.grup || 'Tanpa Grup',
        sumber: 'manual',
    }));
    simpanSemua([...daftar, ...ditambahkan]);
    return ditambahkan;
}

function hapus(id) {
    const daftar = muatSemua().filter((k) => k.id !== id);
    simpanSemua(daftar);
}

function daftarGrup() {
    const daftar = muatSemua();
    return [...new Set(daftar.map((k) => k.grup))];
}

module.exports = { muatSemua, tambah, tambahBanyak, hapus, daftarGrup, muatGrupPelanggan, setGrupPelangganBanyak };
