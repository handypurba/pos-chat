const { BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Pemantau Ulasan Tokopedia (TikTok Shop by Tokopedia) untuk POS Chat.
 * Berjalan otomatis di latar belakang (hidden BrowserWindow) menggunakan sesi login
 * persist:tokped-dlp / persist:tokped-hf yang aktif di laptop karyawan.
 * Mengekstrak ulasan bintang 1, 2, 3 dalam 14 hari terakhir dan melaporkannya
 * ke server Hanmar POS (pos.hanmar.id).
 *
 * Jadwal otomatis: Setiap jam 10 pagi pada hari kerja (Senin - Sabtu).
 */

const cachePath = path.join(app ? app.getPath('userData') : __dirname, 'ulasan-cache.json');

let riwayatUlasanTerakhir = [];
let sedangScanning = false;
let terakhirScanPada = null;
let statusTerakhir = 'Belum pernah dipindai';
let tanggalScanOtomatisTerakhir = null;

// Muat cache saat startup
try {
    if (fs.existsSync(cachePath)) {
        const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (c.statusTerakhir) statusTerakhir = c.statusTerakhir;
        if (c.terakhirScanPada) terakhirScanPada = new Date(c.terakhirScanPada);
        if (Array.isArray(c.riwayatUlasanTerakhir)) riwayatUlasanTerakhir = c.riwayatUlasanTerakhir;
        if (c.tanggalScanOtomatisTerakhir) tanggalScanOtomatisTerakhir = c.tanggalScanOtomatisTerakhir;
    }
} catch (e) {}

function simpanCache() {
    try {
        fs.writeFileSync(cachePath, JSON.stringify({
            statusTerakhir,
            terakhirScanPada: terakhirScanPada ? terakhirScanPada.toISOString() : null,
            riwayatUlasanTerakhir,
            tanggalScanOtomatisTerakhir,
        }, null, 2), 'utf8');
    } catch (e) {}
}

function tentukanShopNama(ws) {
    const nama = (ws.nama || '').toUpperCase();
    if (nama.includes('HF')) return 'Tokped HF';
    if (nama.includes('DLP')) return 'Tokped DLP';
    return ws.nama || 'Tokped DLP';
}

/**
 * Scan ulasan untuk 1 workspace Tokopedia.
 */
async function scanUlasanWorkspace(ws, UA_CHROME) {
    return new Promise((resolve) => {
        let win = null;
        let timeoutTimer = null;
        let isResolved = false;

        const shopNama = tentukanShopNama(ws);

        const cleanup = (hasil) => {
            if (isResolved) return;
            isResolved = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (win && !win.isDestroyed()) {
                try {
                    win.destroy();
                } catch (e) {}
            }
            resolve(hasil);
        };

        // Timeout maksimal 25 detik agar tidak menggantung
        timeoutTimer = setTimeout(() => {
            console.log(`[UlasanTokped] Scan workspace ${ws.nama} timeout.`);
            cleanup({ workspace_id: ws.id, shop_nama: shopNama, ulasan: [], status: 'timeout' });
        }, 25000);

        try {
            win = new BrowserWindow({
                show: false,
                width: 1280,
                height: 900,
                webPreferences: {
                    partition: `persist:${ws.id}`,
                    contextIsolation: true,
                    nodeIntegration: false,
                }
            });

            if (UA_CHROME) {
                win.webContents.setUserAgent(UA_CHROME);
            }

            win.webContents.on('did-finish-load', async () => {
                const curUrl = win.webContents.getURL();
                // Jika redirect ke login, berarti belum login di tab ini
                if (curUrl.includes('/account/login') || curUrl.includes('/login')) {
                    console.log(`[UlasanTokped] Workspace ${ws.nama} (${shopNama}) belum login.`);
                    return cleanup({ workspace_id: ws.id, shop_nama: shopNama, ulasan: [], status: 'belum_login' });
                }

                // Beri waktu 5 detik agar React SPA selesai merender komponen dan data
                await new Promise((r) => setTimeout(r, 5000));
                if (win.isDestroyed()) return;

                try {
                    const hasilEkstrak = await win.webContents.executeJavaScript(`
                        (function() {
                            const daftar = [];
                            
                            // 1. Cek dari window internal data atau global state jika ada
                            if (window.__lastReviewApiData && Array.isArray(window.__lastReviewApiData.data?.review_list)) {
                                window.__lastReviewApiData.data.review_list.forEach(r => {
                                    daftar.push({
                                        review_id: String(r.id || r.review_id || ''),
                                        order_sn: String(r.order_id || r.order_sn || ''),
                                        buyer_username: r.user_name || r.buyer_name || 'Pembeli Tokopedia',
                                        rating_star: parseInt(r.rating || r.star || 0),
                                        comment: r.content || r.comment || '',
                                        product_name: r.product_name || r.sku_name || '',
                                        review_time: r.create_time ? new Date(r.create_time * (r.create_time > 1e11 ? 1 : 1000)).toISOString() : null,
                                        reply: r.reply_content || r.seller_reply || null,
                                    });
                                });
                            }

                            // 2. Ekstrak dari DOM (Pulse Design System / TikTok Shop Seller Center table/cards)
                            if (daftar.length === 0) {
                                const barisEls = document.querySelectorAll(
                                    '.pulse-table-row, .arco-table-row, tr[data-row-key], [class*="review-item"], [class*="rating-item"], [data-testid*="review"]'
                                );

                                barisEls.forEach((baris, idx) => {
                                    try {
                                        let star = 0;
                                        const filledStars = baris.querySelectorAll(
                                            '.pulse-rate-star-full, .arco-rate-star-full, [class*="star"][class*="fill"], [class*="star"][class*="full"], svg[class*="active"]'
                                        );
                                        if (filledStars.length > 0) {
                                            star = filledStars.length;
                                        } else {
                                            const rateEl = baris.querySelector('[aria-label*="star"], [aria-label*="bintang"], [class*="rate"], [class*="star"]');
                                            if (rateEl) {
                                                const label = rateEl.getAttribute('aria-label') || rateEl.innerText || '';
                                                const m = label.match(/(\\d)/);
                                                if (m) star = parseInt(m[1]);
                                            }
                                        }

                                        // Hanya ambil bintang 1, 2, 3
                                        if (star < 1 || star > 3) return;

                                        let buyer = '';
                                        const buyerEl = baris.querySelector('[class*="user"], [class*="buyer"], [class*="customer"], [class*="name"]');
                                        if (buyerEl) buyer = buyerEl.innerText.trim();

                                        let comment = '';
                                        const commentEl = baris.querySelector('[class*="comment"], [class*="content"], [class*="desc"], [class*="text"], p');
                                        if (commentEl) comment = commentEl.innerText.trim();

                                        let product = '';
                                        const prodEl = baris.querySelector('[class*="product"], [class*="goods"], [class*="title"], [class*="sku"]');
                                        if (prodEl) product = prodEl.innerText.trim();

                                        let orderSn = '';
                                        const orderEl = baris.querySelector('[class*="order"], a[href*="order"]');
                                        if (orderEl) {
                                            const mOrder = (orderEl.innerText || orderEl.href).match(/\\d{15,22}/);
                                            if (mOrder) orderSn = mOrder[0];
                                        }

                                        let reviewTime = null;
                                        const timeEl = baris.querySelector('time, [class*="time"], [class*="date"]');
                                        if (timeEl) {
                                            reviewTime = timeEl.innerText.trim() || timeEl.getAttribute('datetime');
                                        }

                                        let reply = null;
                                        const replyEl = baris.querySelector('[class*="reply"], [class*="seller-response"]');
                                        if (replyEl) reply = replyEl.innerText.trim();

                                        if (comment || buyer) {
                                            daftar.push({
                                                review_id: orderSn ? ('order-' + orderSn) : ('dom-' + idx + '-' + Date.now()),
                                                order_sn: orderSn,
                                                buyer_username: buyer || 'Pembeli Tokopedia',
                                                rating_star: star,
                                                comment: comment,
                                                product_name: product,
                                                review_time: reviewTime,
                                                reply: reply,
                                            });
                                        }
                                    } catch (e) {}
                                });
                            }

                            return daftar;
                        })()
                    `);

                    const valid = (hasilEkstrak || []).map((u) => ({
                        marketplace: 'tokopedia',
                        shop_nama: shopNama,
                        review_id: u.review_id || ('tokped-' + Math.random().toString(36).substring(2, 10)),
                        order_sn: u.order_sn || null,
                        buyer_username: u.buyer_username || 'Pembeli Tokopedia',
                        rating_star: u.rating_star || 1,
                        comment: u.comment || '',
                        product_name: u.product_name || null,
                        review_time: u.review_time || new Date().toISOString(),
                        reply: u.reply || null,
                    }));

                    console.log(`[UlasanTokped] Workspace ${ws.nama} (${shopNama}): ditemukan ${valid.length} ulasan bintang 1-3.`);
                    cleanup({
                        workspace_id: ws.id,
                        shop_nama: shopNama,
                        ulasan: valid,
                        status: 'berhasil'
                    });
                } catch (e) {
                    console.error(`[UlasanTokped] Error JS ekstrak di ${ws.nama}:`, e.message);
                    cleanup({ workspace_id: ws.id, shop_nama: shopNama, ulasan: [], status: 'error_ekstrak' });
                }
            });

            win.loadURL('https://seller-id.tokopedia.com/product/rating').catch((e) => {
                console.error(`[UlasanTokped] Load error ${ws.nama}:`, e.message);
                cleanup({ workspace_id: ws.id, shop_nama: shopNama, ulasan: [], status: 'gagal_load' });
            });
        } catch (err) {
            console.error(`[UlasanTokped] Inisialisasi window gagal:`, err);
            cleanup({ workspace_id: ws.id, shop_nama: shopNama, ulasan: [], status: 'error' });
        }
    });
}

/**
 * Scan semua workspace Tokopedia yang terkonfigurasi di POS Chat.
 */
async function scanSemuaUlasanTokped(workspaces, UA_CHROME) {
    if (sedangScanning) {
        console.log('[UlasanTokped] Scan sedang berjalan, dilewati.');
        return { ulasan: riwayatUlasanTerakhir, status: 'sedang_berjalan' };
    }

    sedangScanning = true;
    statusTerakhir = 'Sedang memindai ulasan Tokopedia...';

    const semuaUlasan = [];
    const ringkasanToko = [];

    try {
        const tokpedWorkspaces = workspaces.filter((w) => {
            const id = (w.id || '').toLowerCase();
            const url = (w.url || '').toLowerCase();
            return w.tipe === 'web' && (id.startsWith('tokped') || url.includes('tokopedia'));
        });

        if (tokpedWorkspaces.length === 0) {
            statusTerakhir = 'Tidak ada tab Tokopedia terpasang.';
            sedangScanning = false;
            return { ulasan: [], status: statusTerakhir };
        }

        for (const ws of tokpedWorkspaces) {
            const hasil = await scanUlasanWorkspace(ws, UA_CHROME);
            ringkasanToko.push(`${hasil.shop_nama}: ${hasil.status} (${hasil.ulasan.length} ulasan)`);
            if (hasil.ulasan && hasil.ulasan.length > 0) {
                semuaUlasan.push(...hasil.ulasan);
            }
        }

        riwayatUlasanTerakhir = semuaUlasan;
        terakhirScanPada = new Date();
        statusTerakhir = `Selesai dipindai (${ringkasanToko.join(', ')}). Total ${semuaUlasan.length} ulasan bintang 1-3.`;
        simpanCache();
        console.log(`[UlasanTokped] ${statusTerakhir}`);
    } catch (err) {
        console.error('[UlasanTokped] Gagal scan ulasan:', err);
        statusTerakhir = 'Gagal memindai: ' + (err.message || 'Error tidak diketahui');
        simpanCache();
    } finally {
        sedangScanning = false;
    }

    return {
        ulasan: semuaUlasan,
        terakhirScanPada,
        status: statusTerakhir,
    };
}

function ambilUlasanTerbaru() {
    return riwayatUlasanTerakhir;
}

function ambilTanggalScanOtomatis() {
    return tanggalScanOtomatisTerakhir;
}

function setTanggalScanOtomatis(tgl) {
    tanggalScanOtomatisTerakhir = tgl;
    simpanCache();
}

function ambilStatusScan() {
    return {
        sedangScanning,
        terakhirScanPada: terakhirScanPada ? terakhirScanPada.toLocaleTimeString('id-ID') : null,
        status: statusTerakhir,
        jumlahUlasan: riwayatUlasanTerakhir.length,
        jadwalOtomatis: 'Setiap jam 10:00 WIB pada hari kerja (Senin - Sabtu)',
    };
}

module.exports = {
    scanSemuaUlasanTokped,
    ambilUlasanTerbaru,
    ambilStatusScan,
    ambilTanggalScanOtomatis,
    setTanggalScanOtomatis,
};
