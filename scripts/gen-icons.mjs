// Generates the PWA icon set with no external dependencies.
// Draws a 270-degree gauge ring (the app's motif) and encodes RGBA -> PNG
// using Node's built-in zlib. Run via `npm run gen:icons`.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../public/", import.meta.url);
mkdirSync(OUT, { recursive: true });

/* ---- minimal PNG encoder (8-bit RGBA, no interlace) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, y * w * 4 + w * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/* ---- drawing ---- */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function gradient(stops, f) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (f <= p1) return mix(c0, c1, clamp01((f - p0) / (p1 - p0 || 1)));
  }
  return stops[stops.length - 1][1];
}

function draw(size, ringFrac) {
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const cx = w / 2, cy = h / 2;
  const R = (size / 2) * ringFrac; // ring centerline radius
  const th = size * 0.085; // ring thickness
  const bgTop = hex("#0B1322"), bgBot = hex("#060A12"), track = hex("#1B273E");
  const accent = [
    [0, hex("#1D4ED8")],
    [0.55, hex("#38BDF8")],
    [1, hex("#93E0FF")],
  ];
  const progress = 0.66;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let col = mix(bgTop, bgBot, y / h);
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const band = Math.abs(dist - R);
      // angle from 12 o'clock, clockwise, 0..360
      let ang = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      const inSweep = ang >= 45 && ang <= 315; // 270deg arc, gap at bottom
      const edge = th * 0.5 - band; // >0 inside the ring band
      if (inSweep && edge > -1.2) {
        const f = (ang - 45) / 270;
        const aa = clamp01(edge + 0.6); // 1px soft edge
        const c = f <= progress ? gradient(accent, f / progress) : track;
        col = mix(col, c, aa);
      }
      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = 255;
    }
  }
  return encodePNG(w, h, buf);
}

const files = [
  ["pwa-192x192.png", 192, 0.72],
  ["pwa-512x512.png", 512, 0.72],
  ["maskable-512x512.png", 512, 0.58], // extra padding for the maskable safe zone
  ["apple-touch-icon-180x180.png", 180, 0.72],
  ["favicon-64x64.png", 64, 0.72],
];
for (const [name, size, frac] of files) {
  writeFileSync(new URL(name, OUT), draw(size, frac));
  console.log("wrote", name);
}
