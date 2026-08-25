const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const FILE_TEMPLATE = () => path.join(app.getPath('userData'), 'template-pesan.json');

function muatSemua() {
    const file = FILE_TEMPLATE();
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
        return [];
    }
}

function simpan({ nama, isi }) {
    const daftar = muatSemua();
    const template = { id: 'template-' + Date.now(), nama, isi };
    daftar.push(template);
    fs.writeFileSync(FILE_TEMPLATE(), JSON.stringify(daftar, null, 2));
    return template;
}

function hapus(id) {
    const daftar = muatSemua().filter((t) => t.id !== id);
    fs.writeFileSync(FILE_TEMPLATE(), JSON.stringify(daftar, null, 2));
}

module.exports = { muatSemua, simpan, hapus };
