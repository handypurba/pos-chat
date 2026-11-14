/** Ubah nomor telepon apa pun (0812-xxx, +62 812 xxx, 812xxx, 6281xxx) jadi format WhatsApp
 * "62812xxx" (hanya angka). Null kalau jelas bukan nomor HP yang masuk akal (terlalu pendek/panjang).
 * Dulu cuma membuang karakter non-angka, jadi "0812..." dikirim apa adanya dan dikira "bukan nomor
 * WA" padahal valid. */
function normalisasiNomor(mentah) {
    let digit = String(mentah ?? '').replace(/\D/g, '');
    if (!digit) return null;

    if (digit.startsWith('00')) digit = digit.slice(2);
    if (digit.startsWith('0')) digit = '62' + digit.slice(1);
    else if (digit.startsWith('8')) digit = '62' + digit;
    else if (digit.startsWith('620')) digit = '62' + digit.slice(3);

    if (digit.length < 9 || digit.length > 15) return null;
    return digit;
}

module.exports = { normalisasiNomor };
