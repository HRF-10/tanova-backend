// Escape karakter wildcard LIKE (% dan _) dari input pengguna, lalu tambahkan pola.
// Dipakai bersama operator ilike (PostgreSQL: pencarian tanpa membedakan huruf besar/kecil).
const escapeLike = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
export const startsWith = (v) => `${escapeLike(v)}%`;
export const contains = (v) => `%${escapeLike(v)}%`;
