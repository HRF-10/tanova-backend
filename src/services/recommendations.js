// Rekomendasi tindakan berbasis aturan dari label hasil diagnosis AI (dipakai jika layanan AI tidak mengirim rekomendasi sendiri).
const RULES = [
  {
    match: /kalsium|calcium|tip\s?burn/i,
    text: 'Indikasi kekurangan kalsium.',
    actions: [
      'Periksa dan naikkan konsentrasi kalsium pada larutan nutrisi',
      'Jaga pH larutan di rentang 5,8 sampai 6,3 agar kalsium mudah diserap',
      'Tingkatkan sirkulasi udara agar transpirasi stabil',
    ],
  },
  {
    match: /nitrogen/i,
    text: 'Indikasi kekurangan nitrogen.',
    actions: ['Tambah nutrisi bernitrogen sesuai takaran', 'Cek EC larutan dan sesuaikan dengan fase tanaman'],
  },
  {
    match: /kalium|potassium|potasium/i,
    text: 'Indikasi kekurangan kalium.',
    actions: ['Tambah nutrisi kalium sesuai takaran', 'Periksa EC dan pH larutan'],
  },
  {
    match: /fosfor|phosph/i,
    text: 'Indikasi kekurangan fosfor.',
    actions: ['Periksa pH larutan, fosfor sulit diserap saat pH terlalu tinggi', 'Sesuaikan formula nutrisi'],
  },
  {
    match: /hama|pest|kutu|aphid|thrips/i,
    text: 'Terdeteksi indikasi serangan hama.',
    actions: ['Periksa bagian bawah daun secara langsung', 'Isolasi tanaman terdampak', 'Gunakan pengendali hayati atau insektisida nabati'],
  },
  {
    match: /jamur|fung|mildew|blight|bercak|rot|busuk|penyakit|disease/i,
    text: 'Terdeteksi indikasi penyakit pada tanaman.',
    actions: ['Buang bagian tanaman yang terinfeksi', 'Turunkan kelembapan dan perbaiki sirkulasi udara', 'Periksa kebersihan larutan dan media tanam'],
  },
  { match: /sehat|healthy|normal/i, text: 'Tanaman dalam kondisi sehat.', actions: ['Pertahankan perawatan dan jadwal nutrisi saat ini'] },
];

export function recommend(label) {
  const hit = RULES.find((r) => r.match.test(label || ''));
  if (!hit) return { recommendation: 'Lakukan pemeriksaan manual pada tanaman.', actions: ['Periksa tanaman secara langsung', 'Bandingkan dengan data sensor terbaru'] };
  return { recommendation: hit.text, actions: hit.actions };
}
