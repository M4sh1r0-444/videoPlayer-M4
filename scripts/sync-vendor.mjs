#!/usr/bin/env node
/**
 * vendor 同步与校验（P4）。
 *
 * 从本地 node_modules 复制固定版本的 marked / DOMPurify / KaTeX 到 renderer/vendor/，
 * 并写入 manifest.json（版本 + sha256）与 README.md。不联网。
 *
 * 用法：
 *   node scripts/sync-vendor.mjs           # 同步（默认；文件未变则不重写）
 *   node scripts/sync-vendor.mjs --check   # 只校验，漂移时退出码 1（build 前置检查）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'renderer', 'vendor');

/**
 * 每个库的同步清单。
 * source 相对 node_modules/<pkg>/；target 相对 renderer/vendor/。
 * probe 用来防止 package.json / node_modules / 产物三者版本漂移。
 */
export const VENDOR_SPECS = [
  {
    pkg: 'marked',
    files: [
      {
        source: 'lib/marked.umd.js',
        target: 'marked.min.js',
        probe: (text, version) => text.includes(`marked v${version}`),
      },
    ],
  },
  {
    pkg: 'dompurify',
    files: [
      {
        source: 'dist/purify.min.js',
        target: 'dompurify.min.js',
        probe: (text, version) => text.includes(`DOMPurify ${version}`),
      },
    ],
  },
  {
    pkg: 'katex',
    files: [
      {
        source: 'dist/katex.min.js',
        target: 'katex.min.js',
        probe: (text, version) => text.includes(`version:"${version}"`),
      },
      {
        source: 'dist/katex.min.css',
        target: 'katex.min.css',
        probe: null,
      },
    ],
    fonts: { source: 'dist/fonts', ext: '.woff2' },
  },
];

const MANIFEST_PATH = path.join(VENDOR_DIR, 'manifest.json');
const README_PATH = path.join(VENDOR_DIR, 'README.md');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function sameBuffer(a, b) {
  return !!a && !!b && a.length === b.length && a.equals(b);
}

/**
 * 计算 vendor 的期望状态（不写盘）：manifest + 每个目标文件的 Buffer。
 * check / sync / 单测共用，保证三者口径一致。
 */
export function expectedVendorState() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const libraries = {};
  const files = new Map();
  let fonts = { count: 0, bytes: 0, digest: '', files: [] };

  for (const spec of VENDOR_SPECS) {
    const pinned = pkg.devDependencies?.[spec.pkg];
    if (!pinned || !/^\d+\.\d+\.\d+$/.test(pinned)) {
      throw new Error(`package.json 必须固定 ${spec.pkg} 的精确版本，当前为 ${JSON.stringify(pinned)}`);
    }
    const pkgDir = path.join(ROOT, 'node_modules', spec.pkg);
    const installed = readJson(path.join(pkgDir, 'package.json'));
    if (installed.version !== pinned) {
      throw new Error(`${spec.pkg} 版本漂移：package.json=${pinned}，node_modules=${installed.version}`);
    }
    const entry = { version: pinned, license: installed.license || '', package: `node_modules/${spec.pkg}`, files: [] };
    for (const file of spec.files) {
      const sourcePath = path.join(pkgDir, file.source);
      const buf = fs.readFileSync(sourcePath);
      if (file.probe) {
        const text = buf.toString('utf8');
        if (!file.probe(text, pinned)) {
          throw new Error(`${spec.pkg}@${pinned} 的 ${file.source} 未找到版本标记，拒绝同步`);
        }
      }
      files.set(file.target, buf);
      entry.files.push({ path: file.target, bytes: buf.length, sha256: sha256(buf) });
    }
    if (spec.fonts) {
      const fontsDir = path.join(pkgDir, spec.fonts.source);
      const names = fs
        .readdirSync(fontsDir)
        .filter((name) => name.endsWith(spec.fonts.ext))
        .sort();
      if (!names.length) throw new Error(`${spec.pkg} 的 ${spec.fonts.source} 下没有 ${spec.fonts.ext} 字体`);
      const fontEntries = names.map((name) => {
        const buf = fs.readFileSync(path.join(fontsDir, name));
        files.set(`fonts/${name}`, buf);
        return { name: `fonts/${name}`, bytes: buf.length, sha256: sha256(buf) };
      });
      fonts = {
        count: fontEntries.length,
        bytes: fontEntries.reduce((n, f) => n + f.bytes, 0),
        digest: sha256(fontEntries.map((f) => `${f.name}\0${f.sha256}`).join('\n')),
        files: fontEntries,
      };
    }
    libraries[spec.pkg] = entry;
  }

  // 校验 katex.min.css 引用的每个 woff2 都在同步清单里（字体漏拷会在运行时静默回退）
  const css = files.get('katex.min.css')?.toString('utf8') || '';
  const fontNames = new Set(fonts.files.map((f) => f.name.replace(/^fonts\//, '')));
  for (const match of css.matchAll(/fonts\/([^)"']+\.woff2)/g)) {
    if (!fontNames.has(match[1])) throw new Error(`katex.min.css 引用了未同步的字体：${match[1]}`);
  }

  const manifest = {
    schema: 1,
    generator: 'scripts/sync-vendor.mjs',
    source: 'node_modules',
    note: '本目录由脚本同步；版本与 node_modules/package.json 固定，禁止手改。不写时间戳以保证重复同步字节一致。',
    libraries,
    fonts,
  };

  return { packageJson: pkg, manifest, files };
}

/** 校验 renderer/vendor 与 node_modules 是否一致；返回差异列表（空数组 = 通过） */
export function checkVendor() {
  const { manifest, files } = expectedVendorState();
  const diffs = [];

  for (const [relative, expected] of files) {
    const target = path.join(VENDOR_DIR, relative);
    const actual = readIfExists(target);
    if (actual === null) diffs.push(`缺少 ${relative}`);
    else if (!sameBuffer(actual, expected)) diffs.push(`${relative} 内容与 node_modules 不一致`);
  }

  const manifestActual = readIfExists(MANIFEST_PATH);
  if (manifestActual === null) diffs.push('缺少 manifest.json');
  else {
    try {
      if (JSON.stringify(JSON.parse(manifestActual.toString('utf8'))) !== JSON.stringify(manifest)) {
        diffs.push('manifest.json 与期望清单不一致');
      }
    } catch {
      diffs.push('manifest.json 不是合法 JSON');
    }
  }

  const fontsDir = path.join(VENDOR_DIR, 'fonts');
  if (fs.existsSync(fontsDir)) {
    const expectedFonts = new Set(manifest.fonts.files.map((f) => f.name.replace(/^fonts\//, '')));
    for (const name of fs.readdirSync(fontsDir)) {
      if (name.endsWith('.woff2') && !expectedFonts.has(name)) diffs.push(`多余字体 fonts/${name}`);
    }
  }

  return diffs;
}

function writeIfChanged(file, buf) {
  const previous = readIfExists(file);
  if (sameBuffer(previous, buf)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return true;
}

function buildReadme(manifest) {
  const rows = Object.entries(manifest.libraries).map(([name, lib]) => {
    const targets = lib.files.map((f) => `\`${f.path}\``).join('<br>');
    return `| ${name} | ${lib.version} | ${lib.license} | \`${lib.package}\` | ${targets} |`;
  });
  const fontLines = manifest.fonts.files.map((f) => `- \`${f.name}\` (${f.bytes} B, sha256 ${f.sha256.slice(0, 12)}…)`);
  return [
    '# renderer/vendor',
    '',
    '> **由 `scripts/sync-vendor.mjs` 生成，禁止手改。** 来源只允许本地 `node_modules`，运行时不联网。',
    '',
    '## 库与版本',
    '',
    '| 库 | 版本 | 许可证 | 源包路径 | 同步产物 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `字体：KaTeX 自带 ${manifest.fonts.count} 个 woff2（合计 ${manifest.fonts.bytes} B），清单见 \`manifest.json\` 的 \`fonts\`。`,
    '',
    '<details><summary>字体文件</summary>',
    '',
    ...fontLines,
    '',
    '</details>',
    '',
    '## 同步与校验',
    '',
    '```powershell',
    'npm run sync-vendor                     # 从 node_modules 同步并重写 manifest / README',
    'node scripts/sync-vendor.mjs --check    # 只校验；build 前自动执行，漂移即失败',
    '```',
    '',
    '版本在 `package.json` 的 `devDependencies` 中固定为精确版本；`sync-vendor` 会同时核对',
    'package.json、node_modules 包版本、产物内版本标记三者，任一不一致直接报错。',
    '',
    '## 生成时间 / 哈希策略',
    '',
    '- **不写生成时间戳**：同一 node_modules 重复同步得到字节一致的产物与清单，避免无意义 diff；',
    '  需要追溯时看 `manifest.json` 的版本组合与文件 sha256，或文件系统 mtime。',
    '- `manifest.json` 记录每个 JS / CSS / 字体文件的 `bytes` 与 `sha256`，以及字体集合 digest。',
    '- `scripts/build.mjs` 先执行 `--check`；通过后把 `marked.min.js`、`dompurify.min.js`、`katex.min.js`',
    '  按固定顺序拼进 `renderer/dist/app.<hash>.js` 的前导。**vendor 内容变化必然改变入口 hash**，',
    '  不依赖 `?v=N` 手工版本号。',
    '- `katex.min.css` 与 `fonts/*.woff2` 仍外链（路径相对 CSS），内容由 manifest 校验；',
    '  若升级 KaTeX，CSS/字体随同步更新，入口 hash 也会因 katex.min.js 变化。',
    '',
    '## 运行时取用',
    '',
    '- 现代入口：bundle 前导在 classic script 顶层执行三个 UMD 库，`window.marked / DOMPurify / katex`',
    '  在应用 IIFE 之前就绪；`renderer/ui/rich-text.js` 继续走 marked → DOMPurify → KaTeX 管线。',
    '- KaTeX 输出里的 style 属性由 `renderer/ui/rich-text.js` 先转成 `data-vds-style`，插入 DOM 后',
    '  再用 CSSOM 回填；避免 `style-src \'self\'` 违规，也不放宽 CSP。',
    '- `?legacy=1`：同一入口已提供三个全局；万一缺失，`renderer/app.js` 的 legacy 分支会按',
    '  `marked → dompurify → katex` 动态加载本目录文件，再加载 `lib-boot.js → renderer.js → ai.js`。',
    '- CSP 仍为 `script-src \'self\'`；没有内联脚本，也不放宽 CSP。',
    '',
  ].join('\n');
}

export function syncVendor() {
  const { manifest, files } = expectedVendorState();
  const changed = [];

  for (const [relative, buf] of files) {
    if (writeIfChanged(path.join(VENDOR_DIR, relative), buf)) changed.push(relative);
  }

  // 清掉旧版本遗留的字体（只动 woff2，不碰 other 文件）
  const fontsDir = path.join(VENDOR_DIR, 'fonts');
  const expectedFonts = new Set(manifest.fonts.files.map((f) => f.name.replace(/^fonts\//, '')));
  if (fs.existsSync(fontsDir)) {
    for (const name of fs.readdirSync(fontsDir)) {
      if (name.endsWith('.woff2') && !expectedFonts.has(name)) {
        fs.rmSync(path.join(fontsDir, name), { force: true });
        changed.push(`删除 fonts/${name}`);
      }
    }
  }

  if (writeIfChanged(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))) {
    changed.push('manifest.json');
  }
  if (writeIfChanged(README_PATH, Buffer.from(buildReadme(manifest), 'utf8'))) {
    changed.push('README.md');
  }

  return { manifest, changed };
}

function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const diffs = checkVendor();
    if (diffs.length) {
      console.error('vendor 校验失败：');
      for (const diff of diffs.slice(0, 30)) console.error(`  - ${diff}`);
      console.error('请运行 npm run sync-vendor 后重试。');
      process.exit(1);
    }
    const { manifest } = expectedVendorState();
    const versions = Object.entries(manifest.libraries)
      .map(([name, lib]) => `${name}@${lib.version}`)
      .join(' / ');
    console.log(`vendor 校验通过：${versions}；字体 ${manifest.fonts.count} 个`);
    return;
  }

  const { manifest, changed } = syncVendor();
  const versions = Object.entries(manifest.libraries)
    .map(([name, lib]) => `${name}@${lib.version}`)
    .join(' / ');
  console.log(`vendor 已同步（${versions}；字体 ${manifest.fonts.count} 个）`);
  console.log(changed.length ? `变更：${changed.join(', ')}` : '无变更（字节一致）');
}

const isMain = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`sync-vendor 失败：${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}
