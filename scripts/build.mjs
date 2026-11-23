#!/usr/bin/env node
/**
 * 构建现代入口（P4）。
 *
 * 1. 校验 renderer/vendor 与 node_modules/package.json 一致（sync-vendor --check）；
 * 2. esbuild 把 renderer/app.js 及其 ESM 依赖打成 IIFE；
 * 3. 固定顺序拼上 marked / DOMPurify / KaTeX 的 UMD 前导，算内容哈希；
 * 4. 写 renderer/dist/app.<hash>.js，更新 renderer/index.html 的唯一入口脚本；
 * 5. 删除旧哈希产物，清理过期 bundle。
 *
 * 确定性：同一源码 + 同一 node_modules 重复构建得到同一 hash；
 * 不写时间戳，不读取 mtime。
 *
 * 用法：
 *   node scripts/build.mjs            # 构建
 *   node scripts/build.mjs --verify   # 只验证已构建产物与源码一致（不写盘）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { checkVendor, expectedVendorState } from './sync-vendor.mjs';
import { assertSingleEntry, composeBundle, injectEntry } from './build-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'renderer');
const DIST = path.join(RENDERER, 'dist');
const INDEX = path.join(RENDERER, 'index.html');
const ENTRY = path.join(RENDERER, 'app.js');
const VENDOR_ORDER = ['marked.min.js', 'dompurify.min.js', 'katex.min.js'];

const VERIFY = process.argv.includes('--verify');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sameText(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

function writeIfChanged(file, content) {
  let previous = null;
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch {
    /* 新文件 */
  }
  if (previous === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

async function bundleApp() {
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    outfile: 'app.js',
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  });
  for (const warning of result.warnings) console.warn(`[build] esbuild 警告：${warning.text}`);
  if (!result.outputFiles || !result.outputFiles[0]) throw new Error('esbuild 没有输出文件');
  return result.outputFiles[0].text;
}

function vendorVersions(manifest) {
  return VENDOR_ORDER.map((file) => {
    const lib = Object.values(manifest.libraries).find((entry) =>
      entry.files.some((f) => f.path === file),
    );
    if (!lib) throw new Error(`manifest 中找不到 ${file}`);
    return [lib.package.replace('node_modules/', ''), lib.version];
  });
}

function makeBuildInfo({ entry, sha256, bytes, appBytes, vendorBytes, manifest }) {
  const info = {
    entry,
    sha256,
    bytes,
    appBytes,
    vendorBytes,
    esbuild: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'esbuild', 'package.json'), 'utf8')).version,
    vendor: Object.fromEntries(
      Object.entries(manifest.libraries).map(([name, lib]) => [name, lib.version]),
    ),
  };
  return JSON.stringify(info, null, 2) + '\n';
}

async function main() {
  const diffs = checkVendor();
  if (diffs.length) {
    console.error('[build] vendor 校验失败：');
    for (const diff of diffs.slice(0, 20)) console.error(`  - ${diff}`);
    console.error('[build] 先运行 npm run sync-vendor');
    process.exit(1);
  }

  const { manifest } = expectedVendorState();
  const appCode = await bundleApp();
  const vendorSources = VENDOR_ORDER.map((file) => fs.readFileSync(path.join(RENDERER, 'vendor', file), 'utf8'));
  const versions = vendorVersions(manifest);
  const bundle = composeBundle({ vendorSources, appCode, versions });
  const entryName = `app.${bundle.hash}.js`;
  const entryRelative = `dist/${entryName}`;
  const entryFile = path.join(DIST, entryName);

  const indexBefore = fs.readFileSync(INDEX, 'utf8');
  const indexAfter = injectEntry(indexBefore, entryRelative);
  assertSingleEntry(indexAfter);

  const appBytes = Buffer.byteLength(appCode, 'utf8');
  const vendorBytes = vendorSources.reduce((n, code) => n + Buffer.byteLength(code, 'utf8'), 0);
  const buildInfo = makeBuildInfo({
    entry: entryRelative,
    sha256: bundle.sha256,
    bytes: Buffer.byteLength(bundle.source, 'utf8'),
    appBytes,
    vendorBytes,
    manifest,
  });

  if (VERIFY) {
    const problems = [];
    if (!fs.existsSync(entryFile)) problems.push(`缺少 ${entryRelative}`);
    else if (sha256File(entryFile) !== bundle.sha256) problems.push(`${entryRelative} 内容与源码不一致`);
    if (!sameText(fs.readFileSync(INDEX, 'utf8'), indexAfter)) problems.push('index.html 入口未更新');
    const infoFile = path.join(DIST, 'build-info.json');
    if (!fs.existsSync(infoFile) || !sameText(fs.readFileSync(infoFile, 'utf8'), buildInfo)) {
      problems.push('dist/build-info.json 与源码不一致');
    }
    if (problems.length) {
      console.error('[build] --verify 失败：');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`[build] --verify 通过：${entryRelative} (${bundle.sha256.slice(0, 12)}…)`);
    return;
  }

  fs.mkdirSync(DIST, { recursive: true });
  writeIfChanged(entryFile, bundle.source);
  writeIfChanged(path.join(DIST, 'build-info.json'), buildInfo);
  writeIfChanged(INDEX, indexAfter);

  // 清理旧哈希入口，避免 asar 里残留多份 bundle
  for (const name of fs.readdirSync(DIST)) {
    if (name === entryName) continue;
    if (/^app\.[0-9a-f]{10}\.js(\.map)?$/.test(name)) fs.rmSync(path.join(DIST, name), { force: true });
  }

  const finalScript = assertSingleEntry(fs.readFileSync(INDEX, 'utf8'));
  if (finalScript !== entryRelative || !fs.existsSync(entryFile)) {
    throw new Error(`入口自检失败：${finalScript}`);
  }

  console.log(`[build] vendor 校验通过（${versions.map(([n, v]) => `${n}@${v}`).join(' / ')}）`);
  console.log(
    `[build] ${entryRelative}  ${Buffer.byteLength(bundle.source, 'utf8')} B` +
      `（app ${appBytes} B + vendor ${vendorBytes} B）sha256=${bundle.sha256.slice(0, 12)}…`,
  );
  console.log(`[build] index.html → ${entryRelative}（现代入口 1 个脚本）`);
}

main().catch((err) => {
  console.error(`[build] 失败：${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
