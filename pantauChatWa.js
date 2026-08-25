// Baca status "sudah/belum dibalas" dari chat list WhatsApp Web, dan status koneksi sederhana
// tiap tab (WA/Shopee/Tokped) — dipakai main.js buat lapor berkala ke pos.hanmar.id (lihat
// ChatHubStatusController). Riset struktur DOM WA dilakukan manual (Agustus 2026): tiap baris
// kontak = [data-testid="cell-frame-container"]; kalau ada ikon status kirim/dibaca (title
// mengandung "read"/"check"/dst) di baris itu, berarti pesan TERAKHIR dikirim OLEH kita (sudah
// dibalas) — kalau tidak ada, pesan terakhir MASUK dari lawan chat (belum dibalas). Shopee & Tokped
// TIDAK diriset sedetail ini (sesi test tidak stabil / halaman sering kosong) — cuma status
// koneksi sederhana dulu, lihat catatan di proyek-monitoring-chathub.md.

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

module.exports = { bacaBelumDibalasWa, bacaStatusKoneksi };
