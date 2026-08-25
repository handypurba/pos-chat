const fs = require('fs');
const os = require('os');
const path = require('path');

// Poll server tiap sekian detik nanya "ada job broadcast yang dijadwalkan dari HP?" — dibuat di
// halaman pos.hanmar.id/broadcast-wa (owner-only), dieksekusi di sini karena Baileys cuma bisa
// jalan di PC (bukan di HP). Job ditemukan lewat GET /api/broadcast-jobs/pending (server otomatis
// tandai 'diproses' begitu diambil), progres dilaporkan balik lewat POST .../lapor.
const JEDA_POLL_MS = 5000;

let sedangProses = false;
let sedangProsesPrioritas = false;

/** Tebak tipe lampiran dari ekstensi URL-nya — logika sama persis dengan handler 'pilih-lampiran'
 * di main.js (yang dipakai buat lampiran dari file lokal), supaya perlakuannya konsisten. */
function inferLampiran(url) {
    const namaFile = path.basename(new URL(url).pathname);
    const ext = path.extname(namaFile).toLowerCase().replace('.', '');
    let tipe = 'document';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) tipe = 'image';
    else if (['mp4', 'mov'].includes(ext)) tipe = 'video';
    return { namaFile, tipe, mimeType: ext === 'pdf' ? 'application/pdf' : undefined };
}

async function siapkanLampiran(url, unduhFile) {
    const info = inferLampiran(url);
    const tujuan = path.join(os.tmpdir(), `hanmar-broadcast-${Date.now()}${path.extname(info.namaFile)}`);
    await unduhFile(url, tujuan);
    return { path: tujuan, tipe: info.tipe, mimeType: info.mimeType, namaFile: info.namaFile };
}

async function eksekusiJob(job, { requestJson, unduhFile, broadcast, cfg }) {
    const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
    const lapor = (log) => requestJson('POST', `${cfg.apiBaseUrl}/api/broadcast-jobs/${job.id}/lapor`, headers, { log }).catch(() => {
        // gagal lapor (jaringan HP/server lagi jelek) — kirimnya tetap lanjut, cuma progres di HP
        // telat update; status akhir tetap coba dilaporkan di lapor() berikutnya.
    });

    let lampiran = null;
    try {
        if (job.lampiran_url) {
            lampiran = await siapkanLampiran(job.lampiran_url, unduhFile);
        }

        await broadcast.kirimBroadcast(
            job.penerima,
            job.template_pesan,
            job.opsi_jeda,
            lampiran,
            lapor,
            job.jam_operasional,
        );
    } catch (err) {
        await lapor({ status: 'gagal_total', pesanError: err.message });
    } finally {
        if (lampiran) fs.rm(lampiran.path, { force: true }, () => {});
    }
}

/** Jalankan otomatis di app.whenReady() — cukup dipanggil sekali. */
function mulaiPolling({ requestJson, unduhFile, broadcast, muatConfig }) {
    setInterval(async () => {
        // Job kirim WA butuh waktu lama (jeda anti-banned 30-90 detik/pesan) — jangan mulai job
        // baru kalau masih ada yang jalan, dan jangan ambil job kalau WA belum siap (job biarkan
        // 'menunggu' di server, dicoba lagi otomatis next interval, bukan gagal permanen).
        if (sedangProses) return;
        if (broadcast.statusKoneksi() !== 'terhubung') return;

        try {
            const cfg = muatConfig();
            if (!cfg.apiBaseUrl || !cfg.apiKey) return;

            const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
            const data = await requestJson('GET', `${cfg.apiBaseUrl}/api/broadcast-jobs/pending`, headers);
            if (!data?.job) return;

            sedangProses = true;
            await eksekusiJob(data.job, { requestJson, unduhFile, broadcast, cfg });
        } catch {
            // gagal polling (jaringan dll) — coba lagi di interval berikutnya, jangan sampai
            // melempar error yang menghentikan proses utama aplikasi
        } finally {
            sedangProses = false;
        }
    }, JEDA_POLL_MS);
}

/** Jalur PRIORITAS — loop polling TERPISAH dari mulaiPolling() di atas, khusus job TRANSAKSI
 * (WA invoice, dibuat otomatis saat kasir cetak invoice, 1 penerima per job). Dipisah supaya
 * job invoice tetap langsung dikirim walau broadcast promo sedang berjalan lama (jeda anti-ban
 * 30-90 detik/pesan) — makanya pakai flag sedangProsesPrioritas sendiri, BUKAN sedangProses,
 * dan endpoint sendiri (GET /api/broadcast-jobs/prioritas) supaya tidak ikut antre di belakang
 * job promo di server. Eksekusi pengiriman tetap lewat eksekusiJob()/kirimBroadcast() yang sama
 * — aman dipakai berbarengan dengan loop promo karena Baileys tidak butuh sock eksklusif per
 * panggilan sendMessage(). */
function mulaiPollingPrioritas({ requestJson, unduhFile, broadcast, muatConfig }) {
    setInterval(async () => {
        if (sedangProsesPrioritas) return;
        if (broadcast.statusKoneksi() !== 'terhubung') return;

        try {
            const cfg = muatConfig();
            if (!cfg.apiBaseUrl || !cfg.apiKey) return;

            const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };
            const data = await requestJson('GET', `${cfg.apiBaseUrl}/api/broadcast-jobs/prioritas`, headers);
            if (!data?.job) return;

            sedangProsesPrioritas = true;
            await eksekusiJob(data.job, { requestJson, unduhFile, broadcast, cfg });
        } catch {
            // sama seperti mulaiPolling() — gagal polling dicoba lagi interval berikutnya
        } finally {
            sedangProsesPrioritas = false;
        }
    }, JEDA_POLL_MS);
}

module.exports = { mulaiPolling, mulaiPollingPrioritas };
