const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const tls = require('tls');
const XLSX = require('xlsx');
const broadcast = require('./broadcast');
const kontak = require('./kontak');
const riwayat = require('./riwayat');
const template = require('./template');
const autoreply = require('./autoreply');
const followup = require('./followup');
const broadcastRemote = require('./broadcastRemote');
const pantauChatWa = require('./pantauChatWa');
const alatBantu = require('./alatBantu');
const { autoUpdater } = require('electron-updater');

// Cegah lebih dari 1 instance jalan bersamaan — tanpa ini, tiap instance baru buka BrowserView
// dengan partition WA/Shopee/Tokped yang SAMA secara bersamaan, saling berebut file sesi
// (IndexedDB/LevelDB) dan merusaknya. Ini kemungkinan besar penyebab sesi sering "hilang" sendiri
// selama ini — bukan cuma soal restart tidak halus. Kalau ada auto-start di Windows yang memicu
// app terbuka berkali-kali (shortcut dobel di Startup, dst), instance ke-2 dst di sini langsung
// keluar sendiri, dan window instance PERTAMA yang dimunculkan ke depan (bukan bikin window baru).
const dapatLock = app.requestSingleInstanceLock();
if (!dapatLock) {
    app.quit();
    process.exit(0);
}

/** Migrasi otomatis sesi dari userData app versi sebelumnya ("Hanmar Chat Hub", nama app lama
 * sebelum rename ke "POS Chat" 23 Agustus 2026) — supaya WA/Shopee/Tokped/broadcast TIDAK perlu
 * scan ulang / login ulang di laptop mana pun begitu update ini sampai ke sana (appId berubah
 * artinya Electron pindah ke folder userData baru yang kosong, tanpa ini semua sesi hilang).
 * Jalan SEKALI per laptop (ditandai file .migrasi-dari-hanmar-chat-hub), aman dipanggil berkali-
 * kali (skip otomatis kalau sudah pernah). Harus jalan SEBELUM app.whenReady()/BrowserView mana
 * pun dibuat, supaya tidak menimpa sesi baru yang sudah sempat kebentuk. */
function migrasiDariHanmarChatHubLama() {
    const userDataBaru = app.getPath('userData');
    const tandaMigrasi = path.join(userDataBaru, '.migrasi-dari-hanmar-chat-hub');
    fs.mkdirSync(userDataBaru, { recursive: true });
    if (fs.existsSync(tandaMigrasi)) return;

    // Nama folder AppData app lama ditentukan dari field "name" di package.json versi lama
    // ("hanmar-chat-hub") — path standarnya %APPDATA%\hanmar-chat-hub di semua laptop Windows.
    const userDataLama = path.join(app.getPath('appData'), 'hanmar-chat-hub');
    if (!fs.existsSync(userDataLama)) {
        fs.writeFileSync(tandaMigrasi, new Date().toISOString());
        return;
    }

    // Yang dipindah: sesi WA/Shopee/Tokped/Broadcast (Partitions), token login POS Chat, dan
    // pengaturan tab custom (workspace-*.json) — SENGAJA TIDAK termasuk Cache/GPUCache/dst (cuma
    // cache render, aman dibuat ulang otomatis, tidak perlu ikut dipindah).
    const daftarPindah = [
        'Partitions',
        'chathub-token.txt',
        'sesi-wa-broadcast',
        'workspace-nama.json',
        'workspace-tambahan.json',
        'workspace-terhapus.json',
        'workspace-urutan.json',
    ];

    for (const nama of daftarPindah) {
        const sumber = path.join(userDataLama, nama);
        const tujuan = path.join(userDataBaru, nama);
        if (!fs.existsSync(sumber) || fs.existsSync(tujuan)) continue;
        try {
            fs.cpSync(sumber, tujuan, { recursive: true });
        } catch (err) {
            console.error(`Migrasi "${nama}" gagal:`, err);
        }
    }

    fs.writeFileSync(tandaMigrasi, new Date().toISOString());
}

migrasiDariHanmarChatHubLama();

/** Cari nama kolom yang cocok di antara beberapa alias umum (header Excel bisa macam-macam
 * penulisan) — dibandingkan setelah huruf kecil semua + spasi/underscore dibuang. */
function cariKolom(row, aliasList) {
    const kunciTersedia = Object.keys(row);
    for (const alias of aliasList) {
        const cocok = kunciTersedia.find((k) => k.toLowerCase().replace(/[\s_]/g, '') === alias);
        if (cocok) return row[cocok];
    }
    return null;
}

function parseExcelKontak(filePath) {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const valid = [];
    let dilewati = 0;

    for (const row of rows) {
        const nama = cariKolom(row, ['nama', 'name', 'namapelanggan']);
        const telepon = cariKolom(row, ['telepon', 'nowa', 'nohp', 'whatsapp', 'phone', 'nomor', 'notelepon']);
        const grup = cariKolom(row, ['grup', 'group', 'kategori']);

        const teleponBersih = telepon !== null ? String(telepon).replace(/\D/g, '') : '';
        if (!nama || teleponBersih.length < 8) {
            dilewati++;
            continue;
        }

        valid.push({ nama: String(nama).trim(), telepon: teleponBersih, grup: grup ? String(grup).trim() : '' });
    }

    return { valid, dilewati };
}

// Root CA terbaru ("ISRG Root YR") yang dipakai server Hanmar POS — ditambahkan ke daftar
// kepercayaan bawaan Node.js karena versi Electron ini belum menyertakannya secara default,
// jadi validasi sertifikat sempat gagal ("certificate has expired") walau sertifikatnya valid.
// Ditambahkan (BUKAN menggantikan) daftar root bawaan — validasi tetap aktif penuh untuk semua domain.
const CA_TAMBAHAN = fs.readFileSync(path.join(__dirname, 'ca-root.pem'), 'utf-8');
const CA_LENGKAP = [...tls.rootCertificates, CA_TAMBAHAN];

/** Ambil/kirim JSON pakai modul https/http bawaan Node.js langsung — hindari net.fetch/global
 * fetch Electron yang di beberapa lingkungan gagal resolve DNS (ERR_NAME_NOT_RESOLVED). Dipakai
 * baik buat GET biasa (ambil pelanggan, dst) maupun POST (lapor progres broadcast job ke server). */
function requestJson(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const bodyStr = body !== undefined ? JSON.stringify(body) : null;
        const headerLengkap = bodyStr
            ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
            : headers;

        const req = lib.request(url, { method, headers: headerLengkap, ca: CA_LENGKAP }, (res) => {
            let hasil = '';
            res.on('data', (chunk) => { hasil += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    // Laravel balas JSON { message: "..." } buat error tervalidasi (422/403/dst) —
                    // ambil pesannya biar rapi ke user, bukan mentahan JSON-nya.
                    let pesan = `Status ${res.statusCode}: ${hasil.slice(0, 200)}`;
                    try {
                        const err = JSON.parse(hasil);
                        if (err.message) pesan = err.message;
                    } catch {}
                    reject(new Error(pesan));
                    return;
                }
                if (!hasil) { resolve(null); return; }
                try {
                    resolve(JSON.parse(hasil));
                } catch (e) {
                    reject(new Error('Respons bukan JSON valid: ' + hasil.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout menghubungi server')));
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

function ambilJson(url, headers) {
    return requestJson('GET', url, headers);
}

/** Unduh file (lampiran broadcast dari server) ke path lokal — dipakai broadcastRemote.js sebelum
 * eksekusi job yang punya lampiran, karena kirimBroadcast() cuma terima path file lokal. */
function unduhFile(url, tujuanPath) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { ca: CA_LENGKAP }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`Gagal unduh lampiran, status ${res.statusCode}`));
                return;
            }
            const tulis = fs.createWriteStream(tujuanPath);
            res.pipe(tulis);
            tulis.on('finish', () => tulis.close(() => resolve(tujuanPath)));
            tulis.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Timeout unduh lampiran')));
    });
}

// Lebar sidebar (daftar tab) bisa digeser user -- diminta owner 8 Sep 2026 (lihat
// #sidebar-resizer di sidebar.html). Dimuat dari pengaturan tersimpan saat startup; berubah
// lewat IPC 'sidebar-lebar-sementara' (selagi diseret, live) & 'sidebar-lebar-simpan' (dilepas,
// permanen) -- lihat handler di bawah. SENGAJA bukan const lagi.
let SIDEBAR_WIDTH = 96;
// PENTING: nomor versi di sini harus SAMA dengan versi Chromium sungguhan yang dibundel Electron
// (cek process.versions.chrome) — kalau beda, situs modern (Tokopedia dkk) bisa mendeteksi lewat
// navigator.userAgentData (Client Hints, TIDAK ikut disamarkan oleh setUserAgent) yang otomatis
// selalu melapor versi asli, beda dari string UA yang kita set manual di sini. Ketidakcocokan itu
// jadi tanda "environment dipalsukan" dan bisa bikin situsnya diam-diam menahan render konten
// (layar putih) tanpa pesan error — pernah terjadi persis begini di Tokped DLP (Agustus 2026).
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.129 Safari/537.36';

let mainWindow;
let views = {};
let workspaces = [];
let activeId = null;
let baileysSudahDimulai = false;
let userChatHub = null; // { id, nama, email, role } — user yang sedang login di Chat Hub

/** Token Sanctum dari login Hanmar Chat Hub — disimpan sebagai file teks polos di userData
 * (bukan di app.asar yang read-only), supaya login-nya tetap "nempel" (auto-login) walau
 * aplikasi ditutup-buka lagi. Hilang/tidak valid lagi → server balas 401 → minta login ulang
 * (lihat cekLoginLaluMulai). */
const FILE_TOKEN_CHATHUB = () => path.join(app.getPath('userData'), 'chathub-token.txt');

function muatTokenChatHub() {
    const file = FILE_TOKEN_CHATHUB();
    if (!fs.existsSync(file)) return null;
    try {
        const isi = fs.readFileSync(file, 'utf-8').trim();
        return isi || null;
    } catch {
        return null;
    }
}

function simpanTokenChatHub(token) {
    fs.writeFileSync(FILE_TOKEN_CHATHUB(), token);
}

function hapusTokenChatHub() {
    try { fs.unlinkSync(FILE_TOKEN_CHATHUB()); } catch {}
}

/** Nama workspace hasil rename dari dalam app disimpan terpisah dari workspaces.json bawaan
 * (yang ikut ke dalam app.asar, jadi read-only saat sudah di-package) — supaya rename tetap
 * tersimpan walau ada update aplikasi nanti. Dipetakan berdasarkan id workspace. */
const FILE_NAMA_WORKSPACE = () => path.join(app.getPath('userData'), 'workspace-nama.json');

function muatNamaOverride() {
    const file = FILE_NAMA_WORKSPACE();
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function simpanNamaOverride(peta) {
    fs.writeFileSync(FILE_NAMA_WORKSPACE(), JSON.stringify(peta, null, 2));
}

/** Sama seperti nama override di atas, tapi untuk URL -- dipakai buat "Edit URL" tab (6 Sep
 * 2026, diminta owner). Sebelumnya satu-satunya cara ganti URL tab bawaan (mis. kalau URL Leads
 * di workspaces.json berubah) adalah hapus tab lalu tambah baru sebagai tab custom -- sekarang
 * bisa langsung edit URL tab MANA PUN (bawaan atau custom) tanpa hapus. */
const FILE_URL_WORKSPACE = () => path.join(app.getPath('userData'), 'workspace-url.json');

function muatUrlOverride() {
    const file = FILE_URL_WORKSPACE();
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return {};
    }
}

function simpanUrlOverride(peta) {
    fs.writeFileSync(FILE_URL_WORKSPACE(), JSON.stringify(peta, null, 2));
}

/** Urutan sidebar hasil drag-and-drop — disimpan terpisah juga (array id, urutan dari atas ke
 * bawah). Workspace baru yang belum pernah ada di urutan tersimpan (misalnya nanti nambah
 * workspace lagi) otomatis ditaruh di akhir, bukan hilang. */
const FILE_URUTAN_WORKSPACE = () => path.join(app.getPath('userData'), 'workspace-urutan.json');

function muatUrutanOverride() {
    const file = FILE_URUTAN_WORKSPACE();
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return null;
    }
}

function simpanUrutanOverride(urutanId) {
    fs.writeFileSync(FILE_URUTAN_WORKSPACE(), JSON.stringify(urutanId, null, 2));
}

/** Tab yang ditambah manual dari dalam app (tombol "+" di sidebar) — disimpan terpisah dari
 * workspaces.json bawaan (read-only setelah di-package), supaya tetap ada walau ada update
 * aplikasi nanti. Isinya objek workspace lengkap (bukan cuma id), karena tab custom tidak ada
 * definisinya di workspaces.json bawaan. */
const FILE_WORKSPACE_TAMBAHAN = () => path.join(app.getPath('userData'), 'workspace-tambahan.json');

function muatTambahanOverride() {
    const file = FILE_WORKSPACE_TAMBAHAN();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function simpanTambahanOverride(daftar) {
    fs.writeFileSync(FILE_WORKSPACE_TAMBAHAN(), JSON.stringify(daftar, null, 2));
}

/** Id tab bawaan (dari workspaces.json) yang dihapus manual oleh user — workspaces.json sendiri
 * tidak bisa diedit (read-only setelah di-package), jadi "hapus" untuk tab bawaan berarti
 * disembunyikan lewat daftar ini, bukan benar-benar dihilangkan dari file aslinya. */
const FILE_WORKSPACE_TERHAPUS = () => path.join(app.getPath('userData'), 'workspace-terhapus.json');

function muatTerhapusOverride() {
    const file = FILE_WORKSPACE_TERHAPUS();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function simpanTerhapusOverride(daftarId) {
    fs.writeFileSync(FILE_WORKSPACE_TERHAPUS(), JSON.stringify(daftarId, null, 2));
}

// Id tab bawaan (bukan hasil tambah manual) — dipakai saat hapus, buat bedakan "sembunyikan
// dari daftar bawaan" (tab bawaan) vs "buang dari daftar tambahan" (tab custom).
let idBawaan = new Set();

function muatWorkspaces() {
    const raw = fs.readFileSync(path.join(__dirname, 'workspaces.json'), 'utf-8');
    const bawaan = JSON.parse(raw);
    idBawaan = new Set(bawaan.map((w) => w.id));

    const tambahan = muatTambahanOverride();
    const terhapus = new Set(muatTerhapusOverride());
    workspaces = [...bawaan, ...tambahan].filter((ws) => !terhapus.has(ws.id));

    const namaOverride = muatNamaOverride();
    const urlOverride = muatUrlOverride();
    workspaces.forEach((ws) => {
        if (namaOverride[ws.id]) ws.nama = namaOverride[ws.id];
        if (urlOverride[ws.id]) ws.url = urlOverride[ws.id];
    });

    const urutanId = muatUrutanOverride();
    if (urutanId) {
        const posisi = new Map(urutanId.map((id, i) => [id, i]));
        workspaces.sort((a, b) => {
            const pa = posisi.has(a.id) ? posisi.get(a.id) : 999;
            const pb = posisi.has(b.id) ? posisi.get(b.id) : 999;
            return pa - pb;
        });
    }
}

ipcMain.handle('workspace-reorder', (event, urutanId) => {
    const posisi = new Map(urutanId.map((id, i) => [id, i]));
    workspaces.sort((a, b) => {
        const pa = posisi.has(a.id) ? posisi.get(a.id) : 999;
        const pb = posisi.has(b.id) ? posisi.get(b.id) : 999;
        return pa - pb;
    });
    simpanUrutanOverride(workspaces.map((ws) => ws.id));
    mainWindow?.webContents.send('daftar-workspace', workspaces);
    return { berhasil: true };
});

ipcMain.handle('workspace-rename', (event, { id, namaBaru }) => {
    const namaBersih = (namaBaru || '').trim();
    if (!namaBersih) return { berhasil: false, alasan: 'Nama tidak boleh kosong' };

    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return { berhasil: false, alasan: 'Workspace tidak ditemukan' };

    ws.nama = namaBersih;
    const namaOverride = muatNamaOverride();
    namaOverride[id] = namaBersih;
    simpanNamaOverride(namaOverride);

    mainWindow?.webContents.send('daftar-workspace', workspaces);
    return { berhasil: true };
});

/** Edit URL tab MANA PUN (bawaan dari workspaces.json ataupun custom) tanpa perlu hapus-tambah
 * ulang -- diminta owner 6 Sep 2026, kejadian nyata: tab "Leads" custom yang dibuat sebelum
 * "?embed=1" ditambahkan ke workspaces.json jadi menampilkan sidebar Hanmar POS penuh, harus
 * diperbaiki manual di tiap laptop. Cuma untuk tab web (WA/Shopee/Tokped/custom), bukan tab
 * "Broadcast WA" (tidak punya URL). Langsung reload isi tab-nya juga (loadURL), tidak perlu
 * restart aplikasi. */
ipcMain.handle('workspace-edit-url', (event, { id, urlBaru }) => {
    const bersih = (urlBaru || '').trim();
    if (!/^https?:\/\//.test(bersih)) return { berhasil: false, alasan: 'URL harus diawali http:// atau https://' };

    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return { berhasil: false, alasan: 'Workspace tidak ditemukan' };
    if (ws.tipe !== 'web') return { berhasil: false, alasan: 'Tab ini tidak punya URL' };

    ws.url = bersih;
    const urlOverride = muatUrlOverride();
    urlOverride[id] = bersih;
    simpanUrlOverride(urlOverride);

    views[id]?.webContents.loadURL(bersih);

    mainWindow?.webContents.send('daftar-workspace', workspaces);
    return { berhasil: true };
});

function muatConfig() {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8');
    return JSON.parse(raw);
}

/** Kelompok platform buat pilih bunyi notifikasi (WA 1 & WA 2 sama-sama pakai bunyi "whatsapp",
 * Shopee HF & DLP sama-sama pakai bunyi "shopee", dst) — bukan per-workspace, supaya user bisa
 * bedakan dari BUNYI-nya itu dari platform apa, walau ada 2 akun per platform. */
function platformDari(wsId) {
    if (wsId.startsWith('whatsapp')) return 'whatsapp';
    if (wsId.startsWith('shopee')) return 'shopee';
    if (wsId.startsWith('tokped')) return 'tokped';
    return 'lainnya';
}

const judulTerakhir = {};

// Kapan tiap tab web TERAKHIR selesai load/reload (did-finish-load) -- dipakai laporStatusChatHub()
// buat kasih jeda "pemanasan" sebelum mulai percaya status "belum dibalas" tab itu. Ditemukan
// owner 7 Sep 2026: begitu WA Web baru saja di-reload/reconnect, ikon centang/read di baris chat
// belum sempat kebaca sempurna oleh pantauChatWa.js sesaat setelah halaman dimuat -- akibatnya
// chat LAMA yang sebenarnya sudah dibalas sempat kebaca "belum dibalas" dan salah bikin Leads baru
// (kejadian nyata: 5 leads muncul bersamaan tepat setelah tab Admin HF reconnect).
const viewDimuatPada = {};
const JEDA_PEMANASAN_SETELAH_LOAD_MS = 45 * 1000;

/** Banyak web chat (WhatsApp Web, dkk) menaruh jumlah pesan belum dibaca di AWAL judul tab,
 * mis. "(3) WhatsApp" — pola ini dipakai luas jadi dijadikan patokan umum untuk 3 platform
 * sekaligus, tanpa perlu tahu detail tampilan situsnya. */
function jumlahBelumDibaca(judul) {
    const cocok = judul.match(/^\((\d+)\)/);
    return cocok ? parseInt(cocok[1], 10) : 0;
}

function pantauJudul(ws, view) {
    judulTerakhir[ws.id] = 0;
    setInterval(() => {
        if (view.webContents.isDestroyed()) return;
        const judul = view.webContents.getTitle();
        const jumlah = jumlahBelumDibaca(judul);
        if (jumlah > judulTerakhir[ws.id] && ws.id !== activeId) {
            mainWindow?.webContents.send('notif-pesan-baru', { workspaceId: ws.id, platform: platformDari(ws.id), jumlah });
        }
        judulTerakhir[ws.id] = jumlah;
    }, 3000);
}

function buatView(ws) {
    const view = new BrowserView({
        webPreferences: {
            partition: `persist:${ws.id}`,
            contextIsolation: true,
            // Tanpa ini, Chromium membatasi ("throttle") timer internal halaman begitu tab-nya
            // tidak sedang ditampilkan (bukan tab aktif, atau window di-minimize) — termasuk
            // mekanisme WhatsApp Web/Shopee/Tokped yang mengubah judul tab saat ada pesan baru
            // (dipakai jumlahBelumDibaca() di atas). Akibatnya notifikasi (badge & suara) telat
            // atau tidak muncul sama sekali untuk tab yang bukan sedang dibuka. Matikan supaya
            // semua tab tetap terpantau real-time walau sedang di background.
            backgroundThrottling: false,
        },
    });
    view.webContents.setUserAgent(UA_CHROME);
    view.webContents.loadURL(ws.url);
    pantauJudul(ws, view);

    // Catat tiap kali tab ini selesai load/reload -- dipakai laporStatusChatHub() buat jeda
    // pemanasan (lihat JEDA_PEMANASAN_SETELAH_LOAD_MS di atas). did-finish-load ini juga otomatis
    // ke-trigger ulang saat workspace-reload (view.webContents.reload()), jadi tidak perlu
    // dipasang terpisah di situ.
    view.webContents.on('did-finish-load', () => {
        viewDimuatPada[ws.id] = Date.now();
    });

    // Tokopedia (sekarang gabung Seller Center Tokopedia+TikTok Shop): buka langsung ke URL
    // chat spesifik (dengan oec_seller_id dkk) sering nyangkut layar putih di dalam embed —
    // situsnya sepertinya butuh "datang" dari halaman utama seller.tokopedia.com dulu (referrer/
    // session context), bukan loncat langsung. Sebagai jaring pengaman tambahan: tiap kali
    // halaman ini selesai load, coba cari & klik tombol/link "Ke Seller Center" (teks yang
    // dipakai Tokopedia di halaman dashboard lama sebelum diarahkan ke Seller Center gabungan)
    // kalau memang ada — aman/idempoten, tidak ngapa-ngapain kalau tombolnya tidak ketemu.
    if (platformDari(ws.id) === 'tokped') {
        view.webContents.on('did-finish-load', () => {
            view.webContents
                .executeJavaScript(
                    `(() => {
                        const target = 'ke seller center';
                        let tries = 0;
                        const attempt = () => {
                            tries += 1;
                            const clickable = Array.from(document.querySelectorAll('a,button,[role="button"]'));
                            const el = clickable.find((e) => e.innerText && e.innerText.trim().toLowerCase().includes(target));
                            if (el) { el.click(); return; }
                            if (tries < 20) setTimeout(attempt, 500);
                        };
                        attempt();
                    })();`
                )
                .catch(() => {});
        });
    }

    // Beberapa fitur (mis. Chat Shopee Seller Centre) buka jendela baru (window.open) --
    // dialihkan ke tab yang SAMA (bukan jendela terpisah) supaya user tetap fokus di 1 jendela
    // aplikasi, TAPI CUMA kalau tujuannya domain yang dipercaya (masih 1 platform yang sama,
    // mis. Shopee buka popup Shopee lagi, atau domain URL asli tab itu -- termasuk redirect
    // login/auth yang wajar). Kalau tujuannya domain LAIN SAMA SEKALI (mis. link dari isi pesan
    // WA yang diklik -- entah itu situs kamera EZVIZ, marketplace lain, dst), buka di browser
    // SISTEM (default: Chrome/Edge) supaya sesi WA/Shopee/Tokped di tab itu tidak "ketiban"
    // konten asing yang tidak ada jalan baliknya -- ditemukan owner 9 Sep 2026: klik link di WA
    // bikin tab WA-nya berubah total jadi halaman lain, tidak bisa balik lagi ke WA kecuali
    // Edit URL/restart aplikasi.
    const domainDipercaya = (url) => {
        let host;
        try { host = new URL(url).hostname; } catch { return false; }
        const cocokAkhiran = (domain) => host === domain || host.endsWith('.' + domain);

        const domainPlatform = { whatsapp: ['whatsapp.com'], shopee: ['shopee.co.id', 'shopee.com'], tokped: ['tokopedia.com'] };
        if ((domainPlatform[platformDari(ws.id)] || []).some(cocokAkhiran)) return true;

        try {
            if (cocokAkhiran(new URL(ws.url).hostname)) return true;
        } catch { /* tab tipe broadcast tidak punya ws.url -- aman diabaikan */ }

        return false;
    };

    const bukaExternalAtauSamaTab = ({ url }) => {
        if (domainDipercaya(url)) {
            view.webContents.loadURL(url);
        } else {
            shell.openExternal(url).catch(() => {});
        }
        return { action: 'deny' };
    };
    view.webContents.setWindowOpenHandler(bukaExternalAtauSamaTab);

    // Klik link BIASA (bukan window.open, mis. <a href> polos di isi pesan WA) menavigasi
    // TAB ITU SENDIRI langsung, tidak lewat setWindowOpenHandler di atas sama sekali -- cegah
    // juga di sini dengan alasan yang sama. Navigasi PERTAMA (loadURL awal saat tab dibuat) juga
    // lewat sini, tapi aman karena domain URL asli tab SELALU dipercaya (lihat domainDipercaya).
    view.webContents.on('will-navigate', (event, url) => {
        if (!domainDipercaya(url)) {
            event.preventDefault();
            shell.openExternal(url).catch(() => {});
        }
    });

    return view;
}

function aturUkuranView(view) {
    if (!mainWindow) return;
    const { width, height } = mainWindow.getContentBounds();
    view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: width - SIDEBAR_WIDTH, height });
    view.setAutoResize({ width: true, height: true });
}

/** Cari tab "Leads" (dicari dari NAMA tab, bukan id -- id tab custom bisa beda-beda antar
 * laptop, lihat catatan di workspace-tambahan) lalu pindahkan ke situ. Aman kalau tab-nya
 * dihapus/belum ada (tidak ngapa-ngapain). */
function bukaTabLeadsOtomatis() {
    const tabLeads = workspaces.find((w) => w.tipe === 'web' && w.nama.toLowerCase().includes('leads'));
    if (tabLeads) tampilkanWorkspace(tabLeads.id);
}

/** Jadwalkan bukaTabLeadsOtomatis() berikutnya, baca jeda TERBARU dari alatBantu tiap kali --
 * jadi kalau owner ganti angkanya di Alat Bantu > Perangkat, langsung kepakai di siklus
 * berikutnya tanpa perlu restart aplikasi (beda dari setInterval yang jedanya "beku" sejak
 * pertama dipasang). */
function jadwalkanBukaTabLeads() {
    setTimeout(() => {
        bukaTabLeadsOtomatis();
        jadwalkanBukaTabLeads();
    }, alatBantu.muatJedaTabLeadsMenit() * 60 * 1000);
}

function tampilkanWorkspace(id) {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;

    if (ws.tipe === 'broadcast') {
        mainWindow.setBrowserView(null);
        if (!baileysSudahDimulai) {
            baileysSudahDimulai = true;
            broadcast.daftarkanListener({
                onQr: (dataUrl) => mainWindow.webContents.send('broadcast-qr', dataUrl),
                onStatus: (status) => mainWindow.webContents.send('broadcast-status', status),
                onNomor: (nomor) => mainWindow.webContents.send('broadcast-nomor', nomor),
                onPesanMasuk: (pesan) => mainWindow.webContents.send('broadcast-pesan-masuk', pesan),
            });
            broadcast.mulaiKoneksi();
        } else {
            mainWindow.webContents.send('broadcast-status', broadcast.statusKoneksi());
            mainWindow.webContents.send('broadcast-nomor', broadcast.nomorTerhubung());
        }
    } else {
        const view = views[id];
        if (!view) return;
        mainWindow.setBrowserView(view);
        aturUkuranView(view);
        judulTerakhir[id] = jumlahBelumDibaca(view.webContents.getTitle());
        mainWindow.webContents.send('notif-bersih', id);
    }

    activeId = id;
    mainWindow.webContents.send('workspace-aktif', id);
}

function buatWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            // Chromium biasa membatasi ("throttle") halaman yang dianggap tidak terlihat — dan
            // karena sidebar.html (tempat kode suara notifikasi jalan) selalu tertutup penuh oleh
            // BrowserView workspace yang sedang aktif, Chromium bisa keliru menganggapnya
            // "di background" terus-menerus meski window-nya sendiri sedang dibuka/aktif. Ini
            // bikin suara notifikasi tidak terdengar. Matikan pembatasannya di sini.
            backgroundThrottling: false,
        },
    });

    mainWindow.loadFile('sidebar.html');

    // Tab-tab chat (WA/Shopee/Tokped) BELUM dimuat di sini — sengaja ditunda sampai login
    // Hanmar Chat Hub berhasil (lihat cekLoginLaluMulai), supaya BrowserView tidak menutupi
    // layar login (BrowserView selalu tampil di atas konten window, jadi kalau tab langsung
    // dimuat, layar login yang ada di sidebar.html jadi tidak kelihatan sama sekali).
    mainWindow.webContents.once('did-finish-load', () => {
        cekLoginLaluMulai();
    });

    mainWindow.on('resize', () => {
        if (activeId && views[activeId]) aturUkuranView(views[activeId]);
    });
}

/** Cek token Hanmar Chat Hub yang tersimpan dari login sebelumnya (kalau ada) ke server POS —
 * kalau masih valid & akunnya masih aktif, langsung lanjut (auto-login) tanpa minta password
 * lagi. Kalau tidak ada token / sudah tidak valid (logout dari device lain, akun dinonaktifkan,
 * dst), tampilkan layar login dan tunggu submit lewat ipcMain.handle('chathub-login'). */
async function cekLoginLaluMulai() {
    const token = muatTokenChatHub();
    if (token) {
        try {
            const cfg = muatConfig();
            const hasil = await requestJson('GET', `${cfg.apiBaseUrl}/api/chathub/saya`, {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            });
            userChatHub = hasil.user;
            mulaiSetelahLogin();
            return;
        } catch {
            hapusTokenChatHub(); // token kadaluwarsa/dicabut/akun nonaktif — minta login ulang
        }
    }
    mainWindow.webContents.send('tampilkan-login');
}

/** Dipanggil sekali setelah login (baik auto-login pakai token tersimpan, maupun login manual
 * baru) — baru di titik ini tab-tab chat benar-benar dimuat & timer follow-up/polling dimulai. */
let aplikasiSudahDimulai = false;
function mulaiSetelahLogin() {
    if (aplikasiSudahDimulai) return;
    aplikasiSudahDimulai = true;

    muatWorkspaces();
    workspaces.filter((ws) => ws.tipe === 'web').forEach((ws) => {
        views[ws.id] = buatView(ws);
    });

    mainWindow.webContents.send('login-berhasil', userChatHub);
    mainWindow.webContents.send('daftar-workspace', workspaces);
    if (workspaces.length > 0) tampilkanWorkspace(workspaces[0].id);

    // cek follow-up sekali setelah 2 menit (kasih waktu koneksi WA nyambung dulu), lalu
    // berkala tiap beberapa jam — TIDAK langsung saat baru login supaya tidak dadakan.
    setTimeout(() => jalankanSemuaAturanFollowUp().catch(() => {}), 2 * 60 * 1000);
    setInterval(() => jalankanSemuaAturanFollowUp().catch(() => {}), JEDA_CEK_FOLLOWUP_JAM * 60 * 60 * 1000);

    // Poll broadcast job yang dijadwalkan owner dari HP (pos.hanmar.id/broadcast-wa) — lihat
    // broadcastRemote.js. Jalan terus di background selama aplikasi terbuka.
    broadcastRemote.mulaiPolling({ requestJson, unduhFile, broadcast, muatConfig });

    // Jalur PRIORITAS — poll terpisah untuk WA invoice yang dibuat otomatis begitu kasir cetak
    // invoice (lihat InvoiceWaService di Laravel), supaya tetap langsung terkirim walau broadcast
    // promo di atas sedang berjalan lama.
    broadcastRemote.mulaiPollingPrioritas({ requestJson, unduhFile, broadcast, muatConfig });

    // Lapor status koneksi + chat yang belum dibalas ke pos.hanmar.id berkala — dipakai halaman
    // monitoring HP owner (lihat ChatHubStatusController & CekChatLamaDibalas di Laravel).
    setTimeout(() => laporStatusChatHub().catch(() => {}), 20 * 1000);
    jadwalkanLaporStatus();

    // Otomatis buka tab "Leads" tiap sekian menit (diatur di Alat Bantu > Perangkat, default 5
    // menit) -- diminta owner 7 Sep 2026, supaya admin selalu kepancing lihat papan Leads &
    // pindahkan kartu sesuai progres, bukan cuma dibuka manual kalau ingat. Sengaja pindah tab
    // beneran (bukan cuma notifikasi) -- efek sampingnya tab yang lagi aktif bisa "kepindah"
    // tiap siklus walau admin lagi baca chat lain, itu disengaja. Pola setTimeout REKURSIF
    // (bukan setInterval tetap) supaya kalau angkanya diubah dari Alat Bantu, langsung kepakai
    // di siklus berikutnya tanpa perlu restart aplikasi.
    jadwalkanBukaTabLeads();

    mulaiPemantauPengingat();
}

/** Jadwalkan laporStatusChatHub() berikutnya, baca jeda TERBARU dari alatBantu tiap kali -- sama
 * pola dengan jadwalkanBukaTabLeads() (setTimeout REKURSIF, bukan setInterval tetap) supaya
 * kalau owner ganti angkanya di Alat Bantu > Perangkat, langsung kepakai di siklus berikutnya
 * tanpa perlu restart aplikasi. Diminta owner 9 Sep 2026 (sebelumnya fixed 30 detik, tidak bisa
 * diubah tanpa build ulang). */
function jadwalkanLaporStatus() {
    setTimeout(() => {
        laporStatusChatHub()
            .catch(() => {})
            .finally(() => jadwalkanLaporStatus());
    }, alatBantu.muatJedaLaporStatusDetik() * 1000);
}

/** Kumpulkan status semua tab web (koneksi + khusus WA: daftar kontak yang belum dibalas), lalu
 * kirim ke server. Gagal kirim (jaringan dll) dibiarkan saja — dicoba lagi interval berikutnya,
 * bukan error yang menghentikan aplikasi. */
async function laporStatusChatHub() {
    const koneksi = [];
    const belumDibalas = [];
    const kontakTerlihat = [];

    for (const ws of workspaces.filter((w) => w.tipe === 'web')) {
        const view = views[ws.id];
        if (!view || view.webContents.isDestroyed()) continue;

        const platform = platformDari(ws.id);
        const status = await pantauChatWa.bacaStatusKoneksi(view, platform);
        koneksi.push({
            workspace_id: ws.id,
            nama: ws.nama,
            platform,
            status,
            jumlah_belum_dibaca: judulTerakhir[ws.id] || 0,
        });

        // Ditampilkan LOKAL di sidebar (tanda merah "perlu login ulang") TERLEPAS dari
        // apakah login POS Chat/lapor ke server berhasil — supaya tetap kelihatan walau
        // offline atau belum sempat login akun POS Chat.
        mainWindow?.webContents.send('status-koneksi-tab', { workspaceId: ws.id, status });

        // Tab yang BARU SAJA selesai load/reload dilewati dulu (belum dianggap "belum dibalas"
        // apa pun) sampai lewat masa pemanasan -- lihat catatan JEDA_PEMANASAN_SETELAH_LOAD_MS.
        // Status koneksi di atas tetap dilaporkan seperti biasa, cuma daftar belum-dibalas yang
        // ditahan supaya tidak salah bikin Leads baru dari chat lama yang sebenarnya sudah dibalas.
        const baruSajaDimuat = Date.now() - (viewDimuatPada[ws.id] || 0) < JEDA_PEMANASAN_SETELAH_LOAD_MS;

        if (baruSajaDimuat) {
            // lewati pembacaan belum-dibalas untuk tab ini siklus ini
        } else if (platform === 'whatsapp' && status === 'terhubung') {
            const { belumDibalas: daftar, kontakTerlihat: daftarTerlihat } = await pantauChatWa.bacaBelumDibalasWa(view, ws.id);
            daftar.forEach((d) => belumDibalas.push({ workspace_id: ws.id, ...d }));
            daftarTerlihat.forEach((nama) => kontakTerlihat.push({ workspace_id: ws.id, kontak_nama: nama }));
        } else if (platform === 'shopee' && status === 'terhubung') {
            const daftar = await pantauChatWa.bacaBelumDibalasShopee(view);
            daftar.forEach((d) => belumDibalas.push({ workspace_id: ws.id, ...d }));
        } else if (platform === 'tokped' && status === 'terhubung') {
            const daftar = await pantauChatWa.bacaBelumDibalasTokped(view, ws.id);
            daftar.forEach((d) => belumDibalas.push({ workspace_id: ws.id, ...d }));
        }
    }

    const token = muatTokenChatHub();
    if (!token) return;

    const cfg = muatConfig();
    await requestJson('POST', `${cfg.apiBaseUrl}/api/chathub/lapor-status`, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    }, { perangkat: alatBantu.muatNamaPerangkat(), koneksi, belum_dibalas: belumDibalas, kontak_terlihat: kontakTerlihat });
}

/** Cek pengingat follow-up yang sudah jatuh tempo tiap 30 detik — munculkan sebagai
 * notifikasi Windows (bukan dialog modal, supaya tidak mengganggu kalau lagi sibuk balas chat). */
function mulaiPemantauPengingat() {
    const { Notification } = require('electron');
    setInterval(() => {
        const jatuhTempo = alatBantu.ambilPengingatJatuhTempo();
        jatuhTempo.forEach((p) => {
            const notif = new Notification({
                title: 'Pengingat follow up: ' + p.workspaceNama,
                body: p.catatan || 'Waktunya follow up sekarang.',
            });
            notif.on('click', () => {
                mainWindow?.show();
                tampilkanWorkspace(p.workspaceId);
            });
            notif.show();
        });
    }, 30 * 1000);
}

/** Login manual dari layar login (dipanggil renderer lewat window.chatHub.loginChatHub). */
ipcMain.handle('chathub-login', async (event, { email, password }) => {
    try {
        const cfg = muatConfig();
        const hasil = await requestJson('POST', `${cfg.apiBaseUrl}/api/chathub/login`, {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        }, { email, password });

        simpanTokenChatHub(hasil.token);
        userChatHub = hasil.user;
        mulaiSetelahLogin();
        return { berhasil: true, user: hasil.user };
    } catch (err) {
        return { berhasil: false, alasan: err.message };
    }
});

/** Logout manual — cabut token di server, hapus token lokal, tutup semua tab, balik ke layar
 * login. Aplikasi TIDAK di-restart, tapi statusnya balik seperti sebelum login sama sekali. */
ipcMain.handle('chathub-logout', async () => {
    const token = muatTokenChatHub();
    if (token) {
        try {
            const cfg = muatConfig();
            await requestJson('POST', `${cfg.apiBaseUrl}/api/chathub/logout`, {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            });
        } catch {
            // token mungkin sudah tidak valid di server — tetap lanjut bersihkan sisi lokal
        }
    }

    hapusTokenChatHub();
    userChatHub = null;
    aplikasiSudahDimulai = false;

    mainWindow.setBrowserView(null);
    views = {};
    activeId = null;
    workspaces = [];

    mainWindow.webContents.send('tampilkan-login');
    return { berhasil: true };
});

ipcMain.on('pilih-workspace', (event, id) => {
    tampilkanWorkspace(id);
});

/** BrowserView (tab WA/Shopee/Tokped) SELALU digambar di atas konten HTML biasa (sidebar.html),
 * jadi modal/overlay apa pun (mis. "Tambah Tab Baru") akan tertutup di belakangnya kalau tab
 * web sedang aktif — kelihatan seperti "tidak merespons" padahal sebenarnya cuma tak terlihat.
 * Dipanggil renderer sebelum menampilkan modal, lalu dikembalikan setelah modal ditutup. */
ipcMain.on('sembunyikan-view-modal', () => {
    mainWindow?.setBrowserView(null);
});

ipcMain.on('tampilkan-view-modal', () => {
    if (activeId && views[activeId]) {
        mainWindow?.setBrowserView(views[activeId]);
        aturUkuranView(views[activeId]);
    }
});

/** Reload manual satu tab web (WA/Shopee/Tokped) — dipakai saat sesi baru login ulang atau
 * tab macet/nyangkut, tanpa perlu tutup-buka seluruh aplikasi. */
ipcMain.on('workspace-reload', (event, id) => {
    const view = views[id];
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
});

/** "Kembali" -- diminta owner 9 Sep 2026, pulihkan tab yang kepindah ke halaman lain (mis. klik
 * link asing di isi chat, atau navigasi apa pun yang tidak diinginkan) TANPA Edit URL/restart
 * aplikasi. Pakai riwayat navigasi bawaan Chromium (goBack), bukan balik ke ws.url -- supaya
 * juga berguna buat navigasi wajar dalam 1 platform yang sama (mis. Shopee pindah-pindah
 * halaman), bukan cuma kasus link asing. */
ipcMain.handle('workspace-kembali', (event, id) => {
    const view = views[id];
    if (!view || view.webContents.isDestroyed() || !view.webContents.navigationHistory.canGoBack()) {
        return { berhasil: false };
    }
    view.webContents.navigationHistory.goBack();
    return { berhasil: true };
});

/** Tambah tab web baru secara manual (tombol "+" di sidebar) — id dibuat unik dari platform +
 * timestamp, supaya tab sejenis (mis. beberapa WhatsApp) tetap kebagian suara notif yang benar
 * lewat platformDari() yang membaca awalan id ("whatsapp-", "shopee-", "tokped-"). */
ipcMain.handle('workspace-tambah', (event, { nama, platform, url, warna }) => {
    const namaBersih = (nama || '').trim();
    if (!namaBersih) return { berhasil: false, alasan: 'Nama tab tidak boleh kosong' };
    if (!/^https?:\/\//.test(url || '')) return { berhasil: false, alasan: 'URL tidak valid (harus diawali http:// atau https://)' };

    const prefix = ['whatsapp', 'shopee', 'tokped'].includes(platform) ? platform : 'custom';
    const id = `${prefix}-tambahan-${Date.now()}`;
    const wsBaru = { id, nama: namaBersih, url, warna: warna || '#4b5563', tipe: 'web' };

    workspaces.push(wsBaru);
    views[id] = buatView(wsBaru);

    const tambahan = muatTambahanOverride();
    tambahan.push(wsBaru);
    simpanTambahanOverride(tambahan);

    mainWindow?.webContents.send('daftar-workspace', workspaces);
    return { berhasil: true, id };
});

/** Hapus tab (bawaan maupun tambahan). Tab bawaan tidak bisa dihilangkan dari workspaces.json
 * (read-only), jadi cukup disembunyikan lewat daftar "terhapus"; tab tambahan langsung dibuang
 * dari daftar "tambahan". Tab Broadcast WA dikecualikan karena itu satu-satunya akses ke fitur
 * broadcast, bukan sekadar tab web biasa. */
ipcMain.handle('workspace-hapus', (event, id) => {
    const idx = workspaces.findIndex((w) => w.id === id);
    if (idx === -1) return { berhasil: false, alasan: 'Tab tidak ditemukan' };
    if (workspaces[idx].tipe === 'broadcast') return { berhasil: false, alasan: 'Tab Broadcast WA tidak bisa dihapus' };

    const view = views[id];
    if (view) {
        if (activeId === id) {
            mainWindow.setBrowserView(null);
            activeId = null;
        }
        delete views[id];
    }
    workspaces.splice(idx, 1);

    if (idBawaan.has(id)) {
        const terhapus = muatTerhapusOverride();
        if (!terhapus.includes(id)) terhapus.push(id);
        simpanTerhapusOverride(terhapus);
    } else {
        simpanTambahanOverride(muatTambahanOverride().filter((w) => w.id !== id));
    }

    mainWindow?.webContents.send('daftar-workspace', workspaces);
    if (!activeId && workspaces.length > 0) tampilkanWorkspace(workspaces[0].id);
    return { berhasil: true };
});

async function ambilPelangganDb() {
    const cfg = muatConfig();
    const data = await ambilJson(`${cfg.apiBaseUrl}/api/pelanggan-broadcast`, {
        'X-Api-Key': cfg.apiKey,
        'Accept': 'application/json',
    });
    return data.pelanggan;
}

/** Gabungkan pelanggan dari database POS + kontak manual + grup tersimpan — dipakai juga oleh
 * penjadwal Auto Follow Up (bukan cuma renderer), supaya bisa jalan sendiri di proses utama. */
async function ambilSemuaKontakGabungan() {
    const [pelangganDb, kontakManual, grupPelanggan] = await Promise.all([
        ambilPelangganDb(), kontak.muatSemua(), kontak.muatGrupPelanggan(),
    ]);
    const dbTergabung = pelangganDb.map((p) => ({
        ...p, id: 'db-' + p.id,
        grup: grupPelanggan[p.id] || p.tipe_pelanggan || 'Pelanggan',
        sumber: 'db',
    }));
    return [...kontakManual, ...dbTergabung];
}

ipcMain.handle('ambil-pelanggan', async () => {
    return ambilPelangganDb();
});

ipcMain.handle('kirim-broadcast', async (event, { penerima, template, jeda, lampiran, jamOperasional }) => {
    const hasilLengkap = [];
    await broadcast.kirimBroadcast(penerima, template, jeda, lampiran, (log) => {
        mainWindow.webContents.send('broadcast-log', log);
        if (log.id && ['terkirim', 'tidak_terdaftar', 'gagal'].includes(log.status)) {
            hasilLengkap.push(log);
        }
    }, jamOperasional);
    if (hasilLengkap.length > 0) {
        riwayat.simpanKampanye({ template, hasil: hasilLengkap });
    }
});

ipcMain.handle('riwayat-daftar', () => riwayat.muatSemua());

ipcMain.handle('autoreply-muat', () => autoreply.muat());

ipcMain.handle('autoreply-simpan', (event, konfig) => autoreply.simpan(konfig));

ipcMain.handle('followup-daftar-aturan', () => followup.muatAturan());

ipcMain.handle('followup-tambah-aturan', (event, data) => followup.tambahAturan(data));

ipcMain.handle('followup-hapus-aturan', (event, id) => followup.hapusAturan(id));

ipcMain.handle('followup-set-aktif', (event, { id, aktif }) => followup.setAktif(id, aktif));

ipcMain.handle('followup-jalankan-sekarang', () => jalankanSemuaAturanFollowUp());

/**
 * Cek semua aturan Auto Follow Up yang aktif — kirim ke kontak yang sesuai grup dan sudah
 * waktunya di-follow-up lagi (belum pernah, atau sudah lewat interval hari). Jam operasional
 * 08.00-20.00 WIB dipakai tetap (bukan bisa diatur) khusus untuk follow-up otomatis ini, supaya
 * tidak pernah kirim tengah malam tanpa sepengetahuan owner.
 */
async function jalankanSemuaAturanFollowUp() {
    if (broadcast.statusKoneksi() !== 'terhubung') return { dikirim: 0, alasan: 'WhatsApp belum terhubung' };

    const aturanAktif = followup.muatAturan().filter((a) => a.aktif);
    if (aturanAktif.length === 0) return { dikirim: 0 };

    const semuaKontak = await ambilSemuaKontakGabungan();
    let totalDikirim = 0;

    for (const aturan of aturanAktif) {
        const riwayatFu = followup.muatRiwayatFollowUp();
        const target = semuaKontak.filter((k) => k.grup === aturan.grup && followup.perluFollowUp(k.id, aturan.intervalHari, riwayatFu));

        if (target.length === 0) continue;

        const hasilLengkap = [];
        await broadcast.kirimBroadcast(
            target,
            aturan.template,
            { jedaMinDetik: 30, jedaMaksDetik: 90, jedaBatchSetelah: 20, jedaBatchMinMenit: 5, jedaBatchMaksMenit: 10 },
            null,
            (log) => {
                mainWindow?.webContents.send('broadcast-log', log);
                if (log.id && ['terkirim', 'tidak_terdaftar', 'gagal'].includes(log.status)) {
                    hasilLengkap.push(log);
                    if (log.status === 'terkirim') followup.catatFollowUp(log.id);
                }
            },
            { aktif: true, mulai: '08:00', selesai: '20:00' },
        );

        if (hasilLengkap.length > 0) {
            riwayat.simpanKampanye({ template: `[Follow Up: ${aturan.nama}] ` + aturan.template, hasil: hasilLengkap });
        }
        totalDikirim += hasilLengkap.filter((h) => h.status === 'terkirim').length;
    }

    return { dikirim: totalDikirim };
}

ipcMain.handle('template-daftar', () => template.muatSemua());

ipcMain.handle('template-simpan', (event, data) => template.simpan(data));

ipcMain.handle('template-hapus', (event, id) => template.hapus(id));

ipcMain.on('broadcast-berhenti', () => {
    broadcast.minta_berhenti();
});

ipcMain.handle('broadcast-logout', async () => {
    await broadcast.logout();
});

// --- Balasan cepat (copy-paste manual, bukan dikirim otomatis) ---
ipcMain.handle('balasan-cepat-daftar', () => alatBantu.muatBalasanCepat());
ipcMain.handle('balasan-cepat-tambah', (event, teks) => alatBantu.tambahBalasanCepat(teks));
ipcMain.handle('balasan-cepat-hapus', (event, id) => alatBantu.hapusBalasanCepat(id));

// --- Pengingat follow-up per tab ---
ipcMain.handle('pengingat-daftar', () => alatBantu.muatPengingat());
ipcMain.handle('pengingat-tambah', (event, data) => alatBantu.tambahPengingat(data));
ipcMain.handle('pengingat-hapus', (event, id) => alatBantu.hapusPengingat(id));

// --- Mode Jangan Ganggu terjadwal ---
ipcMain.handle('dnd-muat', () => alatBantu.muatDnd());
ipcMain.handle('dnd-simpan', (event, konfig) => alatBantu.simpanDnd(konfig));
ipcMain.handle('dnd-cek', (event, platform) => alatBantu.dalamJamDnd(alatBantu.muatDnd(), platform));

// --- Bungkam suara/toast per TAB, permanen (beda dari Jangan Ganggu di atas yang per platform
// & terjadwal) -- diminta owner 8 Sep 2026. ---
ipcMain.handle('tab-dibungkam-muat', () => alatBantu.muatTabDibungkam());
ipcMain.handle('tab-dibungkam-simpan', (event, daftarId) => alatBantu.simpanTabDibungkam(daftarId));

// --- Lebar sidebar (daftar tab) bisa digeser -- diminta owner 8 Sep 2026. 'sementara' dipanggil
// TERUS selagi diseret (live, tidak ditulis ke disk); 'simpan' cuma sekali di mouseup (permanen).
// Keduanya reposisi BrowserView yang lagi aktif supaya konten ikut menyesuaikan real-time. ---
ipcMain.handle('sidebar-lebar-muat', () => alatBantu.muatLebarSidebar());
ipcMain.handle('sidebar-lebar-sementara', (event, px) => {
    SIDEBAR_WIDTH = Math.min(220, Math.max(76, Math.round(Number(px)) || SIDEBAR_WIDTH));
    const view = views[activeId];
    if (view && !view.webContents.isDestroyed()) aturUkuranView(view);
});
ipcMain.handle('sidebar-lebar-simpan', (event, px) => {
    SIDEBAR_WIDTH = alatBantu.simpanLebarSidebar(px);
    const view = views[activeId];
    if (view && !view.webContents.isDestroyed()) aturUkuranView(view);
    return SIDEBAR_WIDTH;
});

// --- Nama Perangkat (label laptop, dikirim tiap lapor status -- lihat laporStatusChatHub) ---
ipcMain.handle('perangkat-muat', () => alatBantu.muatNamaPerangkat());
ipcMain.handle('perangkat-simpan', (event, nama) => alatBantu.simpanNamaPerangkat(nama));

// --- Jeda auto-buka tab Leads (menit) -- lihat jadwalkanBukaTabLeads() ---
ipcMain.handle('jeda-tab-leads-muat', () => alatBantu.muatJedaTabLeadsMenit());
ipcMain.handle('jeda-tab-leads-simpan', (event, menit) => alatBantu.simpanJedaTabLeadsMenit(menit));

// --- Jeda lapor status ke server (detik) -- diminta owner 9 Sep 2026 ---
ipcMain.handle('jeda-lapor-status-muat', () => alatBantu.muatJedaLaporStatusDetik());
ipcMain.handle('jeda-lapor-status-simpan', (event, detik) => alatBantu.simpanJedaLaporStatusDetik(detik));

ipcMain.handle('kontak-daftar', () => kontak.muatSemua());

ipcMain.handle('kontak-tambah', (event, data) => kontak.tambah(data));

ipcMain.handle('kontak-hapus', (event, id) => kontak.hapus(id));

ipcMain.handle('kontak-upload-excel', async () => {
    const hasil = await dialog.showOpenDialog(mainWindow, {
        title: 'Pilih File Excel Kontak (kolom: Nama, No WA, Grup opsional)',
        properties: ['openFile'],
        filters: [{ name: 'Excel/CSV', extensions: ['xlsx', 'xls', 'csv'] }],
    });

    if (hasil.canceled || hasil.filePaths.length === 0) return null;

    const { valid, dilewati } = parseExcelKontak(hasil.filePaths[0]);
    const ditambahkan = kontak.tambahBanyak(valid);
    return { ditambahkan: ditambahkan.length, dilewati };
});

ipcMain.handle('kontak-export-excel', async (event, daftarKontak) => {
    const hasil = await dialog.showSaveDialog(mainWindow, {
        title: 'Simpan Daftar Kontak',
        defaultPath: 'kontak-broadcast-' + new Date().toISOString().slice(0, 10) + '.xlsx',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });

    if (hasil.canceled || !hasil.filePath) return null;

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(daftarKontak.map((k) => ({
        Nama: k.nama, 'No WA': k.telepon, Grup: k.grup, Sumber: k.sumber === 'manual' ? 'Manual' : 'Database POS',
    })));
    XLSX.utils.book_append_sheet(wb, ws, 'Kontak');
    XLSX.writeFile(wb, hasil.filePath);

    return { path: hasil.filePath, jumlah: daftarKontak.length };
});

ipcMain.handle('kontak-unduh-template', async () => {
    const hasil = await dialog.showSaveDialog(mainWindow, {
        title: 'Simpan Template Excel Kontak',
        defaultPath: 'template-kontak-broadcast.xlsx',
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });

    if (hasil.canceled || !hasil.filePath) return null;

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
        { Nama: 'Toko Contoh', 'No WA': '6281234567890', Grup: 'Dalam Kota' },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Kontak');
    XLSX.writeFile(wb, hasil.filePath);

    return { path: hasil.filePath };
});

ipcMain.handle('grup-pelanggan-daftar', () => kontak.muatGrupPelanggan());

ipcMain.handle('grup-pelanggan-set-banyak', (event, { idList, grup }) => kontak.setGrupPelangganBanyak(idList, grup));

ipcMain.handle('pilih-lampiran', async () => {
    const hasil = await dialog.showOpenDialog(mainWindow, {
        title: 'Pilih Foto / Video / PDF',
        properties: ['openFile'],
        filters: [
            { name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'pdf'] },
        ],
    });

    if (hasil.canceled || hasil.filePaths.length === 0) return null;

    const filePath = hasil.filePaths[0];
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    let tipe = 'document';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) tipe = 'image';
    else if (['mp4', 'mov'].includes(ext)) tipe = 'video';

    return { path: filePath, namaFile: path.basename(filePath), tipe, mimeType: ext === 'pdf' ? 'application/pdf' : undefined };
});

const JEDA_CEK_FOLLOWUP_JAM = 6;

// Dipanggil di instance PERTAMA saat ada yang coba buka instance KEDUA (lihat requestSingleInstanceLock
// di atas) — daripada diam saja, munculkan window yang sudah ada ke depan supaya user tetap dapat
// respons (kelihatan aplikasinya "sudah kebuka", bukan seperti tidak terjadi apa-apa).
app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
});

/** Auto-update — cek pembaruan ke pos.hanmar.id/chathub-updates/ (lihat "publish" di package.json).
 * Diunduh diam-diam di background; begitu siap, tanya user mau restart sekarang atau nanti (nanti
 * tetap otomatis terpasang pas app ditutup normal — perilaku bawaan electron-updater). Tujuannya
 * supaya karyawan yang lokasinya jauh (Pekanbaru, owner di Batam) tidak perlu install manual tiap
 * ada perbaikan kecil. */
/** Kirim status cek update ke sidebar (buat tombol "Cek Update Sekarang", lihat IPC handler
 * 'cek-update-manual' & 'versi-app-muat' di bawah) -- diminta owner 9 Sep 2026. Sebelumnya
 * proses ini SEPENUHNYA diam-diam (termasuk kalau gagal, lihat catatan lama di bawah), jadi user
 * tidak pernah tahu apakah sedang cek/unduh/gagal/sudah versi terbaru sama sekali. */
function kirimStatusUpdate(status, pesan) {
    mainWindow?.webContents.send('status-update-app', { status, pesan });
}

function aturAutoUpdate() {
    autoUpdater.autoDownload = true;

    autoUpdater.on('checking-for-update', () => kirimStatusUpdate('mengecek', 'Sedang mengecek update...'));
    autoUpdater.on('update-available', (info) => kirimStatusUpdate('mengunduh', `Update v${info.version} ditemukan, sedang diunduh...`));
    autoUpdater.on('update-not-available', () => kirimStatusUpdate('terbaru', 'Sudah versi terbaru.'));
    autoUpdater.on('download-progress', (p) => kirimStatusUpdate('mengunduh', `Mengunduh... ${Math.round(p.percent)}%`));

    autoUpdater.on('update-downloaded', (info) => {
        kirimStatusUpdate('siap', `Versi ${info.version} siap dipasang.`);
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update POS Chat siap dipasang',
            message: `Versi ${info.version} sudah diunduh. Pasang & restart sekarang?`,
            buttons: ['Restart Sekarang', 'Nanti'],
            defaultId: 0,
            cancelId: 1,
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
            // kalau pilih "Nanti", tetap otomatis terpasang saat app ditutup normal berikutnya.
        });
    });

    // Kegagalan cek update (mis. internet mati) tidak boleh mengganggu jalannya aplikasi (tidak
    // munculkan dialog error yang mengganggu) -- tapi TETAP dikirim ke sidebar sebagai status
    // (dulu sepenuhnya diam, user tidak pernah tahu kalau gagal -- diperbaiki 9 Sep 2026).
    autoUpdater.on('error', (err) => kirimStatusUpdate('gagal', 'Gagal mengecek update: ' + (err?.message || 'tidak diketahui')));

    const cekUpdate = () => autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(cekUpdate, 15 * 1000); // kasih waktu app selesai load dulu
    setInterval(cekUpdate, 4 * 60 * 60 * 1000); // lalu ulang tiap 4 jam (app biasanya menyala seharian)
}

ipcMain.handle('cek-update-manual', () => {
    kirimStatusUpdate('mengecek', 'Sedang mengecek update...');
    autoUpdater.checkForUpdates().catch((err) => kirimStatusUpdate('gagal', 'Gagal mengecek update: ' + (err?.message || 'tidak diketahui')));
});

ipcMain.handle('versi-app-muat', () => app.getVersion());

app.whenReady().then(() => {
    SIDEBAR_WIDTH = alatBantu.muatLebarSidebar();
    buatWindow();
    // Follow-up & polling broadcast job baru dimulai di mulaiSetelahLogin(), setelah login
    // Hanmar Chat Hub berhasil — bukan di sini.
    aturAutoUpdate();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) buatWindow();
});
