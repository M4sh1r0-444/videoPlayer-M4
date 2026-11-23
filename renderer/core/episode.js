/**
 * 分集：文件名解析、排序、对象构造（纯函数，主进程与渲染层共享）。
 *
 * 约束：不得出现 DOM / Electron / Node API —— main.js 会直接 import 本模块。
 *
 * 兼容两种历史字段：
 *   - 扫描结果（旧 main.js）用 `key`
 *   - 渲染层构造（renderer.makeEpisode）用 `k`
 * 新代码统一用 `k`；`episodeKey()` 同时接受两者，避免两套解析再次分叉。
 */

export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'm4v', 'ogv', 'ogg', 'mov', 'mkv', 'flv', 'ts', 'avi', 'wmv', 'rmvb', 'mpg', 'mpeg', '3gp'];
export const PLAYABLE_EXTENSIONS = ['mp4', 'webm', 'm4v', 'ogv', 'ogg', 'mov'];
export const DOC_EXTENSIONS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'jpg', 'jpeg', 'png'];

export const VIDEO_EXT_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i');
export const PLAYABLE_EXT_RE = new RegExp(`\\.(${PLAYABLE_EXTENSIONS.join('|')})$`, 'i');
export const DOC_EXT_RE = new RegExp(`\\.(${DOC_EXTENSIONS.join('|')})$`, 'i');

const BARE_NAME_RE = /^\[([\d.]+)\]/;
const TITLE_PREFIX_RE = /^\[[\d.]+\](--+|－|—|\s+)?/;
const ANY_EXT_RE = /\.[^.]+$/;

export const isVideoFile = (name) => VIDEO_EXT_RE.test(String(name || ''));
export const isPlayableFile = (name) => PLAYABLE_EXT_RE.test(String(name || ''));
export const isDocFile = (name) => DOC_EXT_RE.test(String(name || ''));

/** 路径末段（两种分隔符都吃，避免平台差异） */
export function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop();
}

/**
 * 中国大学 MOOC 命名：「[1.2.10]--高数1-4-1 xxx.mp4」→ { parts:[1,2,10], bracket:true }
 * 无方括号编号 → { parts:null, bracket:false }
 */
export function parseEpisodeKey(filename) {
  const m = BARE_NAME_RE.exec(String(filename || ''));
  if (m) {
    const parts = m[1].split('.').map((s) => parseInt(s, 10));
    if (parts.every((n) => Number.isFinite(n))) return { parts, bracket: true };
  }
  return { parts: null, bracket: false };
}

/** 显示名：去掉「[1.2.10]--」前缀与扩展名 */
export function displayTitle(filename) {
  return String(filename || '').replace(TITLE_PREFIX_RE, '').replace(ANY_EXT_RE, '');
}

/** 读取分集编号（兼容 k / key 两种历史字段） */
export function episodeKey(ep) {
  return ep?.k ?? ep?.key ?? null;
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 就地排序：方括号编号优先（逐段数值比较），无编号走中文自然序 */
export function sortEpisodes(list) {
  return list.sort((a, b) => {
    const ka = episodeKey(a);
    const kb = episodeKey(b);
    if (ka?.parts && kb?.parts) {
      const len = Math.max(ka.parts.length, kb.parts.length);
      for (let i = 0; i < len; i++) {
        const d = (ka.parts[i] ?? -1) - (kb.parts[i] ?? -1);
        if (d !== 0) return d;
      }
      return 0;
    }
    if (ka?.parts) return -1;
    if (kb?.parts) return 1;
    return collator.compare(a.filename, b.filename);
  });
}

/** 文件路径 → 分集对象（字段与旧渲染层一致，另保留 bracket 标记） */
export function makeEpisode(filePath) {
  const filename = baseName(filePath);
  return {
    path: filePath,
    filename,
    title: displayTitle(filename),
    k: parseEpisodeKey(filename),
    playable: isPlayableFile(filename),
  };
}
