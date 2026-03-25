const fs = require('fs');
const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(name, data) {
  const nb = Buffer.from(name, 'ascii');
  const combined = Buffer.concat([nb, data]);
  const crc = crc32(combined);
  const out = Buffer.alloc(4 + 4 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  nb.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function makePng(size) {
  const corner = 28 / 128 * size;

  function sdf(x, y) {
    const qx = Math.abs(x - size / 2) - (size / 2 - corner);
    const qy = Math.abs(y - size / 2) - (size / 2 - corner);
    return Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - corner + Math.min(Math.max(qx, qy), 0);
  }

  const ops = [0.35, 0.55, 0.75, 1, 1, 1, 0.75, 0.55, 0.35];
  const hts = [20, 40, 60, 80, 92, 80, 60, 40, 20].map(h => h / 128 * size);
  const barW = 7 / 128 * size;
  const barGap = 11 / 128 * size;
  const startX = 18 / 128 * size;
  const dcx = 98 / 128 * size, dcy = 98 / 128 * size;
  const dr = 18 / 128 * size, ir = 8 / 128 * size;

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = sdf(px, py);
      const bgA = Math.round(255 * Math.max(0, Math.min(1, 0.5 - d)));
      if (bgA === 0) continue;

      const t = (x + y) / (2 * size);
      let r = 0x7C + (0x4F - 0x7C) * t;
      let g = 0x6F + (0x46 - 0x6F) * t;
      let b = 0xFF + (0xE5 - 0xFF) * t;

      // inner glow
      const gd = Math.sqrt(((px / size) - 0.3) ** 2 + ((py / size) - 0.2) ** 2) / 0.7;
      const gl = Math.max(0, 1 - gd) * 0.18;
      r = Math.min(255, r + 255 * gl);
      g = Math.min(255, g + 255 * gl);
      b = Math.min(255, b + 255 * gl);

      // waveform bars
      for (let i = 0; i < 9; i++) {
        const bx = startX + i * barGap;
        const bh = hts[i], bt = (size - bh) / 2;
        const br = barW / 2;
        const dx = Math.abs(px - (bx + barW / 2)) - (barW / 2 - br);
        const dy = Math.abs(py - (bt + bh / 2)) - (bh / 2 - br);
        const bd = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) - br;
        if (bd < 1.5) {
          const a = Math.max(0, Math.min(1, 1 - bd)) * ops[i];
          r = r * (1 - a) + 255 * a;
          g = g * (1 - a) + 255 * a;
          b = b * (1 - a) + 255 * a;
        }
      }

      // red record dot
      const dd = Math.sqrt((px - dcx) ** 2 + (py - dcy) ** 2);
      if (dd < dr + 1.5) {
        const gt = Math.max(0, 1 - dd / dr);
        const rr = 0xE8 + (0xFF - 0xE8) * gt;
        const rg = 0x29 + (0x6B - 0x29) * gt;
        const rb = 0x4C + (0x8A - 0x4C) * gt;
        const da = Math.max(0, Math.min(1, dr + 1 - dd));
        r = r * (1 - da) + rr * da;
        g = g * (1 - da) + rg * da;
        b = b * (1 - da) + rb * da;
      }
      if (dd < ir + 1) {
        const wa = Math.max(0, Math.min(1, ir + 0.5 - dd));
        r = r * (1 - wa) + 255 * wa;
        g = g * (1 - wa) + 255 * wa;
        b = b * (1 - wa) + 255 * wa;
      }

      const o = 1 + x * 4;
      row[o] = Math.round(r);
      row[o + 1] = Math.round(g);
      row[o + 2] = Math.round(b);
      row[o + 3] = bgA;
    }
    rows.push(row);
  }

  const raw = Buffer.concat(rows);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;

  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync('icons', { recursive: true });
for (const s of [16, 48, 128]) {
  fs.writeFileSync(`icons/icon${s}.png`, makePng(s));
  console.log(`icon${s}.png done`);
}
