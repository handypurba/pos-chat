/**
 * Uji simulasi mesin Broadcast (broadcast.js) tanpa WhatsApp sungguhan: Electron/Baileys di-mock,
 * dan WAKTU DIPALSUKAN (virtual) supaya jeda 15-90 detik / istirahat menit-an selesai seketika.
 * Jalankan: node uji-broadcast.js  -- wajib dijalankan ulang setiap mengubah broadcast.js.
 */
const Module = require('module');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const dirData = fs.mkdtempSync(path.join(os.tmpdir(), 'uji-broadcast-'));
const soks = [];

const tiruan = {
    electron: { app: { getPath: () => dirData } },
    qrcode: { toDataURL: async () => 'data:,' },
    pino: () => ({}),
    '@whiskeysockets/baileys': {
        default: () => {
            const sock = {
                ev: new EventEmitter(), user: { id: '628100000000:1@s.whatsapp.net' }, terkirim: [],
                onWhatsApp: async (n) => [{ exists: !n.startsWith('629999'), jid: n + '@s.whatsapp.net' }],
                presenceSubscribe: async () => {}, sendPresenceUpdate: async () => {},
                sendMessage: async (jid, isi) => { sock.terkirim.push({ jid, teks: isi.text, at: Date.now() }); return { key: { id: 'ID' + soks.reduce((a, s) => a + s.terkirim.length, 0) } }; },
                logout: async () => {},
            };
            soks.push(sock);
            return sock;
        },
        useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
        DisconnectReason: { loggedOut: 401, connectionReplaced: 440, restartRequired: 515 },
    },
};
const muatAsli = Module._load;
Module._load = function (request, ...rest) { return tiruan[request] || muatAsli.call(this, request, ...rest); };

// --- waktu virtual ---
let sekarang = 1_800_000_000_000;
const pengatur = [];
let urut = 0;
const setImmediateAsli = setImmediate;
global.setTimeout = (fn, ms = 0, ...args) => { const t = { at: sekarang + ms, fn, args, urut: urut++ }; pengatur.push(t); return t; };
global.clearTimeout = (t) => { const i = pengatur.indexOf(t); if (i >= 0) pengatur.splice(i, 1); };
Date.now = () => sekarang;

async function jalankan(...janji) {
    let tersisa = janji.length;
    janji.forEach((j) => j.then(() => tersisa--, () => tersisa--));
    for (let putaran = 0; tersisa > 0; putaran++) {
        if (putaran > 2_000_000) throw new Error('simulasi macet');
        await new Promise((r) => setImmediateAsli(r));
        if (!pengatur.length) continue;
        pengatur.sort((a, b) => a.at - b.at || a.urut - b.urut);
        const t = pengatur.shift();
        sekarang = Math.max(sekarang, t.at);
        t.fn(...t.args);
    }
}

async function langkah(maks, berhentiJika = () => false) {
    for (let k = 0; k < maks && !berhentiJika(); k++) {
        await new Promise((r) => setImmediateAsli(r));
        if (pengatur.length) {
            pengatur.sort((x, y) => x.at - y.at || x.urut - y.urut);
            const t = pengatur.shift();
            sekarang = Math.max(sekarang, t.at);
            t.fn(...t.args);
        }
    }
}

const broadcast = require('./broadcast');
const janganKirim = require('./janganKirim');

let gagal = 0;
function cek(nama, kondisi, info = '') {
    console.log((kondisi ? 'OK    - ' : 'GAGAL - ') + nama + (kondisi ? '' : '  ' + info));
    if (!kondisi) gagal++;
}
const rekam = () => { const log = []; return { log, onLog: (l) => log.push(l) }; };
const status = (log, id) => log.filter((l) => l.id === id).map((l) => l.status);
const OPSI = { jedaMinDetik: 1, jedaMaksDetik: 2, jedaBatchSetelah: 0, simulasiMengetik: { aktif: true, kecepatan: 'cepat' } };

(async () => {
    await broadcast.mulaiKoneksi();
    soks[0].ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setImmediateAsli(r));
    const sock = () => soks[soks.length - 1];

    // 1. Normalisasi, duplikat, nomor tidak valid, bukan WA
    {
        const { log, onLog } = rekam();
        const pen = [
            { id: 1, nama: 'A', telepon: '0812-3456-7890' },
            { id: 2, nama: 'B', telepon: '+62 812 3456 7890' },
            { id: 3, nama: 'C', telepon: '123' },
            { id: 4, nama: 'D', telepon: '6299990000001' },
            { id: 5, nama: 'E', telepon: '081200000005' },
        ];
        await jalankan(broadcast.kirimBroadcast(pen, 'Halo {nama}', OPSI, null, onLog));
        cek('0812... dinormalisasi lalu terkirim ke 62812...', status(log, 1).includes('terkirim') && sock().terkirim[0].jid === '628123456789 0'.replace(' ', '') + '@s.whatsapp.net');
        cek('nomor ganda (format beda) dilewati, tidak dikirim 2x', status(log, 2).includes('dilewati'));
        cek('nomor tidak valid ditandai gagal', status(log, 3).includes('gagal'));
        cek('nomor bukan WA ditandai tidak_terdaftar', status(log, 4).includes('tidak_terdaftar'));
        cek('penerima valid lain tetap terkirim', status(log, 5).includes('terkirim'));
    }

    // 2. Daftar jangan kirim
    {
        janganKirim.tambah('081200000009', 'minta_berhenti');
        const { log, onLog } = rekam();
        await jalankan(broadcast.kirimBroadcast([{ id: 9, nama: 'X', telepon: '081200000009' }, { id: 10, nama: 'Y', telepon: '081200000010' }], 'Halo', OPSI, null, onLog));
        cek('nomor di daftar jangan kirim dilewati', status(log, 9).includes('dilewati') && !status(log, 9).includes('terkirim'));
        cek('nomor lain tetap terkirim', status(log, 10).includes('terkirim'));
    }

    // 3. Jeda dikunci: minta 1 detik, kenyataannya >= 15 detik
    {
        const { onLog } = rekam();
        const awal = sock().terkirim.length;
        await jalankan(broadcast.kirimBroadcast([1, 2, 3].map((n) => ({ id: 100 + n, nama: 'J' + n, telepon: '08130000010' + n })), 'Halo', { ...OPSI, simulasiMengetik: { aktif: false } }, null, onLog));
        const waktu = sock().terkirim.slice(awal).map((t) => t.at);
        const selisih = waktu.slice(1).map((t, i) => (t - waktu[i]) / 1000);
        cek('jeda antar pesan dikunci minimal 15 detik walau diisi 1 detik', selisih.length === 2 && selisih.every((d) => d >= 15), JSON.stringify(selisih));
    }

    // 4. Batas harian
    {
        const sudah = broadcast.jumlahTerkirimHariIni();
        const { log, onLog } = rekam();
        const pen = [1, 2, 3, 4].map((n) => ({ id: 200 + n, nama: 'H' + n, telepon: '08140000020' + n }));
        await jalankan(broadcast.kirimBroadcast(pen, 'Halo', { ...OPSI, batasHarian: sudah + 2 }, null, onLog));
        const terkirim = log.filter((l) => l.status === 'terkirim').length;
        cek('berhenti tepat di batas harian (2 terkirim, sisanya antri)', terkirim === 2 && log.some((l) => l.status === 'batas_harian') && !log.some((l) => l.status === 'selesai'), JSON.stringify(log.map((l) => l.status)));
        cek('batas harian tidak bisa dinaikkan melebihi 300', (() => { try { return broadcast.BATAS_HARIAN_MAKS === 300; } catch { return false; } })());
    }

    // 5. Dua pengiriman bersamaan: jarak antar pesan global >= 10 detik; Hentikan tidak ikut membatalkan pengiriman baru
    {
        const awal = sock().terkirim.length;
        const a = rekam();
        const b = rekam();
        const mk = (kode) => [1, 2, 3].map((n) => ({ id: kode * 1000 + n, nama: 'P' + n, telepon: `0815${kode}00000${n}` }));
        const pA = broadcast.kirimBroadcast(mk(31), 'Halo', { ...OPSI, batasHarian: 300 }, null, a.onLog);
        const pB = broadcast.kirimBroadcast(mk(32), 'Halo', { ...OPSI, batasHarian: 300 }, null, b.onLog);
        await jalankan(pA, pB);
        const waktu = sock().terkirim.slice(awal).map((t) => t.at).sort((x, y) => x - y);
        const selisih = waktu.slice(1).map((t, i) => (t - waktu[i]) / 1000);
        cek('2 pengiriman bersamaan: jarak antar pesan APA PUN >= 10 detik', waktu.length === 6 && selisih.every((d) => d >= 10), JSON.stringify(selisih));
    }
    {
        const a = rekam();
        const b = rekam();
        const mk = (kode, jumlah) => Array.from({ length: jumlah }, (_, n) => ({ id: kode * 1000 + n, nama: 'S' + n, telepon: `0816${kode}00000${n}` }));
        const pA = broadcast.kirimBroadcast(mk(41, 6), 'Halo', OPSI, null, a.onLog);
        await langkah(30);
        broadcast.minta_berhenti();
        const pB = broadcast.kirimBroadcast(mk(42, 2), 'Halo', OPSI, null, b.onLog);
        await jalankan(pA, pB);
        cek('Hentikan menghentikan pengiriman yang sedang jalan', a.log.some((l) => l.status === 'dihentikan'));
        cek('pengiriman BARU setelah Hentikan tidak ikut terhenti', b.log.filter((l) => l.status === 'terkirim').length === 2 && b.log.some((l) => l.status === 'selesai'), JSON.stringify(b.log.map((l) => l.status)));
    }

    // 6. Koneksi putus di tengah kampanye: menunggu & lanjut, tidak menandai gagal
    {
        const { log, onLog } = rekam();
        const pen = Array.from({ length: 4 }, (_, n) => ({ id: 500 + n, nama: 'K' + n, telepon: '08170000050' + n }));
        const p = broadcast.kirimBroadcast(pen, 'Halo', { ...OPSI, simulasiMengetik: { aktif: false } }, null, onLog);
        await langkah(400, () => log.filter((l) => l.status === 'terkirim').length >= 1);
        sock().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
        await new Promise((r) => setImmediateAsli(r));
        // sambung ulang terjadwal otomatis (backoff); setelah tersambung kampanye lanjut
        const tunggu = jalankan(new Promise((resolve) => {
            const cekSambung = setInterval0(() => { if (soks[soks.length - 1] !== soks[soks.length - 2] && soks.length > 1) { setTimeout(() => { soks[soks.length - 1].ev.emit('connection.update', { connection: 'open' }); resolve(); }, 60000); return true; } return false; });
        }));
        await tunggu;
        await jalankan(p);
        const st = log.map((l) => l.status);
        cek('koneksi putus di tengah: penerima tidak ditandai gagal', !st.includes('gagal'), JSON.stringify(st));
        cek('setelah tersambung lagi semua penerima terkirim', log.filter((l) => l.status === 'terkirim').length === 4, JSON.stringify(st));
        cek('ada status menunggu_koneksi selama putus', st.includes('menunggu_koneksi'));
    }

    // 7. Sesi digantikan: tidak rebutan balik
    {
        const jumlahSebelum = soks.length;
        sock().ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 440 } } } });
        await langkah(400);
        cek('sesi digantikan perangkat lain: TIDAK menyambung ulang otomatis', soks.length === jumlahSebelum && broadcast.statusKoneksi() === 'sesi-digantikan', broadcast.statusKoneksi());
    }

    // 8. Pola permintaan berhenti
    {
        cek('"stop" dikenali', janganKirim.teksMintaBerhenti('stop'));
        cek('"tolong berhenti kirim" dikenali', janganKirim.teksMintaBerhenti('Tolong berhenti kirim ya'));
        cek('"jangan kirim lagi" dikenali', janganKirim.teksMintaBerhenti('jangan kirim lagi'));
        cek('kalimat panjang tidak salah dikenali', !janganKirim.teksMintaBerhenti('Halo kak, saya mau pesan lakban 2 inch 10 roll, jangan lupa kirim hari ini ya terima kasih banyak sebelumnya'));
        cek('pertanyaan biasa tidak dikenali', !janganKirim.teksMintaBerhenti('berapa harga lakban bening 2 inch?'));
    }

    console.log(gagal === 0 ? '\nSEMUA LULUS' : `\n${gagal} UJI GAGAL`);
    fs.rmSync(dirData, { recursive: true, force: true });
    process.exit(gagal === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

function setInterval0(fn) {
    const tick = () => { if (!fn()) setTimeout(tick, 1000); };
    setTimeout(tick, 1000);
}
