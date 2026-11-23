// 生成应用图标（P4 合并 Windows + macOS）——零依赖，纯 Node
// Windows：build/icon.ico（256x256，BMP-in-ICO）+ 256 的 icon.png（--win-only 时）
// macOS：build/icon.icns（PNG-in-ICNS，ic07/08/09/10）+ icon-128/256/512/1024.png + 1024 的 icon.png
// 设计：墨绿圆角底（纵向渐变 #1a2520 → #0e1512）+ 薄荷播放三角（--accent-fill #35c7a8）
// 用法：
//   node scripts/gen-icon.js             # 两套都生成
//   node scripts/gen-icon.js --win-only  # 只生成 Windows
//   node scripts/gen-icon.js --mac-only  # 只生成 macOS（npm run icon:mac）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const WIN_ONLY = argv.includes('--win-only');
const MAC_ONLY = argv.includes('--mac-only');
if (WIN_ONLY && MAC_ONLY) {
  console.error('--win-only 与 --mac-only 不能同时使用');
  process.exit(1);
}

/* ---------- 几何 ---------- */

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function edgeDist(ax, ay, bx, by, px, py) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function insideTriangle(x, y, a, b, c) {
  const s1 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const s2 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const s3 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/* ---------- 绘制（任意尺寸，超采样抗锯齿） ---------- */

// style: 'win'（内容占画布 4%~96%，圆角 19%）或 'mac'（内容占 8%~92%，圆角 22.5% 内容宽）
function render(S, style) {
  const mac = style === 'mac';
  const SS = mac ? (S >= 512 ? 2 : 3) : 2;
  const N = S * SS;
  const inset = mac ? 0.08 : 0.04;
  const radius = mac ? N * 0.225 * 0.84 : N * 0.19;
  const tri = mac
    ? [[N * 0.41, N * 0.32], [N * 0.41, N * 0.68], [N * 0.66, N * 0.50]]
    : [[N * 0.40, N * 0.30], [N * 0.40, N * 0.70], [N * 0.68, N * 0.50]];
  const raw = Buffer.alloc(S * S * 4);

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5;
          const y = py * SS + sy + 0.5;
          if (!insideRoundedRect(x, y, N * inset, N * inset, N * (1 - inset), N * (1 - inset), radius)) continue;
          a += 1;
          const t = y / N; // 纵向渐变 #1a2520 → #0e1512
          let br = Math.round(26 + (14 - 26) * t);
          let bg = Math.round(37 + (21 - 37) * t);
          let bb = Math.round(32 + (18 - 32) * t);
          const near =
            edgeDist(tri[0][0], tri[0][1], tri[1][0], tri[1][1], x, y) ||
            edgeDist(tri[1][0], tri[1][1], tri[2][0], tri[2][1], x, y) ||
            edgeDist(tri[2][0], tri[2][1], tri[0][0], tri[0][1], x, y);
          if (insideTriangle(x, y, ...tri) || near < N * 0.015) {
            br = 53;
            bg = 199;
            bb = 168; // --accent-fill #35c7a8
          }
          r += br;
          g += bg;
          b += bb;
        }
      }
      const n = SS * SS;
      const i = (py * S + px) * 4;
      raw[i] = Math.round(r / n);
      raw[i + 1] = Math.round(g / n);
      raw[i + 2] = Math.round(b / n);
      raw[i + 3] = Math.round((a / n) * 255);
    }
  }
  return raw;
}

/* ---------- PNG 编码（RGBA8，无滤波） ---------- */

function crc32(buf) {
  let c;
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(S, raw) {
  const stride = S * 4;
  const rows = Buffer.alloc((stride + 1) * S);
  for (let y = 0; y < S; y++) {
    rows[y * (stride + 1)] = 0; // filter: None
    raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO（Windows，BMP 条目） ---------- */

function buildIco(S, raw) {
  const headerSize = 40;
  const andStride = Math.ceil(S / 32) * 4;
  const xorSize = S * S * 4;
  const andSize = andStride * S;
  const imgSize = headerSize + xorSize + andSize;
  const bmp = Buffer.alloc(imgSize);
  bmp.writeUInt32LE(40, 0); // biSize
  bmp.writeInt32LE(S, 4); // biWidth
  bmp.writeInt32LE(S * 2, 8); // biHeight = XOR + AND 两倍高
  bmp.writeUInt16LE(1, 12); // biPlanes
  bmp.writeUInt16LE(32, 14); // biBitCount
  bmp.writeUInt32LE(0, 16); // BI_RGB
  bmp.writeUInt32LE(xorSize + andSize, 20);
  for (let y = 0; y < S; y++) {
    const srcRow = (S - 1 - y) * S * 4;
    const dstRow = headerSize + y * S * 4;
    for (let x = 0; x < S; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      bmp[di] = raw[si + 2]; // B
      bmp[di + 1] = raw[si + 1]; // G
      bmp[di + 2] = raw[si]; // R
      bmp[di + 3] = raw[si + 3]; // A
    }
  }
  // AND 掩码全 0（透明度由 alpha 通道决定），Buffer.alloc 已置零
  const ico = Buffer.alloc(6 + 16 + imgSize);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 0; // 256 记为 0
  ico[7] = 0;
  ico[8] = 0;
  ico[9] = 0;
  ico.writeUInt16LE(1, 10); // planes
  ico.writeUInt16LE(32, 12); // bpp
  ico.writeUInt32LE(imgSize, 14); // bytesInRes
  ico.writeUInt32LE(6 + 16, 18); // imageOffset
  bmp.copy(ico, 22);
  return ico;
}

/* ---------- ICNS（macOS，PNG 条目） ---------- */

// 条目类型：ic07=128、ic08=256、ic09=512、ic10=1024(512@2x)
function buildIcns(pngBySize) {
  const entries = [
    ['ic07', pngBySize[128]],
    ['ic08', pngBySize[256]],
    ['ic09', pngBySize[512]],
    ['ic10', pngBySize[1024]],
  ];
  const header = Buffer.alloc(8); // 'icns' + 文件总长（文件头不是条目，不能事后覆盖）
  header.write('icns', 0, 'ascii');
  const parts = [header];
  let total = 8;
  for (const [type, png] of entries) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
    total += png.length + 8;
  }
  header.writeUInt32BE(total, 4);
  return Buffer.concat(parts, total);
}

/* ---------- 产物 ---------- */

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

if (!MAC_ONLY) {
  const S = 256;
  const ico = buildIco(S, render(S, 'win'));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  if (WIN_ONLY) {
    fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(S, render(S, 'win')));
  }
  console.log(`生成 icon.ico ${ico.length} bytes`);
}

if (!WIN_ONLY) {
  const pngBySize = {};
  for (const S of [128, 256, 512, 1024]) {
    process.stdout.write(`render mac ${S}x${S} ... `);
    const png = encodePng(S, render(S, 'mac'));
    pngBySize[S] = png;
    fs.writeFileSync(path.join(outDir, `icon-${S}.png`), png);
    console.log(`${png.length} bytes`);
  }
  fs.copyFileSync(path.join(outDir, 'icon-1024.png'), path.join(outDir, 'icon.png'));
  const icns = buildIcns(pngBySize);
  fs.writeFileSync(path.join(outDir, 'icon.icns'), icns);
  console.log(`生成 icon.icns ${icns.length} bytes + icon.png(1024) + icon-128/256/512/1024.png`);
}
