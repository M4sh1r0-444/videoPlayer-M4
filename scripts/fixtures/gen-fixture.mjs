#!/usr/bin/env node
/**
 * 生成冒烟测试用的媒体夹具（幂等）。
 *
 * 目录结构按应用的扫描规则组织：
 *   <out>/library/数学/高数/[1.1.1]--函数概念.mp4   ← 根的下一级“高数”里直接有视频
 *   <out>/library/数学/高数/[1.1.2]--数列极限.mp4      => 根=科目「数学」，一级文件夹=课程
 *   <out>/library/数学/高数/[1.1.3]--函数连续.mp4
 *   <out>/library/数学/高数/第一讲.pdf                （讲义，用于匹配测试）
 *   <out>/library/数学/线代/[2.1.1]--行列式.mp4
 *
 * 用法：node scripts/fixtures/gen-fixture.mjs [--out DIR] [--force]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = path.resolve(argOf('--out', path.join(os.tmpdir(), 'vds-fixture')));
const FORCE = argv.includes('--force');
const MARKER = path.join(OUT, '.ready.json');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`${cmd} 失败(${r.status})\n${(r.stderr || r.stdout || '').slice(-1200)}`);
  }
}

function makeVideo(file, seconds, pattern) {
  if (!FORCE && fs.existsSync(file) && fs.statSync(file).size > 1024) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${pattern}=size=480x270:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-shortest',
    file,
  ]);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function main() {
  if (!FORCE && fs.existsSync(MARKER)) {
    const meta = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    const ok = meta.files.every((f) => fs.existsSync(f) && fs.statSync(f).size > 1024);
    if (ok) {
      console.log(JSON.stringify({ ...meta, reused: true }));
      return;
    }
  }

  const root = path.join(OUT, 'library', '数学');
  const gaoshu = path.join(root, '高数');
  const xiandai = path.join(root, '线代');

  const videos = [
    { file: path.join(gaoshu, '[1.1.1]--函数概念.mp4'), seconds: 40, pattern: 'testsrc2' },
    { file: path.join(gaoshu, '[1.1.2]--数列极限.mp4'), seconds: 12, pattern: 'testsrc' },
    { file: path.join(gaoshu, '[1.1.3]--函数连续.mp4'), seconds: 10, pattern: 'smptebars' },
    { file: path.join(xiandai, '[2.1.1]--行列式.mp4'), seconds: 8, pattern: 'testsrc2' },
  ];
  for (const v of videos) makeVideo(v.file, v.seconds, v.pattern);

  const docs = [
    path.join(gaoshu, '第一讲.pdf'),
    path.join(gaoshu, '第二讲 习题.txt'),
  ];
  writeText(docs[0], '%PDF-1.4\n% smoke fixture\n');
  writeText(docs[1], '第二讲 习题（夹具）\n');

  const meta = {
    root,
    subject: '数学',
    courses: { 高数: gaoshu, 线代: xiandai },
    files: [...videos.map((v) => v.file), ...docs],
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(MARKER, JSON.stringify(meta, null, 2), 'utf8');
  console.log(JSON.stringify(meta, null, 2));
}

try {
  main();
} catch (err) {
  console.error('[fixture]', err.message);
  process.exit(1);
}
