const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_ATURAN = () => path.join(app.getPath('userData'), 'follow-up-aturan.json');
const FILE_RIWAYAT = () => path.join(app.getPath('userData'), 'follow-up-riwayat.json');

function muatAturan() {
    const file = FILE_ATURAN();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function simpanAturan(daftar) {
    fs.writeFileSync(FILE_ATURAN(), JSON.stringify(daftar, null, 2));
    return daftar;
}

function tambahAturan({ nama, grup, template, intervalHari }) {
    const daftar = muatAturan();
    const aturan = { id: 'fu-' + Date.now(), nama, grup, template, intervalHari: Number(intervalHari), aktif: true };
    daftar.push(aturan);
    simpanAturan(daftar);
    return aturan;
}

function hapusAturan(id) {
    simpanAturan(muatAturan().filter((a) => a.id !== id));
}

function setAktif(id, aktif) {
    const daftar = muatAturan();
    const a = daftar.find((x) => x.id === id);
    if (a) a.aktif = aktif;
    simpanAturan(daftar);
}

function muatRiwayatFollowUp() {
    const file = FILE_RIWAYAT();
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function catatFollowUp(kontakId) {
    const riwayat = muatRiwayatFollowUp();
    riwayat[kontakId] = new Date().toISOString();
    fs.writeFileSync(FILE_RIWAYAT(), JSON.stringify(riwayat, null, 2));
}

/** Kontak dianggap perlu di-follow-up kalau belum PERNAH di-follow-up sama sekali, atau sudah
 * lewat "intervalHari" sejak follow-up terakhir ke kontak itu. */
function perluFollowUp(kontakId, intervalHari, riwayat) {
    const terakhir = riwayat[kontakId];
    if (!terakhir) return true;
    const hariBerlalu = (Date.now() - new Date(terakhir).getTime()) / (1000 * 60 * 60 * 24);
    return hariBerlalu >= intervalHari;
}

module.exports = { muatAturan, simpanAturan, tambahAturan, hapusAturan, setAktif, muatRiwayatFollowUp, catatFollowUp, perluFollowUp };
