// Ghép nhiều ảnh PNG thành một tờ xem nhanh (contact sheet). Thuần Node (zlib), không cần ImageMagick.
// Hỗ trợ PNG 8 bit, không xen dòng, kiểu màu xám, RGB, bảng màu, RGBA (đủ cho ảnh Slides API trả về).
import zlib from "node:zlib";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function decodePng(buf) {
  let p = 8, w, h, depth, type, inter, palette; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; inter = data[12]; }
    else if (kind === "PLTE") palette = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || inter) throw new Error("PNG không hỗ trợ (cần 8 bit, không xen dòng)");
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
  const px = Buffer.alloc(w * h * ch), out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 0xff;
    }
  }
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    if (type === 3) { const k = px[s] * 3; out[i * 3] = palette[k]; out[i * 3 + 1] = palette[k + 1]; out[i * 3 + 2] = palette[k + 2]; }
    else if (ch <= 2) { out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = px[s]; }
    else { const al = ch === 4 ? px[s + 3] / 255 : 1; for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round(px[s + k] * al + 255 * (1 - al)); }
  }
  return { w, h, rgb: out };
}

export function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (kind, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Ghép ảnh thành lưới `columns` cột, mỗi ô rộng `cellW` px, lề 8 px, nền xám nhạt. */
export function contactSheet(pngBuffers, { columns = 4, cellW = 400, gap = 8 } = {}) {
  const imgs = pngBuffers.map(decodePng);
  const cellH = Math.round(cellW * (imgs[0].h / imgs[0].w));
  const rows = Math.ceil(imgs.length / columns);
  const W = columns * cellW + (columns + 1) * gap, H = rows * cellH + (rows + 1) * gap;
  const out = Buffer.alloc(W * H * 3, 0xdd);
  imgs.forEach((im, i) => {
    const ox = gap + (i % columns) * (cellW + gap), oy = gap + Math.floor(i / columns) * (cellH + gap);
    for (let y = 0; y < cellH; y++) {
      const sy = Math.min(im.h - 1, Math.floor((y * im.h) / cellH));
      for (let x = 0; x < cellW; x++) {
        const sx = Math.min(im.w - 1, Math.floor((x * im.w) / cellW));
        im.rgb.copy(out, ((oy + y) * W + ox + x) * 3, (sy * im.w + sx) * 3, (sy * im.w + sx) * 3 + 3);
      }
    }
  });
  return encodePng(W, H, out);
}
