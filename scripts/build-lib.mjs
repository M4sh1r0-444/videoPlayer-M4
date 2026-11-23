/**
 * 构建的纯函数（P4）：内容哈希、index.html 入口注入、单入口断言。
 * 单独成文件是为了用 node --test 直接测，不需要跑 esbuild。
 */

import crypto from 'node:crypto';

export const ENTRY_START = '<!-- build:entry:start -->';
export const ENTRY_END = '<!-- build:entry:end -->';
export const HASH_LENGTH = 10;

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 内容哈希取前 10 位十六进制；同一内容永远同一结果 */
export function shortHash(input) {
  return sha256(input).slice(0, HASH_LENGTH);
}

/** app.<hash>.js → hash；不匹配返回 null（供测试/清理使用） */
export function hashOfEntryName(name) {
  const match = /^app\.([0-9a-f]{10})\.js$/.exec(String(name));
  return match ? match[1] : null;
}

/**
 * 把 index.html 的 build:entry 标记块替换成唯一入口脚本。
 * 幂等：重复注入同一路径得到同一结果。标记缺失/重复时抛错，避免静默生成坏页面。
 */
export function injectEntry(html, scriptPath) {
  const source = String(html);
  const start = source.indexOf(ENTRY_START);
  const end = source.indexOf(ENTRY_END, start < 0 ? 0 : start);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`index.html 缺少入口标记 ${ENTRY_START} / ${ENTRY_END}`);
  }
  if (source.indexOf(ENTRY_START, start + ENTRY_START.length) >= 0) {
    throw new Error('index.html 入口标记重复');
  }
  if (!/^dist\/app\.[0-9a-f]{10}\.js$/.test(scriptPath)) {
    throw new Error(`入口路径不合法：${scriptPath}`);
  }
  const block = `${ENTRY_START}\n  <script src="${scriptPath}"></script>\n  ${ENTRY_END}`;
  return source.slice(0, start) + block + source.slice(end + ENTRY_END.length);
}

/** 取 index.html 中所有外链脚本（保持出现顺序） */
export function entryScripts(html) {
  return [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
}

/**
 * 现代入口必须是唯一的应用脚本，且路径为 dist/app.<hash>.js。
 * 返回该路径；不满足时抛错。
 */
export function assertSingleEntry(html) {
  const scripts = entryScripts(html);
  if (scripts.length !== 1) {
    throw new Error(`现代入口应只有 1 个脚本，实际 ${scripts.length} 个：${scripts.join(', ')}`);
  }
  if (!/^dist\/app\.[0-9a-f]{10}\.js$/.test(scripts[0])) {
    throw new Error(`现代入口不是内容哈希路径：${scripts[0]}`);
  }
  return scripts[0];
}

/**
 * 拼最终入口：固定 banner + vendor 前导（marked → DOMPurify → KaTeX）+ 应用 IIFE。
 * vendor 是 classic UMD，放在应用 IIFE 之前执行，window.marked / DOMPurify / katex 在应用启动前就绪。
 */
export function composeBundle({ vendorSources, appCode, versions }) {
  const banner = `/* 学习播放器 bundle · 由 scripts/build.mjs 生成，请勿手改；vendor: ${versions
    .map(([name, version]) => `${name} ${version}`)
    .join(' / ')} */\n`;
  const vendor = vendorSources.map((code) => `${String(code).trimEnd()}\n;`).join('\n');
  const source = `${banner}${vendor}\n${String(appCode).trimEnd()}\n`;
  const digest = sha256(Buffer.from(source, 'utf8'));
  return { source, sha256: digest, hash: digest.slice(0, HASH_LENGTH) };
}
