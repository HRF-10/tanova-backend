import { randomBytes } from 'node:crypto';

// Mencetak tiga nilai acak siap tempel ke file .env
const secret = () => randomBytes(48).toString('hex');
console.log(`Salin tiga baris ini ke file .env (ganti baris lama dengan nama yang sama):

JWT_SECRET=${secret()}
JWT_REFRESH_SECRET=${secret()}
CREDENTIAL_ENCRYPTION_KEY=${secret()}

Tiga nilai ini harus BERBEDA satu sama lain dan dirahasiakan. Jangan diunggah ke Git atau dibagikan.`);
