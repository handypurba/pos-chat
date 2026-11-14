const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const QRCode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const autoreply = require('./autoreply');
const janganKirim = require('./janganKirim');
const { normalisasiNomor } = require('./nomor');

// Simpan di folder data aplikasi (userData), BUKAN di folder instalasi (__dirname) — supaya
// sesi WhatsApp yang sudah di-scan tidak ikut hilang/tertimpa saat aplikasi di-update/instal ulang.
const AUTH_DIR = path.join(app.getPath('userData'), 'sesi-wa-broadcast');

let sock = null;
let statusSaatIni = 'terputus';
let listeners = { qr: null, status: null, nomor: null, pesanMasuk: null, statusPesan: null, janganKirimBerubah: null };
// Tiap pengiriman punya penanda "berhenti" SENDIRI (bukan 1 bendera bersama) supaya pengiriman baru
// (mis. job invoice otomatis) tidak membatalkan tombol Hentikan yang baru saja ditekan.
const lariAktif = new Set();
let koneksiGagalBerturut = 0;
let sedangMenyambung = false;

// --- Batas pengaman (dikunci di mesin, tidak bisa dilewati lewat layar maupun job dari server) ---
const JEDA_LANTAI_DETIK = 15;            // jeda antar pesan tidak boleh lebih cepat dari ini
const JEDA_GLOBAL_MS = 10 * 1000;        // jarak minimum antar 2 pengiriman APA PUN (manual/follow-up/job/invoice)
const BATAS_HARIAN_BAWAAN = 150;
const BATAS_HARIAN_MAKS = 300;
const COOLDOWN_AUTOREPLY_MS = 6 * 60 * 60 * 1000; // 1 kontak maksimal dibalas auto-reply tiap 6 jam
const balasanTerakhir = new Map();

// --- Pelacakan status pesan setelah terkirim (sampai di HP penerima / dibaca) ---
// WhatsApp TIDAK memberi tahu langsung kalau nomor kita diblokir. Tandanya: pesan sudah diterima
// server WA (centang 1) tapi tidak pernah sampai ke HP penerima (centang 2). HP mati / tanpa
// internet / WA dihapus punya gejala SAMA, jadi hasilnya cuma "belum sampai" (diduga), bukan vonis.
const BATAS_BELUM_SAMPAI_MS = 15 * 60 * 1000;
const MAKS_PESAN_DIPANTAU = 800;
const pesanDipantau = new Map(); // idPesanWa -> { id, nama, telepon, tingkat, timer }
const TINGKAT = { terkirim: 1, belum_sampai: 2, sampai: 3, dibaca: 4 };

function laporStatusPesan(entri, status) {
    if ((TINGKAT[status] || 0) <= entri.tingkat) return;
    entri.tingkat = TINGKAT[status];
    if (entri.timer && status !== 'belum_sampai') clearTimeout(entri.timer);
    listeners.statusPesan?.({ id: entri.id, nama: entri.nama, telepon: entri.telepon, status, idPesan: entri.idPesan });
}

function pantauPesan(idPesan, penerima) {
    if (pesanDipantau.size >= MAKS_PESAN_DIPANTAU) {
        const tertua = pesanDipantau.keys().next().value;
        clearTimeout(pesanDipantau.get(tertua)?.timer);
        pesanDipantau.delete(tertua);
    }
    const entri = { id: penerima.id, nama: penerima.nama, telepon: penerima.telepon, idPesan, tingkat: TINGKAT.terkirim, timer: null };
    entri.timer = setTimeout(() => laporStatusPesan(entri, 'belum_sampai'), BATAS_BELUM_SAMPAI_MS);
    pesanDipantau.set(idPesan, entri);
}

function tingkatDariAck(status) {
    const angka = typeof status === 'string' ? { DELIVERY_ACK: 3, READ: 4, PLAYED: 5 }[status] : status;
    if (angka >= 4) return 'dibaca';
    if (angka === 3) return 'sampai';
    return null;
}

function tunda(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jeda acak TIDAK rata (bukan flat uniform) — dirata-ratakan dari 3 sampel acak supaya
 * bentuk sebarannya menyerupai pola longgar manusia (sering di tengah, sesekali ekstrim),
 * bukan pola matematis rata yang justru gampang dikenali sebagai bot. */
function jedaAcak(minDetik, maksDetik) {
    const acakHalus = (Math.random() + Math.random() + Math.random()) / 3;
    const ms = (minDetik + acakHalus * (maksDetik - minDetik)) * 1000;
    return tunda(ms);
}

/** Acak angka bulat di rentang [min, maks] — dipakai untuk mengacak titik "istirahat
 * panjang" supaya tidak selalu jatuh di kelipatan tetap (mis. selalu pesan ke-20, ke-40, dst)
 * yang gampang dikenali sebagai pola robot. */
function acakBulat(min, maks) {
    return Math.floor(min + Math.random() * (maks - min + 1));
}

/** Tunda yang bisa dipotong tombol Hentikan (dicek tiap 1 detik) — dulu istirahat panjang
 * sampai 10 menit tidak bisa dihentikan. */
async function tundaBisaDihentikan(ms, lari) {
    const batas = Date.now() + ms;
    while (Date.now() < batas) {
        if (lari.berhenti) return;
        await tunda(Math.min(1000, batas - Date.now()));
    }
}

async function jedaAcakBisaDihentikan(minDetik, maksDetik, lari) {
    const acakHalus = (Math.random() + Math.random() + Math.random()) / 3;
    await tundaBisaDihentikan((minDetik + acakHalus * (maksDetik - minDetik)) * 1000, lari);
}

// Antrean GLOBAL: semua pengiriman (broadcast manual, follow-up, job server, invoice) lewat sini
// satu per satu dengan jarak minimum, jadi laju gabungan tidak pernah melebihi batas walau
// beberapa pengiriman jalan bersamaan.
let rantaiGiliran = Promise.resolve();
let terakhirKirimMs = 0;
async function denganGiliranKirim(fn) {
    const sebelumnya = rantaiGiliran;
    let lepas;
    rantaiGiliran = new Promise((resolve) => { lepas = resolve; });
    await sebelumnya;
    try {
        const tunggu = terakhirKirimMs + JEDA_GLOBAL_MS - Date.now();
        if (tunggu > 0) await tunda(tunggu);
        return await fn();
    } finally {
        terakhirKirimMs = Date.now();
        lepas();
    }
}

// --- Hitungan terkirim per hari (lintas semua jalur pengiriman) ---
const FILE_HITUNG_HARIAN = () => path.join(app.getPath('userData'), 'hitung-harian-broadcast.json');

function tanggalHariIni() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function jumlahTerkirimHariIni() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE_HITUNG_HARIAN(), 'utf-8'));
        return data.tanggal === tanggalHariIni() ? Number(data.jumlah) || 0 : 0;
    } catch {
        return 0;
    }
}

function catatTerkirimHariIni() {
    try {
        fs.writeFileSync(FILE_HITUNG_HARIAN(), JSON.stringify({ tanggal: tanggalHariIni(), jumlah: jumlahTerkirimHariIni() + 1 }));
    } catch {
        // gagal mencatat tidak boleh menghentikan pengiriman
    }
}

/** Kunci semua opsi jeda ke batas aman — dipakai untuk apa pun yang masuk (layar, follow-up, job
 * dari server), jadi nilai ekstrem (jeda 1 detik, tanpa istirahat, batas harian tak terbatas)
 * otomatis dikoreksi. */
function amankanOpsi(opsi, jumlahPenerima) {
    const o = opsi || {};
    const massal = jumlahPenerima > 1;

    const jedaMinDetik = Math.max(JEDA_LANTAI_DETIK, Number(o.jedaMinDetik) || 30);
    const jedaMaksDetik = Math.max(jedaMinDetik + 10, Number(o.jedaMaksDetik) || 90);

    let jedaBatchSetelah = Math.max(0, Math.round(Number(o.jedaBatchSetelah) || 0));
    if (jumlahPenerima > 10) jedaBatchSetelah = Math.min(40, Math.max(10, jedaBatchSetelah || 20));
    if (!massal) jedaBatchSetelah = 0;
    const jedaBatchMinMenit = Math.max(3, Number(o.jedaBatchMinMenit) || 5);
    const jedaBatchMaksMenit = Math.max(jedaBatchMinMenit + 2, Number(o.jedaBatchMaksMenit) || 10);

    let batasHarian = Math.round(Number(o.batasHarian));
    if (!Number.isFinite(batasHarian) || batasHarian < 1) batasHarian = BATAS_HARIAN_BAWAAN;
    batasHarian = Math.min(BATAS_HARIAN_MAKS, batasHarian);

    return {
        jedaMinDetik, jedaMaksDetik, jedaBatchSetelah, jedaBatchMinMenit, jedaBatchMaksMenit,
        batasHarian: massal ? batasHarian : 0,
        simulasiMengetik: o.simulasiMengetik || { aktif: true, kecepatan: 'sedang' },
    };
}

/** Jadwalkan sambung ulang SEKALI (jangan numpuk kalau dipanggil berkali-kali). */
function sambungUlang(tungguMs) {
    if (sedangMenyambung) return;
    sedangMenyambung = true;
    setTimeout(() => {
        sedangMenyambung = false;
        mulaiKoneksi().catch(() => sambungUlang(30000));
    }, tungguMs);
}

async function mulaiKoneksi() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        // Bawaan library menandai nomor "online" tiap tersambung — pola aktivitas tidak wajar dan
        // notifikasi di HP nomor ini ikut mati. Dimatikan.
        markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const dataUrl = await QRCode.toDataURL(qr);
            statusSaatIni = 'menunggu-scan';
            listeners.status?.(statusSaatIni);
            listeners.qr?.(dataUrl);
        }

        if (connection === 'open') {
            koneksiGagalBerturut = 0;
            statusSaatIni = 'terhubung';
            listeners.status?.(statusSaatIni);
            const nomor = sock.user?.id?.split(':')[0]?.split('@')[0];
            listeners.nomor?.(nomor || null);
        }

        if (connection === 'close') {
            const alasan = lastDisconnect?.error?.output?.statusCode;
            statusSaatIni = 'terputus';
            listeners.status?.(statusSaatIni);

            if (alasan === DisconnectReason.loggedOut) return;

            // Sesi diambil alih perangkat/aplikasi lain: JANGAN rebutan balik (konek-putus
            // bergantian seperti itu terbaca sebagai perilaku tidak wajar oleh WhatsApp).
            if (alasan === DisconnectReason.connectionReplaced) {
                statusSaatIni = 'sesi-digantikan';
                listeners.status?.(statusSaatIni);
                return;
            }

            // Wajar terjadi sesaat setelah scan QR — sambung ulang langsung.
            if (alasan === DisconnectReason.restartRequired) {
                koneksiGagalBerturut = 0;
                sambungUlang(500);
                return;
            }

            koneksiGagalBerturut++;
            const tunggu = Math.min(60000, 2000 * 2 ** (koneksiGagalBerturut - 1)) + acakBulat(0, 1500);
            sambungUlang(tunggu);
        }
    });

    sock.ev.on('messages.update', (daftarUpdate) => {
        for (const { key, update } of daftarUpdate) {
            if (!key?.fromMe || update?.status === undefined) continue;
            const entri = pesanDipantau.get(key.id);
            const status = tingkatDariAck(update.status);
            if (entri && status) laporStatusPesan(entri, status);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const pesan of messages) {
            if (pesan.key.fromMe) continue;
            const jid = pesan.key.remoteJid;
            if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

            const teks = pesan.message?.conversation || pesan.message?.extendedTextMessage?.text || '';
            listeners.pesanMasuk?.({ dari: jid, teks });

            const jidNomor = pesan.key.remoteJidAlt || jid;
            const nomor = jidNomor.endsWith('@s.whatsapp.net') ? jidNomor.split('@')[0] : null;

            // Penerima minta berhenti -> masuk daftar "jangan kirim" dan TIDAK dibalas apa pun.
            if (janganKirim.teksMintaBerhenti(teks)) {
                if (nomor && janganKirim.tambah(nomor, 'minta_berhenti', pesan.pushName || '')) {
                    listeners.janganKirimBerubah?.({ nomor, nama: pesan.pushName || '' });
                }
                continue;
            }
            if (nomor && janganKirim.ada(nomor)) continue;

            const konfig = autoreply.muat();
            if (!konfig.aktif) continue;

            // 1 kontak maksimal dibalas sekali per 6 jam — cegah berbalas-balasan dengan bot lain
            // dan pola "membalas semua pesan" yang terbaca spam.
            if (Date.now() - (balasanTerakhir.get(jid) || 0) < COOLDOWN_AUTOREPLY_MS) continue;

            const balasan = autoreply.cariBalasan(konfig, teks);
            if (balasan) {
                balasanTerakhir.set(jid, Date.now());
                try {
                    await sock.presenceSubscribe(jid);
                    await sock.sendPresenceUpdate('composing', jid);
                    await tunda(acakBulat(1200, 3000));
                    await sock.sendPresenceUpdate('paused', jid);
                    await sock.sendMessage(jid, { text: balasan });
                } catch {
                    // gagal auto-reply (jarang) — tidak menghentikan proses lain
                }
            }
        }
    });
}

function daftarkanListener({ onQr, onStatus, onNomor, onPesanMasuk, onStatusPesan, onJanganKirimBerubah }) {
    listeners.qr = onQr;
    listeners.status = onStatus;
    listeners.nomor = onNomor;
    listeners.pesanMasuk = onPesanMasuk;
    listeners.statusPesan = onStatusPesan;
    listeners.janganKirimBerubah = onJanganKirimBerubah;
}

function statusKoneksi() {
    return statusSaatIni;
}

function nomorTerhubung() {
    return sock?.user?.id?.split(':')[0]?.split('@')[0] || null;
}

function minta_berhenti() {
    lariAktif.forEach((lari) => { lari.berhenti = true; });
}

/** Logout manual dari aplikasi — putuskan nomor WA dari perangkat ini (sesi terhapus),
 * supaya bisa scan QR nomor lain kalau perlu. */
async function logout() {
    if (sock) {
        try {
            await sock.logout();
        } catch {
            // kalau logout gagal (mis. sudah terputus duluan), tetap lanjut bersihkan sesi lokal
        }
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    statusSaatIni = 'terputus';
    listeners.status?.(statusSaatIni);
    listeners.nomor?.(null);
    koneksiGagalBerturut = 0;
    mulaiKoneksi().catch(() => sambungUlang(30000));
}

/** Pecahkan variasi pesan {opsi1|opsi2|opsi3} secara acak — supaya isi pesan tidak identik
 * 100% ke semua penerima (mengurangi pola yang terlihat seperti bot/spam). Cuma memproses
 * kurung kurawal yang ADA tanda "|" di dalamnya, jadi {nama} (placeholder nama) tidak ikut
 * kena proses ini. */
function acakVariasi(teks) {
    return teks.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opsi) => {
        const pilihan = opsi.split('|');
        return pilihan[Math.floor(Math.random() * pilihan.length)];
    });
}

function susunPesan(template, nama) {
    return acakVariasi(template).replace(/\{nama\}/g, nama);
}

/** Cek nomor terdaftar di WhatsApp atau tidak, SEBELUM kirim — supaya bisa dibedakan dari
 * gagal kirim biasa (jaringan dll). */
async function cekTerdaftarWa(nomorDigit) {
    const hasil = await sock.onWhatsApp(nomorDigit);
    return hasil?.[0]?.exists === true ? hasil[0].jid : null;
}

/** Cek apakah jam sekarang (waktu lokal komputer) ada di dalam rentang jam operasional. */
function dalamJamOperasional(jamMulai, jamSelesai) {
    const sekarang = new Date();
    const menitSekarang = sekarang.getHours() * 60 + sekarang.getMinutes();
    const [jamM, menitM] = jamMulai.split(':').map(Number);
    const [jamS, menitS] = jamSelesai.split(':').map(Number);
    const menitMulai = jamM * 60 + menitM;
    const menitSelesai = jamS * 60 + menitS;
    return menitSekarang >= menitMulai && menitSekarang < menitSelesai;
}

/** Kalau di luar jam operasional, tunggu sampai masuk jam operasional lagi — dicek tiap 1
 * menit (bukan 1 kali tunggu panjang) supaya tombol Hentikan tetap responsif dan status di
 * layar bisa diperbarui berkala. */
async function tungguJamOperasional(jamOperasional, onLog, lari) {
    if (!jamOperasional?.aktif) return;

    while (!dalamJamOperasional(jamOperasional.mulai, jamOperasional.selesai)) {
        if (lari.berhenti) return;
        onLog({ status: 'menunggu_jam_operasional', mulai: jamOperasional.mulai, selesai: jamOperasional.selesai });
        await tundaBisaDihentikan(60000, lari);
    }
}

/** Kalau koneksi WhatsApp putus di tengah kampanye, TUNGGU sampai tersambung lagi (maksimal 30
 * menit) — jangan menandai sisa penerima "gagal". */
async function tungguTerhubung(lari, onLog) {
    const mulai = Date.now();
    while (statusSaatIni !== 'terhubung') {
        if (lari.berhenti) return false;
        if (Date.now() - mulai > 30 * 60 * 1000) return false;
        onLog({ status: 'menunggu_koneksi' });
        await tundaBisaDihentikan(15000, lari);
    }
    return true;
}

function buatIsiLampiran(lampiran, caption) {
    const buffer = fs.readFileSync(lampiran.path);
    if (lampiran.tipe === 'image') return { image: buffer, caption };
    if (lampiran.tipe === 'video') return { video: buffer, caption };
    return { document: buffer, mimetype: lampiran.mimeType || 'application/pdf', fileName: lampiran.namaFile, caption };
}

/**
 * Kirim ke daftar nomor satu-satu dengan jeda acak antar pesan + jeda panjang tiap sekian
 * pesan (anti-ban dasar — bukan jaminan aman, cuma mengurangi risiko pola pengiriman yang
 * terlihat seperti bot). Status per nomor: dicek → terkirim | tidak_terdaftar | gagal.
 */
// Karakter per detik tiap pilihan kecepatan (rentang acak per pesan). Ketikan manusia nyata
// ~3-6 karakter/detik; pesan panjang dibatasi 40 detik supaya broadcast tidak berjam-jam.
const KECEPATAN_MENGETIK = {
    lambat: [2.5, 4],
    sedang: [4, 7],
    cepat: [7, 12],
};

/** Meniru orang mengetik di WA: "membuka" chat sebentar, lalu "mengetik" selama waktu yang
 * sebanding panjang pesan, dengan 0-2 kali berhenti sejenak di tengah (seperti orang mikir). */
async function jalankanSimulasiMengetik(jid, panjangTeks, kecepatan) {
    const [cpsMin, cpsMaks] = KECEPATAN_MENGETIK[kecepatan] || KECEPATAN_MENGETIK.sedang;
    const cps = cpsMin + Math.random() * (cpsMaks - cpsMin);
    const totalMs = Math.min(40000, Math.max(1500, Math.round((panjangTeks / cps) * 1000)));
    const jumlahBerhenti = totalMs > 6000 ? acakBulat(0, 2) : 0;
    const potongan = jumlahBerhenti + 1;

    await sock.presenceSubscribe(jid);
    await tunda(acakBulat(800, 2500));
    for (let k = 0; k < potongan; k++) {
        await sock.sendPresenceUpdate('composing', jid);
        await tunda(Math.round(totalMs / potongan));
        await sock.sendPresenceUpdate('paused', jid);
        if (k < potongan - 1) await tunda(acakBulat(1000, 3000));
    }
}

async function kirimBroadcast(daftarPenerima, templatePesan, opsiJeda, lampiran, onLog, jamOperasional) {
    if (statusSaatIni !== 'terhubung') {
        throw new Error('WhatsApp belum terhubung. Scan QR dulu.');
    }

    const opsi = amankanOpsi(opsiJeda, daftarPenerima.length);
    const { jedaMinDetik, jedaMaksDetik, jedaBatchSetelah, jedaBatchMinMenit, jedaBatchMaksMenit, batasHarian, simulasiMengetik } = opsi;

    const lari = { berhenti: false };
    lariAktif.add(lari);

    // titik istirahat panjang berikutnya diacak ±30% dari angka yang diisi, supaya tidak
    // selalu jatuh di kelipatan tetap (pola robot) — dihitung ulang tiap kali lewat 1 siklus.
    let pesanTerkirimSejakIstirahat = 0;
    const acakTargetIstirahat = () => acakBulat(Math.max(1, Math.round(jedaBatchSetelah * 0.7)), Math.round(jedaBatchSetelah * 1.3));
    let targetIstirahatBerikutnya = jedaBatchSetelah > 0 ? acakTargetIstirahat() : 0;

    const sudahDiproses = new Set();
    const percobaanKoneksi = {};
    let jedaMenunggu = null; // 'biasa' | 'panjang' | 'singkat' — dijalankan SEBELUM aksi jaringan berikutnya
    let berakhirDini = false;

    try {
        for (let i = 0; i < daftarPenerima.length; i++) {
            if (lari.berhenti) { onLog({ status: 'dihentikan' }); berakhirDini = true; break; }

            const p = daftarPenerima[i];
            const info = { id: p.id, nama: p.nama, telepon: p.telepon };

            // --- penyaringan lokal (tidak menyentuh WhatsApp, tidak butuh jeda) ---
            const nomorDigit = normalisasiNomor(p.telepon);
            if (!nomorDigit) {
                onLog({ ...info, status: 'gagal', pesanError: 'Format nomor tidak valid' });
                continue;
            }
            if (sudahDiproses.has(nomorDigit)) {
                onLog({ ...info, status: 'dilewati', pesanError: 'Nomor ganda di daftar ini, hanya dikirim sekali' });
                continue;
            }
            sudahDiproses.add(nomorDigit);
            if (janganKirim.ada(nomorDigit)) {
                onLog({ ...info, status: 'dilewati', pesanError: 'Ada di daftar jangan kirim' });
                continue;
            }

            // --- jeda dari aksi jaringan sebelumnya ---
            if (jedaMenunggu === 'panjang') {
                onLog({ status: 'jeda_panjang', menit: jedaBatchMinMenit });
                await jedaAcakBisaDihentikan(jedaBatchMinMenit * 60, jedaBatchMaksMenit * 60, lari);
                pesanTerkirimSejakIstirahat = 0;
                targetIstirahatBerikutnya = acakTargetIstirahat();
            } else if (jedaMenunggu === 'biasa') {
                await jedaAcakBisaDihentikan(jedaMinDetik, jedaMaksDetik, lari);
            } else if (jedaMenunggu === 'singkat') {
                await jedaAcakBisaDihentikan(4, 10, lari);
            }
            jedaMenunggu = null;

            if (lari.berhenti) { onLog({ status: 'dihentikan' }); berakhirDini = true; break; }
            await tungguJamOperasional(jamOperasional, onLog, lari);
            if (lari.berhenti) { onLog({ status: 'dihentikan' }); berakhirDini = true; break; }

            if (!(await tungguTerhubung(lari, onLog))) {
                onLog({ status: 'dihentikan', alasan: lari.berhenti ? '' : 'Koneksi WhatsApp terputus terlalu lama, pengiriman dihentikan.' });
                berakhirDini = true;
                break;
            }

            if (batasHarian > 0 && jumlahTerkirimHariIni() >= batasHarian) {
                onLog({ status: 'batas_harian', batas: batasHarian });
                berakhirDini = true;
                break;
            }

            onLog({ ...info, status: 'memeriksa' });

            let tahap = 'cek';
            try {
                const jid = await cekTerdaftarWa(nomorDigit);
                if (!jid) {
                    onLog({ ...info, status: 'tidak_terdaftar' });
                    jedaMenunggu = 'singkat';
                    continue;
                }

                tahap = 'kirim';
                const pesan = susunPesan(templatePesan, p.nama);
                const isi = lampiran ? buatIsiLampiran(lampiran, pesan) : { text: pesan };

                // Antrean global: simulasi mengetik + kirim berlangsung satu pengiriman pada satu waktu.
                const hasilKirim = await denganGiliranKirim(async () => {
                    if (simulasiMengetik.aktif) {
                        try {
                            await jalankanSimulasiMengetik(jid, pesan.length, simulasiMengetik.kecepatan);
                        } catch {
                            // gagal kirim status "mengetik" (jarang), lanjut kirim pesan seperti biasa
                        }
                    }
                    return sock.sendMessage(jid, isi);
                });

                const idPesan = hasilKirim?.key?.id;
                if (idPesan) pantauPesan(idPesan, p);
                catatTerkirimHariIni();
                onLog({ ...info, status: 'terkirim', idPesan });
                pesanTerkirimSejakIstirahat++;

                const masihAda = i < daftarPenerima.length - 1;
                if (masihAda) {
                    jedaMenunggu = jedaBatchSetelah > 0 && pesanTerkirimSejakIstirahat >= targetIstirahatBerikutnya ? 'panjang' : 'biasa';
                }
            } catch (err) {
                // Putus di tahap CEK (belum ada pesan yang dikirim) -> ulangi penerima yang sama setelah
                // tersambung. Putus di tahap KIRIM tidak diulang (bisa terlanjur terkirim -> dobel).
                if (tahap === 'cek' && statusSaatIni !== 'terhubung' && (percobaanKoneksi[i] = (percobaanKoneksi[i] || 0) + 1) <= 3) {
                    sudahDiproses.delete(nomorDigit);
                    i--;
                    continue;
                }
                onLog({ ...info, status: 'gagal', pesanError: err.message });
                jedaMenunggu = 'biasa';
            }
        }
    } finally {
        lariAktif.delete(lari);
    }

    if (!berakhirDini) onLog({ status: 'selesai' });
}

module.exports = {
    mulaiKoneksi, daftarkanListener, statusKoneksi, nomorTerhubung, kirimBroadcast, minta_berhenti, logout,
    jumlahTerkirimHariIni, BATAS_HARIAN_BAWAAN, BATAS_HARIAN_MAKS, JEDA_LANTAI_DETIK,
};
