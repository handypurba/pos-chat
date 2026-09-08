const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_BALASAN_CEPAT = () => path.join(app.getPath('userData'), 'balasan-cepat.json');
const FILE_PENGINGAT = () => path.join(app.getPath('userData'), 'pengingat-followup.json');
const FILE_DND = () => path.join(app.getPath('userData'), 'jangan-ganggu.json');
const FILE_TAB_DIBUNGKAM = () => path.join(app.getPath('userData'), 'tab-dibungkam.json');
const FILE_PERANGKAT = () => path.join(app.getPath('userData'), 'nama-perangkat.json');

function bacaJson(file, bawaan) {
    if (!fs.existsSync(file)) return bawaan;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return bawaan;
    }
}

function tulisJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- Balasan cepat: teks siap-pakai buat di-copy manual ke WA Web/Shopee/Tokped, BUKAN
// dikirim otomatis (beda dari fitur Broadcast) — cocok buat jawaban yang sering diulang-ulang
// CS (mis. "Terima kasih sudah order, mohon tunggu konfirmasi ya kak"). ---
function muatBalasanCepat() {
    return bacaJson(FILE_BALASAN_CEPAT(), []);
}

function tambahBalasanCepat(teks) {
    const daftar = muatBalasanCepat();
    const item = { id: 'bc-' + Date.now(), teks };
    daftar.push(item);
    tulisJson(FILE_BALASAN_CEPAT(), daftar);
    return item;
}

function hapusBalasanCepat(id) {
    tulisJson(FILE_BALASAN_CEPAT(), muatBalasanCepat().filter((b) => b.id !== id));
}

// --- Pengingat follow-up: catatan manual per tab ("follow up jam 3 sore"), TIDAK baca isi
// chat sama sekali — murni pengingat waktu, dicek berkala oleh main.js lalu dimunculkan
// sebagai notifikasi begitu waktunya tiba. ---
function muatPengingat() {
    return bacaJson(FILE_PENGINGAT(), []);
}

function tambahPengingat({ workspaceId, workspaceNama, waktuIso, catatan }) {
    const daftar = muatPengingat();
    const item = { id: 'ing-' + Date.now(), workspaceId, workspaceNama, waktuIso, catatan: catatan || '', sudahDiingatkan: false };
    daftar.push(item);
    tulisJson(FILE_PENGINGAT(), daftar);
    return item;
}

function hapusPengingat(id) {
    tulisJson(FILE_PENGINGAT(), muatPengingat().filter((p) => p.id !== id));
}

/** Cari pengingat yang waktunya sudah lewat & belum sempat dimunculkan, tandai sekalian
 * supaya tidak diingatkan dobel kalau dicek lagi sebelum dihapus manual oleh user. */
function ambilPengingatJatuhTempo() {
    const daftar = muatPengingat();
    const sekarang = Date.now();
    const jatuhTempo = daftar.filter((p) => !p.sudahDiingatkan && new Date(p.waktuIso).getTime() <= sekarang);

    if (jatuhTempo.length > 0) {
        jatuhTempo.forEach((p) => { p.sudahDiingatkan = true; });
        tulisJson(FILE_PENGINGAT(), daftar);
    }

    return jatuhTempo;
}

// --- Mode Jangan Ganggu terjadwal: bungkam suara+toast notifikasi utk channel tertentu
// di luar jam kerja (mis. malam hari) — badge merah di sidebar TETAP muncul (biar tidak
// kelewat kalau dibuka manual), cuma suara/toast-nya yang dibungkam. ---
function muatDnd() {
    return bacaJson(FILE_DND(), { aktif: false, mulai: '20:00', selesai: '08:00', platformDibungkam: [] });
}

function simpanDnd(konfig) {
    tulisJson(FILE_DND(), konfig);
    return konfig;
}

/** Cek apakah SEKARANG termasuk jam bungkam untuk platform tertentu — dipanggil dari renderer
 * (sidebar.html) tiap ada notifikasi masuk, sebelum memutuskan bunyi suara/toast atau tidak. */
function dalamJamDnd(konfig, platform) {
    if (!konfig.aktif || !konfig.platformDibungkam.includes(platform)) return false;

    const sekarang = new Date();
    const menitSekarang = sekarang.getHours() * 60 + sekarang.getMinutes();
    const [jamM, menitM] = konfig.mulai.split(':').map(Number);
    const [jamS, menitS] = konfig.selesai.split(':').map(Number);
    const mulai = jamM * 60 + menitM;
    const selesai = jamS * 60 + menitS;

    // Rentang bisa melewati tengah malam (mis. 20:00-08:00) — kalau mulai > selesai, berarti
    // rentangnya "malam sampai besok pagi", jadi jam sekarang dianggap masuk kalau >= mulai ATAU < selesai.
    if (mulai > selesai) return menitSekarang >= mulai || menitSekarang < selesai;
    return menitSekarang >= mulai && menitSekarang < selesai;
}

// --- Bungkam suara/toast utk TAB TERTENTU, PERMANEN (bukan terjadwal per platform seperti
// Jangan Ganggu di atas) -- diminta owner 8 Sep 2026, mis. tab pribadi/personal yang tidak
// perlu bunyi tiap ada chat masuk, sementara tab jualan (Admin DLP/HF) tetap bunyi seperti
// biasa. Badge merah TETAP muncul (sama seperti Jangan Ganggu) -- cuma suara & toast-nya yang
// dibungkam, biar tidak kelewat kalau dibuka manual. Disimpan sebagai daftar id workspace. ---
function muatTabDibungkam() {
    return bacaJson(FILE_TAB_DIBUNGKAM(), []);
}

function simpanTabDibungkam(daftarId) {
    const bersih = Array.isArray(daftarId) ? daftarId.filter((id) => typeof id === 'string') : [];
    tulisJson(FILE_TAB_DIBUNGKAM(), bersih);
    return bersih;
}

// --- Lebar sidebar (daftar tab) bisa digeser user -- diminta owner 8 Sep 2026. Dibatasi
// 76-220px (jaga-jaga file konfigurasi rusak/nilai ekstrem, sama pola dengan
// muatJedaTabLeadsMenit()). ---
const FILE_LEBAR_SIDEBAR = () => path.join(app.getPath('userData'), 'lebar-sidebar.json');
const LEBAR_SIDEBAR_DEFAULT = 96;
const LEBAR_SIDEBAR_MIN = 76;
const LEBAR_SIDEBAR_MAX = 220;

function muatLebarSidebar() {
    const px = bacaJson(FILE_LEBAR_SIDEBAR(), { px: LEBAR_SIDEBAR_DEFAULT }).px;
    return Number.isFinite(px) && px >= LEBAR_SIDEBAR_MIN && px <= LEBAR_SIDEBAR_MAX ? px : LEBAR_SIDEBAR_DEFAULT;
}

function simpanLebarSidebar(px) {
    const bersih = Math.min(LEBAR_SIDEBAR_MAX, Math.max(LEBAR_SIDEBAR_MIN, Math.round(Number(px)) || LEBAR_SIDEBAR_DEFAULT));
    tulisJson(FILE_LEBAR_SIDEBAR(), { px: bersih });
    return bersih;
}

// --- Nama Perangkat: label bebas diisi manual sekali per laptop (mis. "Laptop Andhika"),
// dikirim tiap lapor status ke server (lihat laporStatusChatHub di main.js) supaya status
// koneksi & progres WA bisa dipisah per laptop di halaman Leads Hanmar POS -- perlu ini karena
// beberapa laptop bisa sama-sama punya tab dengan id sama (mis. sama-sama "whatsapp"). ---
function muatNamaPerangkat() {
    return bacaJson(FILE_PERANGKAT(), { nama: '' }).nama || '';
}

function simpanNamaPerangkat(nama) {
    const bersih = String(nama || '').trim().slice(0, 100);
    tulisJson(FILE_PERANGKAT(), { nama: bersih });
    return bersih;
}

// --- Jeda auto-buka tab Leads: diminta owner 7 Sep 2026 supaya bisa diubah dari aplikasi (tab
// Perangkat), tidak perlu build ulang tiap mau ganti angkanya. Dibaca ULANG tiap siklus (lihat
// jadwalkanBukaTabLeads di main.js, pola setTimeout rekursif bukan setInterval tetap) supaya
// perubahan langsung kepakai di siklus berikutnya, tidak perlu restart aplikasi. Default 5 menit,
// dibatasi 1-120 menit (jaga-jaga salah ketik, mis. ke-isi 0 atau angka ekstrem). ---
const FILE_JEDA_TAB_LEADS = () => path.join(app.getPath('userData'), 'jeda-tab-leads.json');
const JEDA_TAB_LEADS_MENIT_DEFAULT = 5;

function muatJedaTabLeadsMenit() {
    const menit = bacaJson(FILE_JEDA_TAB_LEADS(), { menit: JEDA_TAB_LEADS_MENIT_DEFAULT }).menit;
    return Number.isFinite(menit) && menit >= 1 && menit <= 120 ? menit : JEDA_TAB_LEADS_MENIT_DEFAULT;
}

function simpanJedaTabLeadsMenit(menit) {
    const bersih = Math.min(120, Math.max(1, Math.round(Number(menit)) || JEDA_TAB_LEADS_MENIT_DEFAULT));
    tulisJson(FILE_JEDA_TAB_LEADS(), { menit: bersih });
    return bersih;
}

module.exports = {
    muatBalasanCepat, tambahBalasanCepat, hapusBalasanCepat,
    muatPengingat, tambahPengingat, hapusPengingat, ambilPengingatJatuhTempo,
    muatDnd, simpanDnd, dalamJamDnd,
    muatTabDibungkam, simpanTabDibungkam,
    muatLebarSidebar, simpanLebarSidebar,
    muatNamaPerangkat, simpanNamaPerangkat,
    muatJedaTabLeadsMenit, simpanJedaTabLeadsMenit,
};
