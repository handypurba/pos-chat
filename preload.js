const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatHub', {
    onTampilkanLogin: (callback) => ipcRenderer.on('tampilkan-login', () => callback()),
    onLoginBerhasil: (callback) => ipcRenderer.on('login-berhasil', (_e, user) => callback(user)),
    loginChatHub: (data) => ipcRenderer.invoke('chathub-login', data),
    logoutChatHub: () => ipcRenderer.invoke('chathub-logout'),

    onDaftarWorkspace: (callback) => ipcRenderer.on('daftar-workspace', (_e, data) => callback(data)),
    onWorkspaceAktif: (callback) => ipcRenderer.on('workspace-aktif', (_e, id) => callback(id)),
    pilihWorkspace: (id) => ipcRenderer.send('pilih-workspace', id),
    renameWorkspace: (id, namaBaru) => ipcRenderer.invoke('workspace-rename', { id, namaBaru }),
    reorderWorkspace: (urutanId) => ipcRenderer.invoke('workspace-reorder', urutanId),
    reloadWorkspace: (id) => ipcRenderer.send('workspace-reload', id),
    tambahWorkspace: (data) => ipcRenderer.invoke('workspace-tambah', data),
    hapusWorkspace: (id) => ipcRenderer.invoke('workspace-hapus', id),

    onBroadcastQr: (callback) => ipcRenderer.on('broadcast-qr', (_e, dataUrl) => callback(dataUrl)),
    onBroadcastStatus: (callback) => ipcRenderer.on('broadcast-status', (_e, status) => callback(status)),
    onBroadcastNomor: (callback) => ipcRenderer.on('broadcast-nomor', (_e, nomor) => callback(nomor)),
    onBroadcastLog: (callback) => ipcRenderer.on('broadcast-log', (_e, log) => callback(log)),
    ambilPelanggan: () => ipcRenderer.invoke('ambil-pelanggan'),
    kirimBroadcast: (payload) => ipcRenderer.invoke('kirim-broadcast', payload),
    hentikanBroadcast: () => ipcRenderer.send('broadcast-berhenti'),
    logoutBroadcast: () => ipcRenderer.invoke('broadcast-logout'),

    daftarKontak: () => ipcRenderer.invoke('kontak-daftar'),
    tambahKontak: (data) => ipcRenderer.invoke('kontak-tambah', data),
    hapusKontak: (id) => ipcRenderer.invoke('kontak-hapus', id),
    pilihLampiran: () => ipcRenderer.invoke('pilih-lampiran'),
    uploadExcelKontak: () => ipcRenderer.invoke('kontak-upload-excel'),
    unduhTemplateKontak: () => ipcRenderer.invoke('kontak-unduh-template'),
    exportKontakExcel: (daftar) => ipcRenderer.invoke('kontak-export-excel', daftar),

    onNotifPesanBaru: (callback) => ipcRenderer.on('notif-pesan-baru', (_e, data) => callback(data)),
    onNotifBersih: (callback) => ipcRenderer.on('notif-bersih', (_e, workspaceId) => callback(workspaceId)),

    onBroadcastPesanMasuk: (callback) => ipcRenderer.on('broadcast-pesan-masuk', (_e, data) => callback(data)),
    muatAutoReply: () => ipcRenderer.invoke('autoreply-muat'),
    simpanAutoReply: (konfig) => ipcRenderer.invoke('autoreply-simpan', konfig),

    daftarAturanFollowUp: () => ipcRenderer.invoke('followup-daftar-aturan'),
    tambahAturanFollowUp: (data) => ipcRenderer.invoke('followup-tambah-aturan', data),
    hapusAturanFollowUp: (id) => ipcRenderer.invoke('followup-hapus-aturan', id),
    setAktifAturanFollowUp: (id, aktif) => ipcRenderer.invoke('followup-set-aktif', { id, aktif }),
    jalankanFollowUpSekarang: () => ipcRenderer.invoke('followup-jalankan-sekarang'),

    daftarGrupPelanggan: () => ipcRenderer.invoke('grup-pelanggan-daftar'),
    setGrupPelangganBanyak: (idList, grup) => ipcRenderer.invoke('grup-pelanggan-set-banyak', { idList, grup }),

    daftarRiwayat: () => ipcRenderer.invoke('riwayat-daftar'),

    daftarTemplate: () => ipcRenderer.invoke('template-daftar'),
    simpanTemplate: (data) => ipcRenderer.invoke('template-simpan', data),
    hapusTemplate: (id) => ipcRenderer.invoke('template-hapus', id),
});
