import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ffmpegPlan, findFfTools, fileUrl } = require(path.join(ROOT, 'platform.js'));

const BS = String.fromCharCode(92);
const winPath = (...parts) => parts.join(BS);

test('fileUrl：Windows 盘符 + 中文/空格 + 混合斜杠', () => {
  assert.equal(fileUrl(winPath('E:', 'baidu', '数学', '[1.2.1]--x.mp4')), 'file:///E:/baidu/%E6%95%B0%E5%AD%A6/%5B1.2.1%5D--x.mp4');
  assert.equal(fileUrl('E:/baidu/x.mp4'), 'file:///E:/baidu/x.mp4');
  assert.equal(fileUrl('E:' + BS + 'My Videos' + BS + 'a b.mp4'), 'file:///E:/My%20Videos/a%20b.mp4');
});

test('fileUrl：POSIX 绝对路径不产生四斜杠', () => {
  const got = fileUrl('/Users/zhang/考研数学/第1讲.mp4');
  assert.equal(got, 'file:///Users/zhang/%E8%80%83%E7%A0%94%E6%95%B0%E5%AD%A6/%E7%AC%AC1%E8%AE%B2.mp4');
  assert.ok(!got.startsWith('file:////'));
  assert.equal(fileUrl('/Users/zhang/My Videos/a b.mp4'), 'file:///Users/zhang/My%20Videos/a%20b.mp4');
});

test('fileUrl：UNC 路径保持 host 段', () => {
  assert.equal(fileUrl('\\\\server\\share\\a b.mp4'), 'file://server/share/a%20b.mp4');
});

test('preload.js 的 fileUrl 与 platform.js 逐例一致（沙箱内不能 require 相对模块）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const match = source.match(/function fileUrl\(p\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'preload.js 应保留 fileUrl 实现');
  const preloadFileUrl = new Function(`${match[0]}; return fileUrl;`)();
  const cases = [
    winPath('E:', 'a', '数学', 'x.mp4'),
    'E:/a/x.mp4',
    '/Users/a/My Videos/x.mp4',
    '/Users/a/中文/第1讲.mp4',
    '\\\\server\\share\\x.mp4',
    'relative/x.mp4',
  ];
  for (const input of cases) assert.equal(preloadFileUrl(input), fileUrl(input), input);
});

test('ffmpegPlan：Windows 保持 where + .exe + 盘符候选', () => {
  const plan = ffmpegPlan('win32', { env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, home: 'C:\\Users\\me' });
  assert.equal(plan.finder, 'where');
  assert.equal(plan.exe, 'ffmpeg.exe');
  assert.equal(plan.probe, 'ffprobe.exe');
  assert.ok(plan.roots.includes('D:\\ffmpeg\\bin'));
  assert.ok(plan.roots.includes('C:\\ffmpeg\\bin'));
  assert.ok(plan.roots.includes('C:\\Program Files\\ffmpeg\\bin'));
  assert.ok(plan.roots.includes(winPath('C:\\Users\\me\\AppData\\Local', 'Programs', 'ffmpeg', 'bin')));
  assert.ok(plan.roots.includes(winPath('C:\\Users\\me', 'scoop', 'shims')));
});

test('ffmpegPlan：macOS/Linux 用 which + Homebrew/MacPorts，不带 .exe', () => {
  const plan = ffmpegPlan('darwin', { env: {}, home: '/Users/me' });
  assert.equal(plan.finder, 'which');
  assert.equal(plan.exe, 'ffmpeg');
  assert.equal(plan.probe, 'ffprobe');
  assert.deepEqual(plan.roots, ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']);
  assert.ok(plan.roots.every((p) => !p.endsWith('.exe')));
});

test('findFfTools：PATH 命中并返回同目录 ffprobe', () => {
  const calls = [];
  const tools = findFfTools({
    platform: 'win32',
    execFileSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      return 'C:\\tools\\ffmpeg.exe\r\nC:\\other\\ffmpeg.exe\r\n';
    },
    statSync: () => ({ isFile: () => true }),
    existsSync: (p) => p === 'C:\\tools\\ffprobe.exe',
  });
  assert.deepEqual(calls, [['where', 'ffmpeg']]);
  assert.deepEqual(tools, { ffmpeg: 'C:\\tools\\ffmpeg.exe', ffprobe: 'C:\\tools\\ffprobe.exe' });
});

test('findFfTools：PATH 失败时回退候选目录（macOS）', () => {
  const tools = findFfTools({
    platform: 'darwin',
    execFileSync: () => {
      throw new Error('not found');
    },
    statSync: (p) => ({ isFile: () => p === '/usr/local/bin/ffmpeg' }),
    existsSync: (p) => p === '/usr/local/bin/ffprobe',
  });
  assert.deepEqual(tools, { ffmpeg: '/usr/local/bin/ffmpeg', ffprobe: '/usr/local/bin/ffprobe' });
});

test('findFfTools：都没有时返回 null', () => {
  const tools = findFfTools({
    platform: 'darwin',
    execFileSync: () => {
      throw new Error('not found');
    },
    statSync: () => ({ isFile: () => false }),
    existsSync: () => false,
  });
  assert.equal(tools, null);
});

test('pathSepOf / dirNameOf：Windows、POSIX、混合、无分隔符', async () => {
  const { pathSepOf, dirNameOf } = await import('../renderer/core/path.js');
  assert.equal(pathSepOf('E:\\a\\b.mp4'), '\\');
  assert.equal(pathSepOf('/Users/a/b.mp4'), '/');
  assert.equal(pathSepOf('E:/a/b.mp4'), '/');
  assert.equal(pathSepOf('E:\\a/b.mp4'), '/');
  assert.equal(pathSepOf('plain.mp4'), '\\');
  assert.equal(dirNameOf('E:\\baidu\\数学\\[1.2.1]--x.mp4'), 'E:\\baidu\\数学');
  assert.equal(dirNameOf('/Users/a/My Videos/b.mp4'), '/Users/a/My Videos');
  assert.equal(dirNameOf('E:/a/b.mp4'), 'E:/a');
  assert.equal(dirNameOf('E:\\a/b.mp4'), 'E:/a');
  assert.equal(dirNameOf('plain.mp4'), '');
});
