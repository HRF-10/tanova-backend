// Escape karakter wildcard LIKE (% dan _) dari input pengguna, lalu tambahkan pola.
// Catatan: whereLike milik knex memakai COLLATE utf8_bin di MySQL dan gagal pada kolom utf8mb4, jadi pakai LIKE biasa.
const escapeLike = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
export const startsWith = (v) => `${escapeLike(v)}%`;
export const contains = (v) => `%${escapeLike(v)}%`;
