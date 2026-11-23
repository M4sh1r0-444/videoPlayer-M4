/**
 * 讲义 ↔ 分集匹配（纯函数）
 *
 * 规则：
 * 1. 手动绑定（docBinds）优先，越界自动失效；
 * 2. 否则从文件名提取候选编号（阿拉伯数字 + 中文「第X讲/集/课」）；
 * 3. 候选编号命中**唯一**分集的末位编号 → 挂到该集，否则视为课程级资料。
 */
import { episodeKey } from './episode.js';

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_NUM_RE = /^([一二三四五六七八九]?)(十)?([一二三四五六七八九]?)$/;
const DOC_CN_RE = /第([一二三四五六七八九十]{1,3})[讲集课]/g;

/** 「十」「二十一」「三」→ 数字；非规范写法返回 null */
export function cnToInt(s) {
  const m = CN_NUM_RE.exec(String(s || ''));
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  if (m[1] && !m[2] && m[3]) return null; // 如「一三」
  if (m[1] && !m[2] && !m[3]) return CN_DIGITS[m[1]];
  const tens = m[2] ? (m[1] ? CN_DIGITS[m[1]] : 1) : 0;
  return tens * 10 + (m[3] ? CN_DIGITS[m[3]] : 0);
}

/** 从讲义文件名提取候选集号（阿拉伯数字 + 中文数字） */
export function docNumbers(name) {
  const nums = (String(name || '').match(/\d+/g) || []).map((x) => parseInt(x, 10));
  const re = new RegExp(DOC_CN_RE.source, 'g');
  let m;
  while ((m = re.exec(String(name || '')))) {
    const n = cnToInt(m[1]);
    if (n != null && n > 0) nums.push(n);
  }
  return nums;
}

/**
 * 就地重算课程的讲义关联（写入 doc.episodeIndex）。
 * @param {{episodes: any[], docs: any[]}} course
 * @param {Record<string, number>} [binds] 讲义路径 → 分集下标
 */
export function matchDocs(course, binds) {
  const episodes = course?.episodes || [];
  const docs = course?.docs || [];
  for (const doc of docs) {
    const bind = binds ? binds[doc.path] : undefined;
    if (Number.isInteger(bind) && bind >= 0 && bind < episodes.length) {
      doc.episodeIndex = bind;
      continue;
    }
    const nums = docNumbers(doc.name);
    const hits = episodes.filter((ep) => {
      const k = episodeKey(ep);
      if (!k?.parts?.length) return false;
      return nums.includes(k.parts[k.parts.length - 1]);
    });
    doc.episodeIndex = hits.length === 1 ? episodes.indexOf(hits[0]) : null;
  }
  return docs;
}
