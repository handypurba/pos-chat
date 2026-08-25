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

// Simpan di folder data aplikasi (userData), BUKAN di folder instalasi (__dirname) — supaya
// sesi WhatsApp yang sudah di-scan tidak ikut hilang/tertimpa saat aplikasi di-update/instal ulang.
const AUTH_DIR = path.join(app.getPath('userData'), 'sesi-wa-broadcast');

let sock = null;
let statusSaatIni = 'terputus';
let listeners = { qr: null, status: null, nomor: null, pesanMasuk: null };
let hentikanDiminta = false;

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

async function mulaiKoneksi() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
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
            statusSaatIni = 'terhubung';
            listeners.status?.(statusSaatIni);
            const nomor = sock.user?.id?.split(':')[0]?.split('@')[0];
            listeners.nomor?.(nomor || null);
        }

        if (connection === 'close') {
            const alasan = lastDisconnect?.error?.output?.statusCode;
            statusSaatIni = 'terputus';
            listeners.status?.(statusSaatIni);

            if (alasan !== DisconnectReason.loggedOut) {
                mulaiKoneksi();
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const pesan of messages) {
            if (pesan.key.fromMe) continue;
            if (pesan.key.remoteJid?.endsWith('@g.us')) continue; // lewati pesan grup

            const teks = pesan.message?.conversation || pesan.message?.extendedTextMessage?.text || '';
            listeners.pesanMasuk?.({ dari: pesan.key.remoteJid, teks });

            const konfig = autoreply.muat();
            if (!konfig.aktif) continue;

            const balasan = autoreply.cariBalasan(konfig, teks);
            if (balasan) {
                try {
                    await sock.presenceSubscribe(pesan.key.remoteJid);
                    await sock.sendPresenceUpdate('composing', pesan.key.remoteJid);
                    await tunda(acakBulat(1200, 3000));
                    await sock.sendPresenceUpdate('paused', pesan.key.remoteJid);
                    await sock.sendMessage(pesan.key.remoteJid, { text: balasan });
                } catch {
                    // gagal auto-reply (jarang) — tidak menghentikan proses lain
                }
            }
        }
    });
}

function daftarkanListener({ onQr, onStatus, onNomor, onPesanMasuk }) {
    listeners.qr = onQr;
    listeners.status = onStatus;
    listeners.nomor = onNomor;
    listeners.pesanMasuk = onPesanMasuk;
}

function statusKoneksi() {
    return statusSaatIni;
}

function nomorTerhubung() {
    return sock?.user?.id?.split(':')[0]?.split('@')[0] || null;
}

function minta_berhenti() {
    hentikanDiminta = true;
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
    mulaiKoneksi();
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
async function tungguJamOperasional(jamOperasional, onLog) {
    if (!jamOperasional?.aktif) return;

    while (!dalamJamOperasional(jamOperasional.mulai, jamOperasional.selesai)) {
        if (hentikanDiminta) return;
        onLog({ status: 'menunggu_jam_operasional', mulai: jamOperasional.mulai, selesai: jamOperasional.selesai });
        await tunda(60000);
    }
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
async function kirimBroadcast(daftarPenerima, templatePesan, opsiJeda, lampiran, onLog, jamOperasional) {
    if (statusSaatIni !== 'terhubung') {
        throw new Error('WhatsApp belum terhubung. Scan QR dulu.');
    }

    const {
        jedaMinDetik = 30,
        jedaMaksDetik = 90,
        jedaBatchSetelah = 0,
        jedaBatchMinMenit = 5,
        jedaBatchMaksMenit = 10,
    } = opsiJeda || {};

    hentikanDiminta = false;
    // titik istirahat panjang berikutnya diacak ±30% dari angka yang diisi, supaya tidak
    // selalu jatuh di kelipatan tetap (pola robot) — dihitung ulang tiap kali lewat 1 siklus.
    let pesanTerkirimSejakIstirahat = 0;
    let targetIstirahatBerikutnya = jedaBatchSetelah > 0
        ? acakBulat(Math.max(1, Math.round(jedaBatchSetelah * 0.7)), Math.round(jedaBatchSetelah * 1.3))
        : 0;

    for (let i = 0; i < daftarPenerima.length; i++) {
        if (hentikanDiminta) {
            onLog({ status: 'dihentikan' });
            break;
        }

        await tungguJamOperasional(jamOperasional, onLog);

        if (hentikanDiminta) {
            onLog({ status: 'dihentikan' });
            break;
        }

        const p = daftarPenerima[i];
        const nomorDigit = p.telepon.replace(/\D/g, '');
        onLog({ id: p.id, nama: p.nama, telepon: p.telepon, status: 'memeriksa' });

        try {
            const jid = await cekTerdaftarWa(nomorDigit);
            if (!jid) {
                onLog({ id: p.id, nama: p.nama, telepon: p.telepon, status: 'tidak_terdaftar' });
            } else {
                const pesan = susunPesan(templatePesan, p.nama);
                const isi = lampiran ? buatIsiLampiran(lampiran, pesan) : { text: pesan };

                // simulasi "sedang mengetik" sebelum kirim — perilaku manusia wajar, bukan
                // langsung kirim instan seperti bot.
                try {
                    await sock.presenceSubscribe(jid);
                    await sock.sendPresenceUpdate('composing', jid);
                    await tunda(acakBulat(1200, 4000));
                    await sock.sendPresenceUpdate('paused', jid);
                } catch {
                    // kalau gagal kirim status "mengetik" (jarang), lanjut kirim pesan seperti biasa
                }

                await sock.sendMessage(jid, isi);
                onLog({ id: p.id, nama: p.nama, telepon: p.telepon, status: 'terkirim' });
                pesanTerkirimSejakIstirahat++;
            }
        } catch (err) {
            onLog({ id: p.id, nama: p.nama, telepon: p.telepon, status: 'gagal', pesanError: err.message });
        }

        const masihAda = i < daftarPenerima.length - 1;
        if (masihAda && jedaBatchSetelah > 0 && pesanTerkirimSejakIstirahat >= targetIstirahatBerikutnya) {
            onLog({ status: 'jeda_panjang', menit: jedaBatchMinMenit });
            await jedaAcak(jedaBatchMinMenit * 60, jedaBatchMaksMenit * 60);
            pesanTerkirimSejakIstirahat = 0;
            targetIstirahatBerikutnya = acakBulat(Math.max(1, Math.round(jedaBatchSetelah * 0.7)), Math.round(jedaBatchSetelah * 1.3));
        } else if (masihAda) {
            await jedaAcak(jedaMinDetik, jedaMaksDetik);
        }
    }

    onLog({ status: 'selesai' });
}

module.exports = { mulaiKoneksi, daftarkanListener, statusKoneksi, nomorTerhubung, kirimBroadcast, minta_berhenti, logout };
