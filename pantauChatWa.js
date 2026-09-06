// Baca status "sudah/belum dibalas" dari chat list WhatsApp Web & Shopee Seller Center, dan
// status koneksi sederhana tiap tab (WA/Shopee/Tokped) — dipakai main.js buat lapor berkala ke
// pos.hanmar.id (lihat PosChatStatusController). Riset struktur DOM WA dilakukan manual (Agustus
// 2026): tiap baris kontak = [data-testid="cell-frame-container"]; kalau ada ikon status
// kirim/dibaca (title mengandung "read"/"check"/dst) di baris itu, berarti pesan TERAKHIR
// dikirim OLEH kita (sudah dibalas) — kalau tidak ada, pesan terakhir MASUK dari lawan chat
// (belum dibalas).
//
// Shopee diriset manual juga (6 Sep 2026, dari outerHTML yang dikirim owner): tiap baris kontak
// = [data-cy="webchat-conversation-cell-container"], nama & waktu & cuplikan pesan masing-masing
// punya data-cy sendiri (stabil, bukan hash acak seperti class CSS-nya). Tanda "sudah dibalas"
// = elemen SETELAH [data-cy="webchat-conversation-cell-message"] (kotak ikon centang/pin di
// kanan pesan) ADA ISINYA; kalau kosong berarti pesan terakhir dari pelanggan (belum dibalas).
// Sengaja tidak pakai nama class-nya sendiri (mis. ".qOuhYMblK-") karena class hash begini biasa
// berubah tiap Shopee update frontend-nya -- pakai posisi relatif dari data-cy yang stabil.
//
// Tokped/TikTok Seller Center diriset manual juga (6 Sep 2026): nama kontak ada di
// [data-testid="chat.chatroom.conversation_card_username"], waktu di elemen <time
// class="chatd-time">. TIDAK ada tanda "belum dibalas" yang kelihatan dari 1 baris chat saja
// (beda dari WA/Shopee) -- satu-satunya cara yang ditemukan adalah folder filter bawaan
// "Belum dibalas" di sidebar (data-uid="menu.item_chat_v2-menu-UNREPLIED"), yang cuma bisa
// dibuka dengan KLIK (bukan URL terpisah, SPA). Konsekuensinya: bacaBelumDibalasTokped() klik
// folder itu, baca isinya, lalu klik balik ke folder semula secepatnya (~1 detik) -- disengaja
// owner (6 Sep 2026) walau berarti tab Tokped POS Chat bisa sempat "berkedip" pindah folder
// tiap ~30 detik kalau admin sedang pakai tab itu manual bersamaan.

const SKRIP_EKSTRAK_WA = `
(function () {
    function dumpBaris(el) {
        const potongan = [];
        el.querySelectorAll('*').forEach((node) => {
            const teks = (node.getAttribute('title') || node.getAttribute('aria-label') || '').trim();
            const langsung = Array.from(node.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent.trim())
                .join('');
            if (teks || langsung) potongan.push({ tag: node.tagName, t: teks, x: langsung });
        });
        return potongan;
    }
    const baris = document.querySelectorAll('[data-testid="cell-frame-container"]');
    return JSON.stringify(Array.from(baris).map((b) => dumpBaris(b)));
})()
`;

const POLA_WAKTU = /^(\d{1,2}:\d{2}|Kemarin|Hari ini|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu|\d{1,2}\/\d{1,2}\/\d{2,4})$/i;
const POLA_IKON_STATUS_KIRIM = /read|check|dblcheck|msg-|sent|delivered/i;

function analisisBarisWa(potongan) {
    const namaEntry = potongan.find((p) => p.tag === 'SPAN' && p.t && p.t === p.x);
    const nama = namaEntry ? namaEntry.x : null;

    const waktuEntry = potongan.find((p) => p.tag === 'SPAN' && !p.t && POLA_WAKTU.test((p.x || '').trim()));
    const waktuMentah = waktuEntry ? waktuEntry.x.trim() : null;

    const sudahDibalas = potongan.some((p) => p.tag === 'TITLE' && POLA_IKON_STATUS_KIRIM.test(p.x || ''));

    // Cuplikan pesan: span polos (tanpa title) yang bukan nama/waktu/pemisah ":" — biasanya
    // urutan aslinya [nama, waktu, ..., cuplikan pesan], jadi ambil kandidat TERAKHIR yang cocok.
    const kandidatPesan = potongan.filter((p) =>
        p.tag === 'SPAN' && p.x && !p.t && p.x !== nama && p.x !== waktuMentah && p.x !== ':'
    );
    const pesanCuplikan = kandidatPesan.length ? kandidatPesan[kandidatPesan.length - 1].x : null;

    return { nama, waktuMentah, sudahDibalas, pesanCuplikan };
}

/** Ubah label waktu WA ("10:42", "Kemarin", nama hari, dst) jadi Date perkiraan — dipakai server
 * buat hitung "sudah berapa menit belum dibalas". Kalau bukan format jam:menit (berarti bukan
 * hari ini), cukup dianggap "kemarin" — yang penting jadi pasti >4 menit yang lalu. */
function waktuMentahKeAbsolut(waktuMentah) {
    if (!waktuMentah) return null;
    const sekarang = new Date();
    const cocokJam = waktuMentah.match(/^(\d{1,2}):(\d{2})$/);

    if (cocokJam) {
        const hasil = new Date(sekarang);
        hasil.setHours(Number(cocokJam[1]), Number(cocokJam[2]), 0, 0);
        if (hasil > sekarang) hasil.setDate(hasil.getDate() - 1); // jaga-jaga lewat tengah malam
        return hasil;
    }

    const hasil = new Date(sekarang);
    hasil.setDate(hasil.getDate() - 1);
    hasil.setHours(12, 0, 0, 0);
    return hasil;
}

const SKRIP_EKSTRAK_SHOPEE = `
(function () {
    const baris = document.querySelectorAll('[data-cy="webchat-conversation-cell-container"]');
    return JSON.stringify(Array.from(baris).map((el) => {
        const namaEl = el.querySelector('[data-cy="webchat-conversation-cell-name"]');
        const waktuEl = el.querySelector('[data-cy="webchat-conversation-cell-timestamp"]');
        const pesanEl = el.querySelector('[data-cy="webchat-conversation-cell-content-text"]');
        const pesanWrap = el.querySelector('[data-cy="webchat-conversation-cell-message"]');
        const indikatorWrap = pesanWrap ? pesanWrap.nextElementSibling : null;
        return {
            nama: namaEl ? (namaEl.getAttribute('title') || namaEl.textContent.trim()) : null,
            waktuMentah: waktuEl ? waktuEl.textContent.trim() : null,
            pesanCuplikan: pesanEl ? (pesanEl.getAttribute('title') || pesanEl.textContent.trim()) : null,
            sudahDibalas: !!(indikatorWrap && indikatorWrap.children.length > 0),
        };
    }));
})()
`;

/** Waktu Shopee formatnya beda dari WA -- bisa "14:23" (hari ini) atau "28/02/25" (tanggal
 * lengkap, chat lama). Format lain yang belum dikenal (mis. "Kemarin") dianggap kemarin jam 12
 * siang, sama seperti fallback WA -- yang penting pasti kehitung lewat batas waktu. */
function waktuMentahShopeeKeAbsolut(waktuMentah) {
    if (!waktuMentah) return null;

    const cocokJam = waktuMentah.match(/^(\d{1,2}):(\d{2})$/);
    if (cocokJam) {
        const sekarang = new Date();
        const hasil = new Date(sekarang);
        hasil.setHours(Number(cocokJam[1]), Number(cocokJam[2]), 0, 0);
        if (hasil > sekarang) hasil.setDate(hasil.getDate() - 1);
        return hasil;
    }

    const cocokTanggal = waktuMentah.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (cocokTanggal) {
        const [, tgl, bln, thnMentah] = cocokTanggal;
        const tahun = thnMentah.length === 2 ? Number('20' + thnMentah) : Number(thnMentah);
        return new Date(tahun, Number(bln) - 1, Number(tgl), 12, 0, 0);
    }

    const hasil = new Date();
    hasil.setDate(hasil.getDate() - 1);
    hasil.setHours(12, 0, 0, 0);
    return hasil;
}

/** Baca daftar kontak yang pesan terakhirnya belum dibalas dari 1 tab Shopee Seller Center. */
async function bacaBelumDibalasShopee(view) {
    try {
        const mentah = await view.webContents.executeJavaScript(SKRIP_EKSTRAK_SHOPEE);
        const semuaBaris = JSON.parse(mentah);
        const hasil = [];

        for (const b of semuaBaris) {
            if (!b.nama || b.sudahDibalas) continue;

            const waktuAbsolut = waktuMentahShopeeKeAbsolut(b.waktuMentah);
            if (!waktuAbsolut) continue;

            hasil.push({
                kontak_nama: b.nama,
                pesan_cuplikan: b.pesanCuplikan,
                waktu_pesan_masuk: waktuAbsolut.toISOString(),
            });
        }

        return hasil;
    } catch {
        return [];
    }
}

/** Baca daftar kontak yang pesan terakhirnya belum dibalas dari 1 tab WhatsApp Web. */
async function bacaBelumDibalasWa(view) {
    try {
        const mentah = await view.webContents.executeJavaScript(SKRIP_EKSTRAK_WA);
        const semuaBaris = JSON.parse(mentah);
        const hasil = [];

        for (const potongan of semuaBaris) {
            const info = analisisBarisWa(potongan);
            if (!info.nama || info.sudahDibalas) continue;

            const waktuAbsolut = waktuMentahKeAbsolut(info.waktuMentah);
            if (!waktuAbsolut) continue;

            hasil.push({
                kontak_nama: info.nama,
                pesan_cuplikan: info.pesanCuplikan,
                waktu_pesan_masuk: waktuAbsolut.toISOString(),
            });
        }

        return hasil;
    } catch {
        return [];
    }
}

const SKRIP_EKSTRAK_TOKPED = `
(function () {
    const namaEls = document.querySelectorAll('[data-testid="chat.chatroom.conversation_card_username"]');
    return JSON.stringify(Array.from(namaEls).map((namaEl) => {
        // Struktur (6 Sep 2026): namaEl -> .pxS4k... -> .Vz43z...(nama+waktu) -> .thuL8G...(baris)
        // -> children[0] = nama+waktu, children[1] = cuplikan pesan. Naik 3 level dari namaEl.
        const baris = namaEl.parentElement && namaEl.parentElement.parentElement
            ? namaEl.parentElement.parentElement.parentElement : null;
        if (!baris || baris.children.length < 2) return null;

        const barisNama = baris.children[0];
        const barisPesan = baris.children[1];
        const waktuEl = barisNama ? barisNama.querySelector('time') : null;

        return {
            nama: namaEl.textContent.trim(),
            waktuMentah: waktuEl ? waktuEl.textContent.trim() : null,
            pesanCuplikan: barisPesan ? barisPesan.textContent.trim() : null,
        };
    }).filter(Boolean));
})()
`;

const SELECTOR_FOLDER_BELUM_DIBALAS_TOKPED = '[data-uid="menu.item_chat_v2-menu-UNREPLIED"]';

const BULAN_ID_TOKPED = { jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, jun: 5, jul: 6, agu: 7, sep: 8, okt: 9, nov: 10, des: 11 };
const HARI_ID_TOKPED = { minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6 };

/** Waktu Tokped ada 3 gaya: "14:23" (hari ini), nama hari ("Rabu", untuk 2-6 hari lalu), atau
 * "Agu 25"/"31/08/2026" (lebih lama). Format tak dikenal dianggap kemarin jam 12 siang, sama
 * seperti fallback WA/Shopee. */
function waktuMentahTokpedKeAbsolut(waktuMentah) {
    if (!waktuMentah) return null;
    const teks = waktuMentah.trim();
    const sekarang = new Date();

    const cocokJam = teks.match(/^(\d{1,2}):(\d{2})$/);
    if (cocokJam) {
        const hasil = new Date(sekarang);
        hasil.setHours(Number(cocokJam[1]), Number(cocokJam[2]), 0, 0);
        if (hasil > sekarang) hasil.setDate(hasil.getDate() - 1);
        return hasil;
    }

    const indeksHari = HARI_ID_TOKPED[teks.toLowerCase()];
    if (indeksHari !== undefined) {
        const hasil = new Date(sekarang);
        let selisih = (sekarang.getDay() - indeksHari + 7) % 7;
        if (selisih === 0) selisih = 7; // nama hari cuma dipakai kalau BUKAN hari ini
        hasil.setDate(hasil.getDate() - selisih);
        hasil.setHours(12, 0, 0, 0);
        return hasil;
    }

    const cocokBulan = teks.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
    if (cocokBulan && BULAN_ID_TOKPED[cocokBulan[1].toLowerCase()] !== undefined) {
        const bulan = BULAN_ID_TOKPED[cocokBulan[1].toLowerCase()];
        const hasil = new Date(sekarang.getFullYear(), bulan, Number(cocokBulan[2]), 12, 0, 0);
        if (hasil > sekarang) hasil.setFullYear(hasil.getFullYear() - 1);
        return hasil;
    }

    const cocokTanggal = teks.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (cocokTanggal) {
        const [, tgl, bln, thnMentah] = cocokTanggal;
        const tahun = thnMentah.length === 2 ? Number('20' + thnMentah) : Number(thnMentah);
        return new Date(tahun, Number(bln) - 1, Number(tgl), 12, 0, 0);
    }

    const hasil = new Date();
    hasil.setDate(hasil.getDate() - 1);
    hasil.setHours(12, 0, 0, 0);
    return hasil;
}

// Chat Tokped/TikTok jarang ada dibanding WA -- klik-pindah folder tiap 30 detik (jeda lapor
// status biasa) kerasa berlebihan & bikin sidebar "berkedip" terlalu sering kalau admin pas
// pakai tab itu. Owner minta dijarangkan jadi tiap 5 menit (6 Sep 2026). Hasil terakhir per tab
// disimpan di cache ini supaya laporan status TETAP jalan tiap 30 detik seperti biasa (pakai
// data cache) -- yang dijarangkan cuma acara klik-folder-nya sendiri.
const CACHE_BELUM_DIBALAS_TOKPED = new Map(); // workspaceId -> { diperiksaPada, hasil }
const JEDA_CEK_TOKPED_MS = 5 * 60 * 1000;

/** Baca daftar kontak yang belum dibalas dari 1 tab Tokped/TikTok Seller Center -- klik folder
 * "Belum dibalas" dulu (satu-satunya cara tahu status ini di Tokped, lihat catatan di atas),
 * baca isinya, lalu klik balik ke folder semula secepatnya. Di-throttle per workspaceId (lihat
 * cache di atas), TIDAK jalan tiap kali dipanggil. */
async function bacaBelumDibalasTokped(view, workspaceId) {
    const cache = CACHE_BELUM_DIBALAS_TOKPED.get(workspaceId);
    const sekarang = Date.now();
    if (cache && (sekarang - cache.diperiksaPada) < JEDA_CEK_TOKPED_MS) {
        return cache.hasil;
    }

    try {
        const adaTombol = await view.webContents.executeJavaScript(
            `!!document.querySelector('${SELECTOR_FOLDER_BELUM_DIBALAS_TOKPED}')`
        );
        if (!adaTombol) return cache ? cache.hasil : [];

        const semulaUid = await view.webContents.executeJavaScript(`
            (function () {
                const aktif = document.querySelector('.p-menu-item-selected');
                return aktif ? aktif.getAttribute('data-uid') : null;
            })()
        `);

        await view.webContents.executeJavaScript(
            `document.querySelector('${SELECTOR_FOLDER_BELUM_DIBALAS_TOKPED}').click()`
        );
        await new Promise((resolve) => setTimeout(resolve, 800));

        const mentah = await view.webContents.executeJavaScript(SKRIP_EKSTRAK_TOKPED);
        const semuaBaris = JSON.parse(mentah);

        if (semulaUid && semulaUid !== 'menu.item_chat_v2-menu-UNREPLIED') {
            view.webContents.executeJavaScript(`
                (function () {
                    const el = document.querySelector('[data-uid="${semulaUid}"]');
                    if (el) el.click();
                })()
            `).catch(() => {});
        }

        const hasil = [];
        for (const b of semuaBaris) {
            if (!b.nama) continue;

            const waktuAbsolut = waktuMentahTokpedKeAbsolut(b.waktuMentah);
            if (!waktuAbsolut) continue;

            hasil.push({
                kontak_nama: b.nama,
                pesan_cuplikan: b.pesanCuplikan,
                waktu_pesan_masuk: waktuAbsolut.toISOString(),
            });
        }

        CACHE_BELUM_DIBALAS_TOKPED.set(workspaceId, { diperiksaPada: sekarang, hasil });
        return hasil;
    } catch {
        // Gagal baca (mis. lagi loading) -- pakai cache lama daripada dianggap kosong, supaya
        // status "belum dibalas" tidak hilang gara-gara 1x gagal.
        return cache ? cache.hasil : [];
    }
}

/** Status koneksi sederhana per tab — WA pakai tanda chat-list ada/tidak + QR ada/tidak; Shopee
 * dari URL (halaman login vs bukan); Tokped dari ada/tidaknya teks di body (halaman "kosong" =
 * gejala yang sudah didokumentasikan, biasanya perlu login/reload ulang manual). */
async function bacaStatusKoneksi(view, platform) {
    try {
        const url = view.webContents.getURL();

        if (platform === 'whatsapp') {
            const hasil = await view.webContents.executeJavaScript(`
                JSON.stringify({
                    adaChatList: document.querySelectorAll('[data-testid="cell-frame-container"]').length > 0,
                    adaQr: !!document.querySelector('canvas'),
                })
            `);
            const { adaChatList, adaQr } = JSON.parse(hasil);
            if (adaChatList) return 'terhubung';
            if (adaQr) return 'menunggu_scan';
            return 'terputus';
        }

        if (platform === 'shopee') {
            if (/seller\/login|accounts\.shopee/.test(url)) return 'perlu_login';
            return 'terhubung';
        }

        if (platform === 'tokped') {
            const panjangTeks = await view.webContents.executeJavaScript('document.body ? document.body.innerText.length : 0');
            return panjangTeks > 0 ? 'terhubung' : 'perlu_login';
        }

        return 'terhubung';
    } catch {
        return 'terputus';
    }
}

module.exports = { bacaBelumDibalasWa, bacaBelumDibalasShopee, bacaBelumDibalasTokped, bacaStatusKoneksi };
