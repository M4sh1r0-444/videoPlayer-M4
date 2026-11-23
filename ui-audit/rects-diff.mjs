/**
 * 布局比对脚本：比对两次 `capture-frosted.mjs --rects` 导出的元素位置尺寸，
 * 用来回答「换皮之后布局有没有被动到」。
 * 用法：node ui-audit/rects-diff.mjs <旧.json> <新.json> [--all]
 *   旧样式：node ui-audit/capture-frosted.mjs --out <目录> --css <旧 style.css> --rects old.json
 *   新样式：node ui-audit/capture-frosted.mjs --out <目录> --rects new.json
 * 差异分两档：≤ 2px 视为「去掉 1px 边框带来的微移」只出统计；> 2px 的逐条列出，
 * 其中顶栏内元素与视频画面按已知原因单独计数（分隔条改宽 / #videoArea 去边框）。
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const [beforeFile, afterFile] = args.filter((a) => !a.startsWith('--'));
if (!beforeFile || !afterFile) {
  console.error('用法：node ui-audit/rects-diff.mjs <旧.json> <新.json> [--all]');
  process.exit(1);
}
const SMALL = 2.1;
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
console.log('before:', before.css);
console.log('after :', after.css);

const tail = (key) => key.split('>').slice(-2).join('>');
const fmt = (r) => `(${r[1]},${r[2]} ${r[3]}x${r[4]})`;
let nSame = 0;
let nSmall = 0;
let nBig = 0;
const smallSignatures = new Map();
const knownCount = {};

const onlyBefore = Object.keys(before.views).filter((v) => !(v in after.views));
const onlyAfter = Object.keys(after.views).filter((v) => !(v in before.views));
if (onlyBefore.length) console.log('仅 before 有的场景:', onlyBefore.join(', '));
if (onlyAfter.length) console.log('仅 after 有的场景:', onlyAfter.join(', '));

for (const view of Object.keys(before.views)) {
  if (!(view in after.views)) continue;
  const b = new Map(before.views[view].map((r) => [r[0], r]));
  const a = new Map(after.views[view].map((r) => [r[0], r]));
  const big = [];
  let same = 0;
  let small = 0;
  for (const [key, rb] of b) {
    const ra = a.get(key);
    if (!ra) { big.push(`  - 仅旧样式有: ${tail(key)} ${fmt(rb)}`); continue; }
    const deltas = rb.slice(1).map((v, i) => Math.round((ra[i + 1] - v) * 10) / 10);
    const max = Math.max(...deltas.map(Math.abs));
    if (max === 0) { same++; continue; }
    if (max <= SMALL) {
      small++;
      const sig = deltas.map((d, i) => (d ? 'xywh'[i] + (d > 0 ? '+' : '') + d : null)).filter(Boolean).join(' ');
      if (!smallSignatures.has(sig)) smallSignatures.set(sig, []);
      smallSignatures.get(sig).push(`${view}:${tail(key)}`);
    } else {
      // 已知原因：顶栏内元素随分隔条与按钮去边框整体平移；视频画面随 #videoArea 去边框各边 +2px
      const known = /header#topbar/.test(key) ? 'topbar' : /#videoArea/.test(key) ? 'video' : null;
      if (known) { knownCount[known] = (knownCount[known] || 0) + 1; continue; }
      big.push(`  ~ ${tail(key)}  ${fmt(rb)} -> ${fmt(ra)}   [Δ ${deltas.map((d, i) => (d ? 'xywh'[i] + (d > 0 ? '+' : '') + d : '')).filter(Boolean).join(' ')}]`);
    }
  }
  for (const [key, ra] of a) {
    if (!b.has(key)) big.push(`  + 仅新样式有: ${tail(key)} ${fmt(ra)}`);
  }
  nSame += same;
  nSmall += small;
  nBig += big.length;
  console.log(`\n[${view}] 元素 ${b.size}/${a.size}：一致 ${same}，微移(≤2px) ${small}，明显差异 ${big.length}`);
  for (const line of big) console.log(line);
}
console.log(`\n合计：一致 ${nSame}，微移 ${nSmall}，明显差异 ${nBig}`);
console.log(`归入已知原因：顶栏内 ${knownCount.topbar || 0} 处，视频画面 ${knownCount.video || 0} 处`);
console.log('\n微移按「位移特征 → 个数」统计：');
for (const [sig, list] of [...smallSignatures].sort((x, y) => y[1].length - x[1].length)) {
  console.log(`  ${sig || '(亚像素)'}: ${list.length}${ALL ? '  ' + list.slice(0, 12).join(' | ') : ''}`);
}
