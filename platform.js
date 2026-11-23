'use strict';

/**
 * 平台适配层（P4）：把 mac/ 中验证过的平台差异收敛到根目录。
 *
 * 主进程 require 本文件；preload 运行在 Electron 沙箱里，不能 require 相对模块，
 * 因此 preload 保留同一份 fileUrl 实现，test/platform.test.mjs 会逐例比对两者输出。
 * 渲染层的 sourceDir 分隔符推断在 renderer/core/path.js（纯 ESM，不依赖 Node）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 返回目标平台的 ffmpeg 查找计划（纯数据，便于单测）。
 * Windows 保持 v0.4.4 的 where + 盘符候选；macOS/Linux 用 which + Homebrew/MacPorts。
 */
function ffmpegPlan(platform = process.platform, { env = process.env, home = os.homedir() } = {}) {
  const win = platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const roots = win
    ? [
        'D:\\ffmpeg\\bin',
        'C:\\ffmpeg\\bin',
        'C:\\Program Files\\ffmpeg\\bin',
        join(env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin'),
        join(home, 'scoop', 'shims'),
      ]
    : [
        '/opt/homebrew/bin', // Apple Silicon Homebrew
        '/usr/local/bin', // Intel Homebrew
        '/opt/local/bin', // MacPorts
        '/usr/bin',
      ];
  return {
    platform,
    win,
    exe: win ? 'ffmpeg.exe' : 'ffmpeg',
    probe: win ? 'ffprobe.exe' : 'ffprobe',
    finder: win ? 'where' : 'which',
    finderArg: 'ffmpeg',
    roots,
    join,
  };
}

/**
 * 查找 ffmpeg / ffprobe：PATH → 常见安装路径；找不到返回 null（相关功能自动降级）。
 * 依赖可注入，单测不触碰真实文件系统。
 */
function findFfTools(options = {}) {
  const plan = ffmpegPlan(options.platform || process.platform, options);
  const run = options.execFileSync || execFileSync;
  const stat = options.statSync || fs.statSync;
  const exists = options.existsSync || fs.existsSync;
  const candidates = [];

  try {
    const out = run(plan.finder, [plan.finderArg], { encoding: 'utf8', windowsHide: true });
    const first = String(out)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first) candidates.push(first);
  } catch {
    /* PATH 里没有 */
  }
  for (const root of plan.roots) candidates.push(plan.join(root, plan.exe));

  for (const candidate of candidates) {
    try {
      if (!stat(candidate).isFile()) continue;
      const probe = plan.join(path[plan.win ? 'win32' : 'posix'].dirname(candidate), plan.probe);
      if (exists(probe)) return { ffmpeg: candidate, ffprobe: probe };
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/**
 * 文件路径 → file:// URL。
 * Windows 盘符保留冒号；POSIX 绝对路径只补 file://（避免 file:////Users/...）；
 * UNC（\\server\share）用 file://server/share。
 */
function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  const prefix = norm.startsWith('//') ? 'file:' : norm.startsWith('/') ? 'file://' : 'file:///';
  const parts = norm.split('/');
  return (
    prefix +
    parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/')
  );
}

module.exports = { ffmpegPlan, findFfTools, fileUrl };
