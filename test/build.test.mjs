import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_END,
  ENTRY_START,
  assertSingleEntry,
  composeBundle,
  entryScripts,
  hashOfEntryName,
  injectEntry,
  sha256,
  shortHash,
} from '../scripts/build-lib.mjs';
import { checkVendor } from '../scripts/sync-vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeHtml(inner = '') {
  return `<!doctype html>\n<html>\n<body>\n${ENTRY_START}\n${inner}${ENTRY_END}\n</body>\n</html>\n`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('sha256 / shortHash：同一内容稳定，长度 10', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(shortHash('abc'), 'ba7816bf8f');
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
  assert.equal(shortHash('abc').length, 10);
});

test('hashOfEntryName：只认 app.<10hex>.js', () => {
  assert.equal(hashOfEntryName('app.0123456789.js'), '0123456789');
  assert.equal(hashOfEntryName('app.abc.js'), null);
  assert.equal(hashOfEntryName('app.012345678g.js'), null);
  assert.equal(hashOfEntryName('app.0123456789.js.map'), null);
});

test('injectEntry：注入唯一脚本、保留周围内容、可重复执行', () => {
  const html = makeHtml('  <script src="dist/app.0000000000.js"></script>\n');
  const once = injectEntry(html, 'dist/app.0123456789.js');
  assert.match(once, /<script src="dist\/app\.0123456789\.js"><\/script>/);
  assert.equal((once.match(new RegExp(ENTRY_START, 'g')) || []).length, 1);
  assert.equal(injectEntry(once, 'dist/app.0123456789.js'), once);
  assert.ok(once.startsWith('<!doctype html>'));
  assert.ok(once.endsWith('</body>\n</html>\n'));
});

test('injectEntry：标记缺失 / 重复 / 非法路径都报错', () => {
  assert.throws(() => injectEntry('<html></html>', 'dist/app.0123456789.js'), /缺少入口标记/);
  const dup = `${ENTRY_START}${ENTRY_END}${ENTRY_START}${ENTRY_END}`;
  assert.throws(() => injectEntry(dup, 'dist/app.0123456789.js'), /入口标记重复/);
  assert.throws(() => injectEntry(makeHtml(), 'app.js'), /入口路径不合法/);
});

test('entryScripts / assertSingleEntry：只允许 1 个哈希入口', () => {
  assert.deepEqual(entryScripts(makeHtml('<script src="dist/app.0123456789.js"></script>')), ['dist/app.0123456789.js']);
  assert.equal(assertSingleEntry(`<script src="dist/app.0123456789.js"></script>`), 'dist/app.0123456789.js');
  assert.throws(() => assertSingleEntry('<p>no script</p>'), /只有 1 个脚本/);
  assert.throws(
    () => assertSingleEntry('<script src="dist/app.0123456789.js"></script><script src="app.js"></script>'),
    /只有 1 个脚本/,
  );
  assert.throws(() => assertSingleEntry('<script src="dist/app.js"></script>'), /不是内容哈希路径/);
});

test('composeBundle：vendor 前导顺序固定，hash 只随内容变化', () => {
  const vendorSources = ['/* marked */window.marked={};', '/* purify */window.DOMPurify={};', '/* katex */window.katex={};'];
  const versions = [['marked', '18.0.14'], ['dompurify', '3.4.15'], ['katex', '0.16.47']];
  const a = composeBundle({ vendorSources, appCode: 'console.log("app")', versions });
  const b = composeBundle({ vendorSources: vendorSources.slice(), appCode: 'console.log("app")', versions });
  assert.equal(a.hash, b.hash);
  const markedAt = a.source.indexOf('marked');
  const purifyAt = a.source.indexOf('purify');
  const katexAt = a.source.indexOf('katex');
  const appAt = a.source.indexOf('console.log("app")');
  assert.ok(markedAt > 0 && markedAt < purifyAt && purifyAt < katexAt && katexAt < appAt);
  const changed = composeBundle({ vendorSources, appCode: 'console.log("app2")', versions });
  assert.notEqual(a.hash, changed.hash);
  assert.equal(a.hash.length, 10);
});

test('仓库构建产物：index.html 单入口、文件存在、build-info 一致', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const entry = assertSingleEntry(html);
  const entryFile = path.join(ROOT, 'renderer', entry);
  assert.ok(fs.existsSync(entryFile), `缺少 ${entry}`);
  assert.ok(!/src="[^"]*\?v=/.test(html), 'index.html 不应再有 ?v=N');
  assert.equal(entryScripts(html).length, 1);

  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'dist', 'build-info.json'), 'utf8'));
  assert.equal(info.entry, entry);
  assert.equal(info.bytes, fs.statSync(entryFile).size);
  assert.equal(info.sha256, sha256File(entryFile));
  assert.ok(info.sha256.startsWith(hashOfEntryName(path.basename(entry))));
});

test('仓库构建产物：CSP 未放宽、无内联脚本', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(csp, 'index.html 应有 CSP meta');
  assert.ok(csp[1].includes("script-src 'self'"));
  assert.ok(!csp[1].includes('unsafe-inline'));
  assert.ok(!csp[1].includes('unsafe-eval'));
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  for (const [, attrs] of scripts) assert.match(attrs, /\bsrc=/, '不允许内联 <script>');
});

test('仓库构建产物：vendor manifest 与 package.json 固定版本一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'vendor', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.libraries).sort(), ['dompurify', 'katex', 'marked']);
  for (const [name, lib] of Object.entries(manifest.libraries)) {
    assert.equal(pkg.devDependencies[name], lib.version, name);
    assert.ok(lib.license, `${name} 缺少许可证`);
    for (const file of lib.files) {
      const full = path.join(ROOT, 'renderer', 'vendor', file.path);
      assert.equal(file.bytes, fs.statSync(full).size);
      assert.equal(file.sha256, sha256File(full));
    }
  }
  assert.equal(manifest.fonts.count, 20);
  assert.deepEqual(checkVendor(), []);
});
