// Skrip uji simulasi manual untuk deteksi chat masuk (pantauChatWa.js) -- mock
// view.webContents.executeJavaScript supaya bisa diuji tanpa Electron/WA beneran. Proyek ini
// tidak pakai framework test JS formal (cuma `node --check` buat sintaks selama ini) -- skrip
// ini dibuat 12 Sep 2026 setelah ketahuan sendiri lewat simulasi ini bahwa 1 percobaan perbaikan
// JUSTRU merusak fitur balas-cepat (lihat riwayat commit). WAJIB dijalankan lagi kalau ada
// perubahan ke pantauChatWa.js soal deteksi belum-dibalas/kontak-terlihat -- jangan cuma percaya
// baca kode.
//
// Jalankan: node uji-deteksi-chat.js

const pantau = require('./pantauChatWa.js');

function buatMockView(urutanHasilJson) {
    let panggilan = 0;
    return {
        webContents: {
            executeJavaScript: async () => {
                const hasil = urutanHasilJson[Math.min(panggilan, urutanHasilJson.length - 1)];
                panggilan++;
                return hasil;
            },
        },
    };
}

function barisWa({ nama, sudahDibalasTitle, waktu, pesan, grup }) {
    const potongan = [
        { tag: 'SPAN', t: nama, x: nama },
        { tag: 'SPAN', t: '', x: waktu },
        { tag: 'SPAN', t: '', x: pesan },
    ];
    if (sudahDibalasTitle) potongan.push({ tag: 'TITLE', t: '', x: sudahDibalasTitle });
    return { potongan, adaIkonGrup: !!grup };
}

function barisShopee({ nama, sudahDibalas, waktu, pesan }) {
    return { nama, waktuMentah: waktu, pesanCuplikan: pesan, sudahDibalas };
}

function assert(kondisi, pesan) {
    if (!kondisi) throw new Error(pesan);
}

let gagal = 0;

async function uji(nama, fn) {
    try {
        await fn();
        console.log('OK    -', nama);
    } catch (e) {
        gagal++;
        console.log('GAGAL -', nama, '\n        ', e.message);
    }
}

(async () => {
    await uji('WA: pelanggan chat, admin balas SUPER CEPAT -> tetap jadi Lead setelah stabil', async () => {
        const view = buatMockView([
            JSON.stringify([barisWa({ nama: 'Budi', sudahDibalasTitle: null, waktu: '10:00', pesan: 'halo' })]),
            JSON.stringify([barisWa({ nama: 'Budi', sudahDibalasTitle: 'read', waktu: '10:00', pesan: 'halo, oke siap' })]),
            JSON.stringify([barisWa({ nama: 'Budi', sudahDibalasTitle: 'read', waktu: '10:00', pesan: 'halo, oke siap' })]),
        ]);
        const s1 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-1');
        assert(s1.kontakTerlihat.length === 0, 'siklus 1 (baru pertama kali) harusnya kosong');
        const s2 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-1');
        assert(s2.kontakTerlihat.length === 0, 'siklus 2 (beda dari siklus 1, belum stabil) harusnya kosong');
        const s3 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-1');
        assert(s3.kontakTerlihat.length === 1 && s3.kontakTerlihat[0].nama === 'Budi', 'siklus 3 (stabil) harusnya muncul');
        assert(s3.belumDibalas.length === 0, 'siklus 3 sudah dibalas, tidak boleh masuk belumDibalas');
    });

    await uji('WA: ADMIN chat duluan ke kontak baru -> TIDAK PERNAH jadi Lead', async () => {
        const view = buatMockView([
            JSON.stringify([barisWa({ nama: 'Toko Baru', sudahDibalasTitle: 'sent', waktu: '11:00', pesan: 'selamat siang kak' })]),
            JSON.stringify([barisWa({ nama: 'Toko Baru', sudahDibalasTitle: 'sent', waktu: '11:00', pesan: 'selamat siang kak' })]),
            JSON.stringify([barisWa({ nama: 'Toko Baru', sudahDibalasTitle: 'sent', waktu: '11:00', pesan: 'selamat siang kak' })]),
        ]);
        await pantau.bacaBelumDibalasWa(view, 'wa-uji-2');
        await pantau.bacaBelumDibalasWa(view, 'wa-uji-2');
        const s3 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-2');
        assert(s3.kontakTerlihat.length === 0, 'admin mulai duluan harusnya TIDAK PERNAH masuk kontakTerlihat');
        assert(s3.belumDibalas.length === 0, 'admin mulai duluan harusnya TIDAK PERNAH masuk belumDibalas');
    });

    await uji('WA: chat lama sempat salah baca sesaat -> tetap ditolak (waktu bukan hari ini)', async () => {
        const view = buatMockView([
            JSON.stringify([barisWa({ nama: 'Anwar', sudahDibalasTitle: null, waktu: null, pesan: null })]),
            JSON.stringify([barisWa({ nama: 'Anwar', sudahDibalasTitle: 'read', waktu: 'Senin', pesan: 'oke baik kak' })]),
            JSON.stringify([barisWa({ nama: 'Anwar', sudahDibalasTitle: 'read', waktu: 'Senin', pesan: 'oke baik kak' })]),
        ]);
        await pantau.bacaBelumDibalasWa(view, 'wa-uji-3');
        await pantau.bacaBelumDibalasWa(view, 'wa-uji-3');
        const s3 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-3');
        assert(s3.kontakTerlihat.length === 0, 'chat lama (bukan hari ini) harusnya tidak pernah masuk kontakTerlihat');
    });

    await uji('WA: grup tidak pernah jadi Lead', async () => {
        const view = buatMockView([
            JSON.stringify([barisWa({ nama: 'Grup Keluarga', sudahDibalasTitle: null, waktu: '09:00', pesan: 'halo semua', grup: true })]),
            JSON.stringify([barisWa({ nama: 'Grup Keluarga', sudahDibalasTitle: null, waktu: '09:00', pesan: 'halo semua', grup: true })]),
        ]);
        await pantau.bacaBelumDibalasWa(view, 'wa-uji-4');
        const s2 = await pantau.bacaBelumDibalasWa(view, 'wa-uji-4');
        assert(s2.kontakTerlihat.length === 0, 'grup harusnya selalu disaring dari kontakTerlihat');
        assert(s2.belumDibalas.length === 0, 'grup harusnya selalu disaring dari belumDibalas');
    });

    await uji('Shopee: admin balas/mulai duluan -> TIDAK PERNAH jadi Lead', async () => {
        const view = buatMockView([
            JSON.stringify([barisShopee({ nama: 'Toko Shopee A', sudahDibalas: true, waktu: '13:00', pesan: 'siap kak' })]),
            JSON.stringify([barisShopee({ nama: 'Toko Shopee A', sudahDibalas: true, waktu: '13:00', pesan: 'siap kak' })]),
            JSON.stringify([barisShopee({ nama: 'Toko Shopee A', sudahDibalas: true, waktu: '13:00', pesan: 'siap kak' })]),
        ]);
        await pantau.bacaBelumDibalasShopee(view, 'shopee-uji-1');
        await pantau.bacaBelumDibalasShopee(view, 'shopee-uji-1');
        const s3 = await pantau.bacaBelumDibalasShopee(view, 'shopee-uji-1');
        assert(s3.kontakTerlihat.length === 0, 'Shopee: admin mulai duluan harusnya tidak pernah jadi Lead');
    });

    await uji('Shopee: pelanggan chat -> jadi Lead setelah stabil', async () => {
        const view = buatMockView([
            JSON.stringify([barisShopee({ nama: 'Toko Shopee B', sudahDibalas: false, waktu: '14:00', pesan: 'ada strapping?' })]),
            JSON.stringify([barisShopee({ nama: 'Toko Shopee B', sudahDibalas: false, waktu: '14:00', pesan: 'ada strapping?' })]),
        ]);
        await pantau.bacaBelumDibalasShopee(view, 'shopee-uji-2');
        const s2 = await pantau.bacaBelumDibalasShopee(view, 'shopee-uji-2');
        assert(s2.kontakTerlihat.length === 1, 'Shopee: pelanggan chat & stabil harusnya jadi Lead');
        assert(s2.belumDibalas.length === 1, 'Shopee: masih belum dibalas, harus tetap ada di reminder');
    });

    console.log('\n' + (gagal === 0 ? 'SEMUA LULUS' : gagal + ' GAGAL'));
    process.exit(gagal === 0 ? 0 : 1);
})();
